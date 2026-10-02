import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server';
import type { Db } from '../src/db';
import {
  seedConsultant, seedProject, seedTemplate, seedThread, seedUser, testConfig, testDb, tmpRoots,
  uploadSkillsZip, waitFor, type ConsultantFields,
} from './helpers';
import {
  emptyTurn, errorAfterTextTurn, failingModel, hangingModel, mockModel, promptText, textTurn, toolTurn,
} from './mock-model';
import type { LanguageModel } from 'ai';

const db = testDb();

async function seedEnv(fields: ConsultantFields = {}) {
  const creatorId = await seedUser(db);
  const ownerId = await seedUser(db);
  const templateId = await seedTemplate(db, creatorId);
  const projectId = await seedProject(db, ownerId);
  const threadId = await seedThread(db, projectId);
  const consultantId = await seedConsultant(db, projectId, { template_id: templateId, ...fields });
  const roots = await tmpRoots();
  return { creatorId, templateId, projectId, threadId, consultantId, roots, config: testConfig(projectId, roots) };
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForRunDone(db: Db, threadId: string) {
  return waitFor(async () => {
    const { data } = await db.from('runs').select('*').eq('thread_id', threadId).neq('status', 'running')
      .order('started_at', { ascending: false }).limit(1);
    return data?.[0];
  });
}

async function messagesOf(threadId: string) {
  const { data } = await db.from('messages').select('*').eq('thread_id', threadId).order('created_at');
  return data!;
}

function app(env: Awaited<ReturnType<typeof seedEnv>>, model: LanguageModel, runTimeoutMs?: number) {
  return createApp({ db, model, config: env.config, runTimeoutMs });
}

describe('GET /health', () => {
  it('回傳專案 id', async () => {
    const env = await seedEnv();
    const res = await app(env, mockModel()).request('/health');
    expect(await res.json()).toEqual({ ok: true, project_id: env.projectId });
  });
});

describe('POST /chat', () => {
  it('單一顧問：串流回覆，寫入 user、final、run、usage', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('你好，我是法務顧問'))), { thread_id: env.threadId, text: '請問合約風險' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('你好，我是法務顧問');

    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');
    const msgs = await messagesOf(env.threadId);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'final']);
    expect(msgs[0]).toMatchObject({ content: '請問合約風險', speaker_instance_id: null });
    expect(msgs[1]).toMatchObject({ content: '你好，我是法務顧問', speaker_instance_id: env.consultantId });
    expect(msgs[1].ui_message.role).toBe('assistant');

    const usageRows = await waitFor(async () => {
      const { data } = await db.from('usage_events').select('*').eq('run_id', run.id);
      return data?.length ? data : undefined;
    });
    expect(usageRows[0]).toMatchObject({
      project_id: env.projectId, instance_id: env.consultantId, template_id: env.templateId, creator_id: env.creatorId,
      prompt_tokens: 10, output_tokens: 5, cached_tokens: 2, thought_tokens: 1,
    });
  });

  it('執行工具：寫檔成功，final 的 tool_events 有紀錄', async () => {
    const env = await seedEnv();
    const model = mockModel(toolTurn('write_file', { path: 'memo.md', content: '重點' }), textTurn('寫好了'));
    await (await post(app(env, model), { thread_id: env.threadId, text: '幫我記重點' })).text();
    await waitForRunDone(db, env.threadId);
    await expect(stat(path.join(env.roots.agentsRoot, env.consultantId, 'memo.md'))).resolves.toBeTruthy();
    const final = (await messagesOf(env.threadId)).find((m) => m.kind === 'final');
    expect(final.content).toBe('寫好了');
    expect(final.tool_events).toEqual([{ tool: 'write_file', state: 'output-available' }]);
  });

  it('第二次對話帶入之前的問答', async () => {
    const env = await seedEnv();
    const model = mockModel(textTurn('第一個回答'), textTurn('第二個回答'));
    const a = app(env, model);
    await (await post(a, { thread_id: env.threadId, text: '第一個問題' })).text();
    await waitForRunDone(db, env.threadId);
    await (await post(a, { thread_id: env.threadId, text: '第二個問題' })).text();
    await waitFor(async () => ((await messagesOf(env.threadId)).length === 4 ? true : undefined));
    await waitFor(async () => {
      const { data } = await db.from('runs').select('id').eq('thread_id', env.threadId).eq('status', 'running');
      return data?.length === 0 ? true : undefined;
    });
    const prompt = promptText(model, 1);
    expect(prompt).toContain('第一個問題');
    expect(prompt).toContain('第一個回答');
    expect(prompt).toContain('第二個問題');
  });

  it('skills 會同步到工作目錄，prompt 帶出 SKILL.md 路徑', async () => {
    const zipPath = await uploadSkillsZip(db, { 'contract/SKILL.md': '# 審合約' });
    const env = await seedEnv({ skills_zip_path: zipPath, skills: [{ name: '審合約', description: '檢查風險', path: 'contract' }] });
    const model = mockModel(textTurn('好'));
    await (await post(app(env, model), { thread_id: env.threadId, text: '看合約' })).text();
    await waitForRunDone(db, env.threadId);
    const skillFile = path.join(env.roots.agentsRoot, env.consultantId, 'skills', 'contract', 'SKILL.md');
    await expect(stat(skillFile)).resolves.toBeTruthy();
    expect(promptText(model)).toContain(skillFile);
  });

  it('瀏覽器中途斷線，run 仍會跑完並寫入 final', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('這是一段比較長的回答', 30))), { thread_id: env.threadId, text: '問題' });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');
    const final = (await messagesOf(env.threadId)).find((m) => m.kind === 'final');
    expect(final.content).toBe('這是一段比較長的回答');
  });

  it('模型出錯：run 標成 failed 並保留錯誤訊息', async () => {
    const env = await seedEnv();
    const res = await post(app(env, failingModel('模型掛了')), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(200);
    await res.text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('模型掛了');
  });

  it('模型串流中途出錯：run 標成 failed，已產生的內容仍存成 final', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel(errorAfterTextTurn('已經寫了一半', '中途壞掉'))), { thread_id: env.threadId, text: '問題' });
    await res.text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('中途壞掉');
    const final = (await messagesOf(env.threadId)).find((m) => m.kind === 'final');
    expect(final.content).toBe('已經寫了一半');
  });

  it('模型沒有產生任何內容：run 標成 failed，不寫 final', async () => {
    const env = await seedEnv();
    await (await post(app(env, mockModel(emptyTurn())), { thread_id: env.threadId, text: '問題' })).text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run).toMatchObject({ status: 'failed', error: '模型沒有產生回覆' });
    expect((await messagesOf(env.threadId)).map((m) => m.kind)).toEqual(['user']);
  });

  it('模型卡住不回應：超過時間上限後 run 標成 failed，回應串流也會結束', async () => {
    const env = await seedEnv();
    const start = Date.now();
    const res = await post(app(env, hangingModel(), 300), { thread_id: env.threadId, text: '問題' });
    await res.text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run).toMatchObject({ status: 'failed', error: 'run 超過 15 分鐘' });
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('超過時間上限而中止：錯誤訊息是逾時，不是一般中止', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('一段要講很久很久很久的回答'.repeat(3), 100)), 300), { thread_id: env.threadId, text: '問題' });
    await res.text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run).toMatchObject({ status: 'failed', error: 'run 超過 15 分鐘' });
  });

  it('MCP 啟動失敗不影響 run，prompt 告知 agent，前端收到警告', async () => {
    const env = await seedEnv({ mcp_servers: [{ name: 'broken', transport: 'stdio', command: '/nonexistent/cmd' }] });
    const model = mockModel(textTurn('照常回答'));
    const body = await (await post(app(env, model), { thread_id: env.threadId, text: '問題' })).text();
    expect(body).toContain('"type":"data-warning"');
    expect(body).toContain('MCP「broken」目前無法使用');
    expect((await waitForRunDone(db, env.threadId)).status).toBe('succeeded');
    expect(promptText(model)).toContain('目前無法使用');

    const final = (await messagesOf(env.threadId)).find((m) => m.kind === 'final');
    expect(final.content).toBe('照常回答');
    expect(final.ui_message.role).toBe('assistant');
    const warning = final.ui_message.parts.find((p: { type: string }) => p.type === 'data-warning');
    expect(warning.data.text).toContain('MCP「broken」目前無法使用');
  });

  it('只有 MCP 警告、模型沒有產生內容：仍標成失敗', async () => {
    const env = await seedEnv({ mcp_servers: [{ name: 'broken', transport: 'stdio', command: '/nonexistent/cmd' }] });
    await (await post(app(env, mockModel(emptyTurn())), { thread_id: env.threadId, text: '問題' })).text();
    expect(await waitForRunDone(db, env.threadId)).toMatchObject({ status: 'failed', error: '模型沒有產生回覆' });
  });

  it('同一串對話已有 run 在跑：回 409', async () => {
    const env = await seedEnv();
    await db.from('runs').insert({ thread_id: env.threadId });
    const res = await post(app(env, mockModel(textTurn('x'))), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(409);
  });

  it('對話不屬於這個專案：回 404', async () => {
    const env = await seedEnv();
    const other = await seedEnv();
    const res = await post(app(env, mockModel(textTurn('x'))), { thread_id: other.threadId, text: '問題' });
    expect(res.status).toBe(404);
  });

  it('body 格式錯誤：回 400', async () => {
    const env = await seedEnv();
    const res = await post(app(env, mockModel()), { thread_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('專案沒有顧問：回 500，run 標成 failed', async () => {
    const env = await seedEnv();
    await db.from('agent_instances').delete().eq('project_id', env.projectId);
    const res = await post(app(env, mockModel()), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(500);
    const run = await waitForRunDone(db, env.threadId);
    expect(run).toMatchObject({ status: 'failed', error: '專案裡還沒有任何顧問' });
  });
});

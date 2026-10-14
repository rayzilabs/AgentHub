import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server';
import {
  runtimeDb, runtimeToken, seedConsultant, seedProject, seedTemplate, seedThread, seedUser, testConfig, testDb, tmpRoots,
  uploadSkillsZip, waitFor,
} from './helpers';
import { mockModel, textTurn, toolTurn } from './mock-model';

// 用真的 runtime 帳號通行證跑完整對話：runtime 的每一個查詢都必須通過 RLS 與欄位權限
const db = testDb();

async function seed() {
  const creatorId = await seedUser(db);
  const ownerId = await seedUser(db);
  const templateId = await seedTemplate(db, creatorId);
  const projectId = await seedProject(db, ownerId);
  const threadId = await seedThread(db, projectId);
  const zipPath = await uploadSkillsZip(db, { 'contract/SKILL.md': '# 審合約' });
  const consultantId = await seedConsultant(db, projectId, {
    template_id: templateId, skills_zip_path: zipPath, skills: [{ name: '審合約', description: '檢查風險', path: 'contract' }],
  });
  const { error } = await db.storage.from('project-files').upload(`${projectId}/notes.txt`, Buffer.from('專案筆記'), { contentType: 'text/plain' });
  if (error) throw error;
  const roots = await tmpRoots();
  return { projectId, threadId, consultantId, creatorId, roots, config: testConfig(projectId, roots) };
}

function post(app: ReturnType<typeof createApp>, threadId: string, dbToken: string) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agenthub-db-token': dbToken, 'x-agenthub-token': 'pt' },
    body: JSON.stringify({ thread_id: threadId, text: '請記住重點' }),
  });
}

describe('以 runtime 帳號通行證執行', () => {
  it('完整對話：讀顧問、同步 skill 與專案檔案、寫訊息、記憶與用量都通過權限', async () => {
    const env = await seed();
    const token = await runtimeToken(db, env.projectId);
    const app = createApp({
      openDb: runtimeDb,
      modelFor: () => mockModel(toolTurn('remember', { content: '客戶偏好保守', scope: 'project' }), textTurn('已記住')),
      config: env.config,
    });
    const res = await post(app, env.threadId, token);
    expect(res.status).toBe(200);
    await res.text();

    const run = await waitFor(async () => {
      const { data } = await db.from('runs').select('status, error').eq('thread_id', env.threadId).neq('status', 'running');
      return data?.[0];
    });
    expect(run).toEqual({ status: 'succeeded', error: null });

    const { data: msgs } = await db.from('messages').select('kind, content').eq('thread_id', env.threadId).order('created_at');
    expect(msgs!.map((m) => m.kind)).toEqual(['user', 'final']);
    expect(msgs![1].content).toBe('已記住');

    const { data: memories } = await db.from('memories').select('content, instance_id').eq('project_id', env.projectId);
    expect(memories).toEqual([{ content: '客戶偏好保守', instance_id: null }]);

    const { data: usage } = await db.from('usage_events').select('creator_id').eq('project_id', env.projectId);
    expect(usage!.length).toBeGreaterThan(0);
    expect(usage![0].creator_id).toBe(env.creatorId);

    await expect(stat(path.join(path.dirname(env.roots.agentsRoot), 'skills', env.consultantId, 'contract', 'SKILL.md'))).resolves.toBeTruthy();
    expect(await readFile(path.join(env.roots.sharedRoot, 'notes.txt'), 'utf8')).toBe('專案筆記');
  });

  it('別的專案的 runtime 通行證碰不到這串對話', async () => {
    const env = await seed();
    const other = await seed();
    const otherToken = await runtimeToken(db, other.projectId);
    const app = createApp({ openDb: runtimeDb, modelFor: () => mockModel(textTurn('x')), config: env.config });
    const res = await post(app, env.threadId, otherToken);
    expect(res.status).toBe(404);
  });
});

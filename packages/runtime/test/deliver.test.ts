import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { createSandbox } from '../src/sandbox';
import { deliverFileTool, FILE_LIMIT_BYTES, RUN_DELIVERY_LIMIT_BYTES } from '../src/tools/deliver';
import { runtimeDb, runtimeToken, seedConsultant, seedProject, seedThread, seedUser, testDb, tmpRoots } from './helpers';

const opts = { toolCallId: 't', messages: [] } as never;
const NAME = '財務顧問';

type Env = { db: Db; admin: Db; projectId: string; instanceId: string; runId: string; dir: string };

async function setup(): Promise<Env> {
  const admin = testDb();
  const projectId = await seedProject(admin, await seedUser(admin));
  const instanceId = await seedConsultant(admin, projectId, { name: NAME });
  const threadId = await seedThread(admin, projectId);
  const { data, error } = await admin.from('runs').insert({ thread_id: threadId }).select('id').single();
  if (error) throw error;
  const { agentsRoot } = await tmpRoots();
  const dir = path.join(agentsRoot, instanceId);
  await mkdir(dir, { recursive: true });
  return { db: runtimeDb(await runtimeToken(admin, projectId)), admin, projectId, instanceId, runId: data.id, dir };
}

function tool(env: Env, extra: { budget?: { used: number }; limits?: { file: number; run: number } } = {}) {
  return deliverFileTool({
    cwd: env.dir, sandbox: createSandbox(), db: env.db, projectId: env.projectId,
    instanceId: env.instanceId, runId: env.runId, budget: extra.budget ?? { used: 0 }, limits: extra.limits,
  });
}

const run = (t: ReturnType<typeof tool>, input: { path: string; folder?: string; name?: string }) =>
  Promise.resolve(t.execute!(input, opts)) as Promise<Record<string, unknown>>;

const storageCount = async (env: Env) => {
  const { data } = await env.admin.storage.from('project-files').list(`${env.projectId}/files`);
  return data?.length ?? 0;
};

describe('deliver_file', () => {
  let env: Env;
  beforeAll(async () => { env = await setup(); });

  it('預設上限是 50 MB / 200 MB', () => {
    expect(FILE_LIMIT_BYTES).toBe(50 * 1024 * 1024);
    expect(RUN_DELIVERY_LIMIT_BYTES).toBe(200 * 1024 * 1024);
  });

  it('交付後回傳檔案資訊、storage 與資料表都有', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'report.docx'), 'hello docx');
    const out = await run(tool(e), { path: 'report.docx', folder: '2026-W43' });
    expect(out).toMatchObject({ name: 'report.docx', folder: `${NAME}/2026-W43`, size: 10 });
    expect(typeof out.file_id).toBe('string');
    const { data } = await e.admin.from('project_files').select('source, run_id, agent_instance_id, content_type').eq('id', out.file_id as string).single();
    expect(data).toMatchObject({ source: 'agent', run_id: e.runId, agent_instance_id: e.instanceId });
    const dl = await e.admin.storage.from('project-files').download(`${e.projectId}/files/${out.file_id}`);
    expect(await dl.data!.text()).toBe('hello docx');
  });

  it('folder 前後的 / 會修掉；只有 / 表示放在顧問資料夾根目錄', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'a.txt'), 'a');
    expect(await run(tool(e), { path: 'a.txt', folder: '/x/y/' })).toMatchObject({ folder: `${NAME}/x/y` });
    expect(await run(tool(e), { path: 'a.txt', folder: '/' })).toMatchObject({ folder: NAME });
  });

  it('name 參數改變顯示檔名', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'out.docx'), 'x');
    const out = await run(tool(e), { path: 'out.docx', name: '台灣ETF淨流量週報_W43.docx' });
    expect(out.name).toBe('台灣ETF淨流量週報_W43.docx');
  });

  it('不合法的檔名或資料夾回友善錯誤', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'a.txt'), 'a');
    expect(await run(tool(e), { path: 'a.txt', name: 'a/b.txt' })).toEqual({ error: expect.stringContaining('檔名') });
    expect(await run(tool(e), { path: 'a.txt', name: 'x'.repeat(101) })).toEqual({ error: expect.stringContaining('檔名') });
    expect(await run(tool(e), { path: 'a.txt', folder: 'a//b' })).toEqual({ error: expect.stringContaining('資料夾') });
    expect(await run(tool(e), { path: 'a.txt', folder: 'ok/..' })).toEqual({ error: expect.stringContaining('資料夾') });
    // 預設檔名（原檔名）超過 100 字也一樣
    await writeFile(path.join(e.dir, `${'y'.repeat(101)}.txt`), 'a');
    expect(await run(tool(e), { path: `${'y'.repeat(101)}.txt` })).toEqual({ error: expect.stringContaining('檔名') });
    // 名稱不合法就不上傳，storage 不會留下殘留物件
    expect(await storageCount(e)).toBe(0);
  });

  it('symlink 指向超過上限的檔案：依指向的檔案大小拒絕，不上傳', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'big.bin'), '12345678901');
    try {
      await symlink(path.join(e.dir, 'big.bin'), path.join(e.dir, 'link.bin'));
    } catch {
      return; // 這個環境不能建 symlink（Windows 沒有權限）
    }
    const out = await run(tool(e, { limits: { file: 10, run: 1000 } }), { path: 'link.bin' });
    expect(out).toEqual({ error: '檔案超過 50 MB，無法交付' });
    expect(await storageCount(e)).toBe(0);
  });

  it('超過單檔上限就拒絕，storage 沒有新物件', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'big.bin'), '12345678901');
    const out = await run(tool(e, { limits: { file: 10, run: 1000 } }), { path: 'big.bin' });
    expect(out).toEqual({ error: '檔案超過 50 MB，無法交付' });
    expect(await storageCount(e)).toBe(0);
  });

  it('同一次 run 合計超過上限就拒絕；失敗的交付不佔額度', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'a.bin'), '0123456789');
    await writeFile(path.join(e.dir, 'b.bin'), '0123456789');
    const budget = { used: 0 };
    const t = tool(e, { budget, limits: { file: 100, run: 15 } });
    expect(await run(t, { path: 'a.bin' })).toMatchObject({ size: 10 });
    expect(budget.used).toBe(10);
    expect(await run(t, { path: 'b.bin' })).toEqual({ error: '這次回覆交付的檔案合計超過 200 MB' });
    expect(budget.used).toBe(10);
    expect(await run(t, { path: 'nope.bin' })).toHaveProperty('error');
    expect(budget.used).toBe(10);
  });

  it('讀不到的檔案交不出去', async () => {
    const e = await setup();
    expect(await run(tool(e), { path: 'missing.docx' })).toHaveProperty('error');
    await mkdir(path.join(e.dir, 'adir'));
    expect(await run(tool(e), { path: 'adir' })).toHaveProperty('error');
    expect(await storageCount(e)).toBe(0);
  });

  it('同名檔案自動編號，不覆蓋', async () => {
    const e = await setup();
    await writeFile(path.join(e.dir, 'r.pdf'), 'v1');
    const a = await run(tool(e), { path: 'r.pdf' });
    const b = await run(tool(e), { path: 'r.pdf' });
    expect(a.name).toBe('r.pdf');
    expect(b.name).not.toBe('r.pdf');
  });
});

import { describe, expect, it } from 'vitest';
import { formatMemoryBlock, loadMemories, memoryTools } from '../src/tools/memory';
import { seedConsultant, seedProject, seedUser, testDb } from './helpers';

const db = testDb();
// 工具執行選項：測試只用得到這兩個欄位
const opts = { toolCallId: 't', messages: [] } as never;

async function setup() {
  const projectId = await seedProject(db, await seedUser(db));
  const a = await seedConsultant(db, projectId, { name: 'A' });
  const b = await seedConsultant(db, projectId, { name: 'B' });
  return { projectId, a, b };
}

describe('記憶', () => {
  it('remember 依 scope 寫入；loadMemories 看得到自己的私有與專案共用，看不到別人的私有', async () => {
    const { projectId, a, b } = await setup();
    await memoryTools(db, projectId, a).remember.execute!({ content: 'A 的私事', scope: 'private' }, opts);
    await memoryTools(db, projectId, a).remember.execute!({ content: '客戶偏好保守', scope: 'project' }, opts);
    await memoryTools(db, projectId, b).remember.execute!({ content: 'B 的私事', scope: 'private' }, opts);

    const seenByA = (await loadMemories(db, projectId, a)).map((m) => m.content).sort();
    expect(seenByA).toEqual(['A 的私事', '客戶偏好保守']);
    const seenByB = (await loadMemories(db, projectId, b)).map((m) => m.content).sort();
    expect(seenByB).toEqual(['B 的私事', '客戶偏好保守']);
  });

  it('recall 用關鍵字搜尋，% 與 _ 當一般字元', async () => {
    const { projectId, a } = await setup();
    const tools = memoryTools(db, projectId, a);
    await tools.remember.execute!({ content: '毛利率目標 40%', scope: 'project' }, opts);
    await tools.remember.execute!({ content: '毛利率目標四成', scope: 'project' }, opts);

    const r = (await tools.recall.execute!({ query: '40%' }, opts)) as unknown as { results: { content: string }[] };
    expect(r.results.map((m) => m.content)).toEqual(['毛利率目標 40%']);
  });

  it('formatMemoryBlock 標示私有與專案', () => {
    expect(formatMemoryBlock([])).toBe('（目前沒有記憶）');
    expect(
      formatMemoryBlock([
        { id: '1', instance_id: 'x', content: '私', created_at: '' },
        { id: '2', instance_id: null, content: '公', created_at: '' },
      ]),
    ).toBe('- [私有] 私\n- [專案] 公');
  });
});

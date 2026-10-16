import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { formatMemoryIndex, loadMemoryIndex, memoryTools, type MemoryRow } from '../src/tools/memory';
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

const entry = (name: string, scope: 'private' | 'project', content: string) =>
  ({ name, scope, type: 'user' as const, summary: `${name} 的說明`, content });

function row(fields: Partial<MemoryRow>): MemoryRow {
  return { id: '1', instance_id: null, name: 'n', description: 'd', type: 'user', content: 'c', updated_at: '', ...fields };
}

describe('記憶工具', () => {
  it('工具輸入不用 description 欄位：進度畫面會把工具輸入的 description 當成步驟說明', () => {
    const t = memoryTools(db, 'p', 'i');
    for (const tool of [t.memory_write, t.memory_read, t.memory_delete]) {
      expect(Object.keys((tool.inputSchema as unknown as z.ZodObject).shape)).not.toContain('description');
    }
  });

  it('memory_write 新增後同名同 scope 再寫是更新，不會多一筆', async () => {
    const { projectId, a } = await setup();
    const t = memoryTools(db, projectId, a);
    expect(await t.memory_write.execute!({ ...entry('risk', 'project', '保守') }, opts)).toEqual({ ok: true, action: 'created' });
    expect(await t.memory_write.execute!({ ...entry('risk', 'project', '積極'), type: 'feedback' }, opts))
      .toEqual({ ok: true, action: 'updated' });
    const { rows } = await loadMemoryIndex(db, projectId, a);
    expect(rows.map((r) => [r.name, r.type, r.content])).toEqual([['risk', 'feedback', '積極']]);
  });

  it('私有記憶互相隔離：同名時各自一筆，讀、改、刪都只動到自己的', async () => {
    const { projectId, a, b } = await setup();
    const ta = memoryTools(db, projectId, a);
    const tb = memoryTools(db, projectId, b);
    await ta.memory_write.execute!(entry('note', 'private', 'A 的私事'), opts);
    await tb.memory_write.execute!(entry('note', 'private', 'B 的私事'), opts);
    await ta.memory_write.execute!(entry('note', 'project', '大家的事'), opts);

    const readByB = (await tb.memory_read.execute!({ names: ['note'] }, opts)) as { memories: { scope: string; content: string }[] };
    expect(readByB.memories.map((m) => [m.scope, m.content]).sort()).toEqual([['private', 'B 的私事'], ['project', '大家的事']]);

    await ta.memory_write.execute!(entry('note', 'private', 'A 改過'), opts);
    await ta.memory_delete.execute!({ name: 'note', scope: 'private' }, opts);
    const seenByB = (await loadMemoryIndex(db, projectId, b)).rows.map((r) => r.content).sort();
    expect(seenByB).toEqual(['B 的私事', '大家的事']);
    expect((await loadMemoryIndex(db, projectId, a)).rows.map((r) => r.content)).toEqual(['大家的事']);
  });

  it('專案記憶任何一位顧問都能更新與刪除', async () => {
    const { projectId, a, b } = await setup();
    await memoryTools(db, projectId, a).memory_write.execute!(entry('goal', 'project', '毛利 40%'), opts);
    const tb = memoryTools(db, projectId, b);
    expect(await tb.memory_write.execute!(entry('goal', 'project', '毛利 45%'), opts)).toEqual({ ok: true, action: 'updated' });
    expect(await tb.memory_delete.execute!({ name: 'goal', scope: 'project' }, opts)).toEqual({ ok: true });
    expect((await loadMemoryIndex(db, projectId, a)).rows).toEqual([]);
  });

  it('memory_read 回傳 scope、類型、說明與內容，找不到的列在 missing', async () => {
    const { projectId, a } = await setup();
    const t = memoryTools(db, projectId, a);
    await t.memory_write.execute!(entry('style', 'project', '先給結論'), opts);
    expect(await t.memory_read.execute!({ names: ['style', 'nope'] }, opts)).toEqual({
      memories: [{ name: 'style', scope: 'project', type: 'user', summary: 'style 的說明', content: '先給結論' }],
      missing: ['nope'],
    });
  });

  it('memory_delete 不存在時回傳錯誤', async () => {
    const { projectId, a } = await setup();
    const t = memoryTools(db, projectId, a);
    expect(await t.memory_delete.execute!({ name: 'nope', scope: 'private' }, opts)).toEqual({ error: '找不到私有記憶「nope」' });
    expect(await t.memory_delete.execute!({ name: 'nope', scope: 'project' }, opts)).toEqual({ error: '找不到專案記憶「nope」' });
  });

  it('索引依更新時間新到舊，超過上限時回報其餘筆數', async () => {
    const { projectId, a } = await setup();
    const t = memoryTools(db, projectId, a);
    await t.memory_write.execute!(entry('old', 'project', '舊'), opts);
    await t.memory_write.execute!(entry('new', 'project', '新'), opts);
    await t.memory_write.execute!(entry('old', 'project', '舊的更新了'), opts);
    expect((await loadMemoryIndex(db, projectId, a)).rows.map((r) => r.name)).toEqual(['old', 'new']);
    expect(await loadMemoryIndex(db, projectId, a, 1)).toMatchObject({ rows: [{ name: 'old' }], omitted: 1 });
  });
});

describe('formatMemoryIndex', () => {
  it('標示 scope 與類型，超過上限時提示還有幾筆', () => {
    expect(formatMemoryIndex({ rows: [], omitted: 0 })).toBe('（目前沒有記憶）');
    expect(formatMemoryIndex({
      rows: [
        row({ instance_id: null, type: 'user', name: 'user-profile', description: '科技業工程師' }),
        row({ instance_id: 'x', type: 'feedback', name: 'report-style', description: '先給結論' }),
      ],
      omitted: 12,
    })).toBe(
      '- [專案/user] user-profile — 科技業工程師\n- [私有/feedback] report-style — 先給結論\n'
      + '（還有 12 筆較舊的記憶沒有列出，可以用 memory_read 依名稱讀取）',
    );
  });
});

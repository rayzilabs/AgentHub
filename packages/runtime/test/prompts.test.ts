import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConsultantInstructions, buildManagerInstructions, SHARED_FILES_LISTED } from '../src/agents/prompts';
import type { AgentInstance } from '../src/types';

function consultant(name: string): AgentInstance {
  return {
    id: name, project_id: 'p', template_id: null, creator_id: null, role: 'consultant', name,
    description: '', system_prompt: '', skills_zip_path: null, skills: [], mcp_servers: [],
  };
}

describe('主管 prompt 的分工規則', () => {
  const text = buildManagerInstructions({
    consultants: [consultant('A'), consultant('B')], memories: { rows: [], omitted: 0 }, sharedRoot: '/shared', sharedFiles: [], now: new Date(),
  });

  it('後一步要用前一步的結果時，依序派工並把結果交給下一步', () => {
    expect(text).toContain('依序派工');
    expect(text).toContain('寫進下一步的任務說明');
  });

  it('需要先算出結果才能討論時，先派工再召開討論', () => {
    expect(text).toContain('先用 assign_task 取得結果，再把結果寫進討論題目');
  });

  it('回覆不可加入顧問沒有提供的數字', () => {
    expect(text).toContain('不要自行補上');
  });
});

describe('顧問 prompt', () => {
  it('工具回傳 download_url 時用 curl 下載到工作目錄，不把大量資料貼進回覆', () => {
    const text = buildConsultantInstructions({
      instance: consultant('A'), workDir: '/w', sharedRoot: '/shared', sharedFiles: [], memories: { rows: [], omitted: 0 }, mcpWarnings: [], now: new Date(),
    });
    expect(text).toContain('download_url');
    expect(text).toContain('curl');
  });
});

describe('今天的日期', () => {
  const managerAt = (now: Date) => buildManagerInstructions({
    consultants: [consultant('A')], memories: { rows: [], omitted: 0 }, sharedRoot: '/shared', sharedFiles: [], now,
  });
  const consultantAt = (now: Date) => buildConsultantInstructions({
    instance: { ...consultant('A'), system_prompt: '你是人資顧問。' }, workDir: '/w', sharedRoot: '/shared', sharedFiles: [],
    memories: { rows: [], omitted: 0 }, mcpWarnings: [], now,
  });

  it('主管與顧問的 prompt 都寫出台灣的今天日期與星期', () => {
    const now = new Date('2026-11-13T01:00:00Z'); // 台灣 11/13 09:00
    expect(managerAt(now)).toContain('今天是 2026-11-13（星期五），台灣時間。');
    expect(consultantAt(now)).toContain('今天是 2026-11-13（星期五），台灣時間。');
  });

  it('UTC 還是前一天、台灣已經是隔天時，用台灣的日期', () => {
    const now = new Date('2026-11-12T16:30:00Z'); // 台灣 11/13 00:30
    expect(managerAt(now)).toContain('今天是 2026-11-13（星期五），台灣時間。');
    expect(consultantAt(now)).toContain('今天是 2026-11-13（星期五），台灣時間。');
  });

  it('日期放在角色段落之後、其他段落之前；記憶規則的相對日期以它為準', () => {
    const now = new Date('2026-11-13T01:00:00Z');
    const c = consultantAt(now);
    expect(c.indexOf('你是人資顧問。')).toBeLessThan(c.indexOf('今天是'));
    expect(c.indexOf('今天是')).toBeLessThan(c.indexOf('## 工作環境'));
    const m = managerAt(now);
    expect(m.indexOf('今天是')).toBeLessThan(m.indexOf('## 你的顧問'));
    expect(m).toContain('相對日期換成絕對日期（以上面的「今天」為準）');
  });
});

describe('專案檔案清單', () => {
  it('共用檔案超過 50 個時只列前 50 個並提示 ls -R', () => {
    expect(SHARED_FILES_LISTED).toBe(50);
    const sharedFiles = Array.from({ length: 60 }, (_, i) => ({ path: `資料/f${String(i + 1).padStart(2, '0')}.txt`, fileId: `id${i}` }));
    const text = buildManagerInstructions({ consultants: [consultant('A')], memories: { rows: [], omitted: 0 }, sharedRoot: '/shared', sharedFiles, now: new Date() });
    expect(text).toContain(`- ${path.join('/shared', '資料', 'f50.txt')}\n`);
    expect(text).not.toContain('f51.txt');
    expect(text).toContain('- …還有 10 個檔案，用 bash 執行 ls -R /shared 查看');
  });
});

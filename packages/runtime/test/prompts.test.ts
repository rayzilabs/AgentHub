import { describe, expect, it } from 'vitest';
import { buildConsultantInstructions, buildManagerInstructions } from '../src/agents/prompts';
import type { AgentInstance } from '../src/types';

function consultant(name: string): AgentInstance {
  return {
    id: name, project_id: 'p', template_id: null, creator_id: null, role: 'consultant', name,
    description: '', system_prompt: '', skills_zip_path: null, skills: [], mcp_servers: [],
  };
}

describe('主管 prompt 的分工規則', () => {
  const text = buildManagerInstructions({
    consultants: [consultant('A'), consultant('B')], memories: { rows: [], omitted: 0 }, sharedRoot: '/shared', sharedFiles: [],
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
      instance: consultant('A'), workDir: '/w', sharedRoot: '/shared', sharedFiles: [], memories: { rows: [], omitted: 0 }, mcpWarnings: [],
    });
    expect(text).toContain('download_url');
    expect(text).toContain('curl');
  });
});

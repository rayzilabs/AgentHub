import { describe, expect, it } from 'vitest';
import { loadDemoAgents } from '@/lib/demo';
import { TemplateInputSchema } from '@/lib/schemas';
import { parseSkillsZip } from '@/lib/skills-zip';

describe('loadDemoAgents', () => {
  it('讀出三位顧問，內容通過格式檢查，skill zip 可以解析', async () => {
    const agents = await loadDemoAgents();
    expect(agents.map((a) => a.slug)).toEqual(['compliance', 'credit', 'finance']);
    for (const a of agents) {
      expect(TemplateInputSchema.parse(a.input)).toEqual(a.input);
      expect(a.input.description).toContain('（示範內容，正式版本將由執業專業人士提供）');
      expect(a.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
      expect(parseSkillsZip(a.skillsZip)).toHaveLength(2);
    }
  });
});

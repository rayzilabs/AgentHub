import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { loadDemoAgents, publishDemoAgents, type DemoAgent } from '@/lib/demo';
import { TemplateInputSchema } from '@/lib/schemas';
import { listMyTemplates, listPublishedTemplates } from '@/lib/services/templates';
import { parseSkillsZip } from '@/lib/skills-zip';
import { seedUser, testDb } from './helpers';

const SKILLS: Record<string, string[]> = {
  credit: ['credit-5p', 'ratio-check'],
  compliance: ['aml-kyc', 'data-privacy'],
  finance: ['cashflow', 'valuation'],
};

describe('loadDemoAgents', () => {
  it('讀出三位顧問，內容通過格式檢查，skill zip 可以解析', async () => {
    const agents = await loadDemoAgents();
    expect(agents.map((a) => a.slug)).toEqual(['compliance', 'credit', 'finance']);
    for (const a of agents) {
      expect(TemplateInputSchema.parse(a.input)).toEqual(a.input);
      expect(a.input.description).toContain('（示範內容，正式版本將由執業專業人士提供）');
      expect(a.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
      expect(parseSkillsZip(a.skillsZip)).toHaveLength(2);
      expect(parseSkillsZip(a.skillsZip).map((k) => k.name).sort()).toEqual(SKILLS[a.slug]);
    }
  });
});

describe('publishDemoAgents', () => {
  const db = testDb();
  const agent = (description: string): DemoAgent => ({
    slug: 'legal',
    input: TemplateInputSchema.parse({ name: `上架測試-${randomUUID()}`, description, system_prompt: '你是法務顧問' }),
    skillsZip: zipSync({ 'review/SKILL.md': strToU8('---\nname: review\ndescription: 審合約\n---\n') }),
  });

  it('第一次建立並上架到市集；同名再跑一次是更新同一個範本，不會重複建立', async () => {
    const creator = await seedUser(db);
    const first = agent('第一版');
    const [created] = await publishDemoAgents(db, creator.id, [first]);
    expect(created.created).toBe(true);
    const listed = (await listPublishedTemplates(db)).find((t) => t.id === created.id);
    expect(listed?.description).toBe('第一版');

    const [updated] = await publishDemoAgents(db, creator.id, [{ ...first, input: { ...first.input, description: '第二版' } }]);
    expect(updated).toEqual({ id: created.id, name: first.input.name, created: false });
    const mine = await listMyTemplates(db, creator.id);
    expect(mine.filter((t) => t.name === first.input.name)).toHaveLength(1);
    expect(mine.find((t) => t.id === created.id)).toMatchObject({ description: '第二版', status: 'published' });
    expect(mine.find((t) => t.id === created.id)?.skills.map((k) => k.name)).toEqual(['review']);
  });
});

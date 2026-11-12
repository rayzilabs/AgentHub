import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUSINESS_AGENTS_ROOT, loadDemoAgents, type DemoAgent } from '@/lib/demo';
import { parseSkillsZip } from '@/lib/skills-zip';

const SKILLS = [
  'campaign-plan',
  'copywriting',
  'customer-competitor-research',
  'line-official-account',
  'marketing-setup',
  'seo-ai-visibility',
  'social-content',
];

// 中國用語 → 台灣用語；美國法規與美國情境殘留
const CHINA_TERMS = ['視頻', '營銷', '質量', '用戶', '性價比', '網絡', '信息', '軟件', '優化', '打造爆款'];
// 用語對照表本來就要列出中國用語
const WORDING_TABLE = 'copywriting/references/tw-wording.md';
const US_RESIDUE =['FTC', 'CAN-SPAM', 'GDPR', 'CCPA', 'FLSA', 'at-will', 'Product Hunt', 'MRR', 'paywall', 'USD', '$'];

describe('行銷顧問', () => {
  let a: DemoAgent;
  let files: { file: string; text: string }[];
  beforeAll(async () => {
    const found = (await loadDemoAgents(BUSINESS_AGENTS_ROOT)).find((x) => x.slug === 'marketing');
    if (!found) throw new Error('找不到 demo/business-agents/marketing');
    a = found;
    files = Object.entries(unzipSync(a.skillsZip)).map(([file, bytes]) => ({ file, text: strFromU8(bytes) }));
  });

  // 格式由 loadDemoAgents 讀檔時的 TemplateInputSchema 驗證
  it('兩句標示都在', () => {
    expect(a.input.description).toContain('（示範內容，正式版本將由執業專業人士提供）');
    expect(a.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
    expect(a.input.system_prompt).toContain('行銷成效會因產業、預算與執行而不同；涉及廣告法規的內容請另請法務確認');
  });

  it('skill zip 解析得出確認過的 7 個 skill', () => {
    expect(parseSkillsZip(a.skillsZip).map((k) => k.name).sort()).toEqual(SKILLS);
  });

  it('掛上平台代管的 tw-marketing，套件讀得到', () => {
    expect(a.input.mcp_servers).toEqual([{ name: 'tw-marketing', transport: 'remote', hosted: true, required_secrets: [] }]);
    expect(Object.keys(a.hosted['tw-marketing'])).toEqual(expect.arrayContaining(['mcp.json', 'server.py', 'site_audit.py', 'tw_calendar.py']));
  });

  it('每個 SKILL.md 都有來源段落，並且先讀專案記憶 marketing-playbook', () => {
    const skillMds = files.filter((f) => f.file.endsWith('SKILL.md'));
    expect(skillMds).toHaveLength(SKILLS.length);
    for (const f of skillMds) {
      expect(f.text, f.file).toMatch(/## 來源/);
      expect(f.text, f.file).toContain('marketing-playbook');
    }
  });

  it('skill 與 references 沒有中國用語，也沒有美國法規或美國情境殘留', () => {
    for (const f of files) {
      const terms = f.file === WORDING_TABLE ? US_RESIDUE : [...CHINA_TERMS, ...US_RESIDUE];
      for (const term of terms) expect(f.text.includes(term), `${f.file} 出現「${term}」`).toBe(false);
    }
  });

  it('references 裡的數字與價格都附「資料截至」日期', () => {
    const refs = files.filter((f) => f.file.includes('/references/'));
    expect(refs.length).toBeGreaterThan(0);
    for (const f of refs) expect(f.text, f.file).toMatch(/資料截至 \d{4}-\d{2}-\d{2}/);
  });

  it('Apache-2.0 來源列在 NOTICE.md', async () => {
    const notice = await readFile(path.join(BUSINESS_AGENTS_ROOT, 'marketing', 'NOTICE.md'), 'utf8');
    expect(notice).toContain('anthropics/knowledge-work-plugins');
    expect(notice).toContain('Apache License 2.0');
  });
});

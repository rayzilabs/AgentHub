import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUSINESS_AGENTS_ROOT, loadDemoAgents, type DemoAgent } from '@/lib/demo';
import { parseSkillsZip } from '@/lib/skills-zip';

/**
 * 非金融顧問（demo/business-agents/<slug>/）的共用規則。新增顧問時在這裡加一筆設定，
 * 沒有設定的資料夾會讓測試失敗，避免漏測。
 */
type AgentSpec = {
  skills: string[];
  /** agent.json 的 mcp_servers（含 schema 預設值） */
  mcpServers: unknown[];
  /** system prompt 要寫出的 MCP 工具名稱（runtime 給模型的名稱是 <MCP 名稱，- 換成 _>__<工具>） */
  toolNames: string[];
  /** 每個 SKILL.md 開頭都要讀的專案記憶 */
  playbook: string;
  /** 共同開頭聲明之後，這位顧問另外要有的句子 */
  extraDisclaimer?: string;
  /** NOTICE.md 必須提到的來源與授權 */
  noticeMentions: string[];
  /** 允許出現中國用語的檔案（用語對照表），路徑相對於 skills/ */
  wordingTables?: string[];
};

const AGENTS: Record<string, AgentSpec> = {
  marketing: {
    skills: [
      'campaign-plan', 'copywriting', 'customer-competitor-research', 'line-official-account',
      'marketing-setup', 'seo-ai-visibility', 'social-content',
    ],
    mcpServers: [{ name: 'tw-marketing', transport: 'remote', hosted: true, required_secrets: [] }],
    toolNames: ['tw_marketing__tw_calendar', 'tw_marketing__site_audit'],
    playbook: 'marketing-playbook',
    extraDisclaimer: '行銷成效會因產業、預算與執行而不同；涉及廣告法規的內容請另請法務確認',
    noticeMentions: ['anthropics/knowledge-work-plugins', 'Apache License 2.0', 'coreyhaines31/marketingskills', 'MIT'],
    wordingTables: ['copywriting/references/tw-wording.md'],
  },
};

const DEMO_NOTE = '（示範內容，正式版本將由執業專業人士提供）';
const DISCLAIMER = '以下為一般性分析，不構成正式法律、財務或授信意見';
const CHINA_TERMS = ['視頻', '營銷', '質量', '用戶', '性價比', '網絡', '信息', '軟件', '優化', '打造爆款'];
// 美國法規與美國情境殘留；`${CLAUDE_SKILL_DIR}` 這類 skill 變數不算，只擋「$ 後面接數字」的美元金額
const US_RESIDUE = ['FTC', 'CAN-SPAM', 'GDPR', 'CCPA', 'FLSA', 'at-will', '401(k)', 'W-2', 'Product Hunt', 'MRR', 'paywall', 'USD'];
const DOLLAR_AMOUNT = /\$\s?\d/;

describe('business-agents 資料夾都有測試設定', () => {
  it('每個顧問資料夾都在 AGENTS 對照表裡', async () => {
    const dirs = (await readdir(BUSINESS_AGENTS_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(dirs).toEqual(Object.keys(AGENTS).sort());
  });
});

describe.each(Object.entries(AGENTS))('%s', (slug, spec) => {
  let agent: DemoAgent;
  let files: { file: string; text: string }[];
  beforeAll(async () => {
    const found = (await loadDemoAgents(BUSINESS_AGENTS_ROOT)).find((a) => a.slug === slug);
    if (!found) throw new Error(`找不到 demo/business-agents/${slug}`);
    agent = found;
    files = Object.entries(unzipSync(agent.skillsZip)).map(([file, bytes]) => ({ file, text: strFromU8(bytes) }));
  });

  // 格式由 loadDemoAgents 讀檔時的 TemplateInputSchema 驗證
  it('兩句標示都在', () => {
    expect(agent.input.description).toContain(DEMO_NOTE);
    expect(agent.input.system_prompt).toContain(DISCLAIMER);
    if (spec.extraDisclaimer) expect(agent.input.system_prompt).toContain(spec.extraDisclaimer);
  });

  it('skill zip 解析得出確認過的 skill 清單', () => {
    expect(parseSkillsZip(agent.skillsZip).map((k) => k.name).sort()).toEqual([...spec.skills].sort());
  });

  it('MCP 設定符合，代管 MCP 的套件讀得到', () => {
    expect(agent.input.mcp_servers).toEqual(spec.mcpServers);
    for (const [name, pkg] of Object.entries(agent.hosted)) expect(Object.keys(pkg), name).toContain('mcp.json');
  });

  // 只寫「某 MCP 的 某工具」時，模型會先呼叫不存在的工具名稱（2026-11-12 正式站驗收第 1 輪）
  it('system prompt 用 runtime 實際的工具名稱，skill 不用「某 MCP 的 某工具」的寫法', () => {
    for (const tool of spec.toolNames) expect(agent.input.system_prompt).toContain(tool);
    for (const f of files) expect(f.text, f.file).not.toMatch(/MCP 的 `/);
  });

  it('每個 SKILL.md 都先讀專案記憶，結尾有來源段落並註明台灣化', () => {
    const skillMds = files.filter((f) => f.file.endsWith('SKILL.md'));
    expect(skillMds).toHaveLength(spec.skills.length);
    for (const f of skillMds) {
      expect(f.text, f.file).toContain(spec.playbook);
      expect(f.text, f.file).toMatch(/## 來源/);
      expect(f.text, f.file).toContain('已翻譯並改寫為台灣情境');
    }
  });

  it('沒有中國用語，也沒有美國法規或美國情境殘留', () => {
    for (const f of files) {
      const terms = spec.wordingTables?.includes(f.file) ? US_RESIDUE : [...CHINA_TERMS, ...US_RESIDUE];
      for (const term of terms) expect(f.text.includes(term), `${f.file} 出現「${term}」`).toBe(false);
      expect(f.text, `${f.file} 出現美元金額`).not.toMatch(DOLLAR_AMOUNT);
    }
  });

  it('references 都附「資料截至」日期', () => {
    const refs = files.filter((f) => f.file.includes('/references/'));
    expect(refs.length).toBeGreaterThan(0);
    for (const f of refs) expect(f.text, f.file).toMatch(/資料截至 \d{4}-\d{2}-\d{2}/);
  });

  it('NOTICE.md 列出來源與授權', async () => {
    const notice = await readFile(path.join(BUSINESS_AGENTS_ROOT, slug, 'NOTICE.md'), 'utf8');
    for (const s of spec.noticeMentions) expect(notice).toContain(s);
  });
});

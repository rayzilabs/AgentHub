// 人資顧問（demo/business-agents/hr）：格式、skill 清單、標示、出處，以及 skill 附的試算腳本
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUSINESS_AGENTS_ROOT, loadDemoAgents, type DemoAgent } from '@/lib/demo';
import { TemplateInputSchema } from '@/lib/schemas';
import { parseSkillsZip } from '@/lib/skills-zip';

const DIR = join(BUSINESS_AGENTS_ROOT, 'hr');
const SKILLS = [
  'harassment-bullying', 'hiring', 'hr-setup', 'leave', 'onboarding-contract', 'payroll-insurance', 'termination', 'worker-classification', 'working-hours',
];

describe('人資顧問', () => {
  let hr: DemoAgent;
  let files: Record<string, string>; // skill zip 裡的檔案（路徑 → 內容），和上架到平台的一樣

  beforeAll(async () => {
    hr = (await loadDemoAgents(BUSINESS_AGENTS_ROOT)).find((a) => a.slug === 'hr')!;
    files = Object.fromEntries(Object.entries(unzipSync(hr.skillsZip)).map(([p, b]) => [p, strFromU8(b)]));
  });

  it('格式通過、skill 清單正確、兩句標示都在、掛上兩個代管 MCP', () => {
    expect(TemplateInputSchema.parse(hr.input)).toEqual(hr.input);
    expect(hr.input.description).toMatch(/（示範內容，正式版本將由執業專業人士提供）$/);
    expect(hr.input.system_prompt).toContain('以下為一般性分析，不構成正式法律、財務或授信意見');
    expect(parseSkillsZip(hr.skillsZip).map((s) => s.name).sort()).toEqual(SKILLS);
    expect(hr.input.mcp_servers.map((m) => [m.name, m.transport, m.hosted])).toEqual([
      ['taiwan-payroll', 'remote', true],
      ['taiwan-holidays', 'remote', true],
    ]);
    expect(Object.keys(hr.hosted).sort()).toEqual(['taiwan-holidays', 'taiwan-payroll']);
  });

  it('每個 skill 的 description 寫明什麼情況用、結尾有來源段落', () => {
    for (const s of parseSkillsZip(hr.skillsZip)) {
      expect(s.description, s.name).toMatch(/用|時/);
      expect(files[`${s.name}/SKILL.md`], s.name).toMatch(/\n## 來源\n/);
    }
  });

  it('有 NOTICE.md，列出改寫來源與授權', () => {
    const notice = readFileSync(join(DIR, 'NOTICE.md'), 'utf8');
    for (const src of ['anthropics/claude-for-legal', 'anthropics/knowledge-work-plugins', 'hikari5014/Labor-Pixie', 'law24tw/tw-legal-calc']) expect(notice).toContain(src);
    expect(notice).toContain('Apache License 2.0');
    expect(notice).toContain('MIT');
  });

  it('沒有美國法殘留', () => {
    const banned = /at-will|FLSA|401\(?k\)?|W-2|\bexempt\b|state law|RSU|EEOC|OSHA|COBRA|FMLA/i;
    expect(JSON.stringify(hr.input)).not.toMatch(banned);
    for (const [path, text] of Object.entries(files)) expect(text, path).not.toMatch(banned);
  });

  it('skill 引用的 references 與 scripts 都在 zip 裡', () => {
    for (const name of SKILLS) {
      for (const [, rel] of files[`${name}/SKILL.md`].matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+)/g)) {
        expect(files, `${name} → ${rel}`).toHaveProperty([`${name}/${rel}`]);
      }
    }
  });
});

describe('試算腳本', () => {
  // 腳本在 Linux 沙盒執行；Windows 主控台預設不是 UTF-8，所以測試時指定
  const py = (script: string, args: string[]) =>
    JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', [join(DIR, 'skills', script), ...args, '--json'], {
      encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' },
    }));

  it('資遣費：新制每滿 1 年 ½ 個月，未滿 1 年按比例，最高 6 個月', () => {
    // 2023-03-01 到職、2026-09-01 離職，平均工資 45,000：年資 3 年 6 個月 → 3.5 / 2 = 1.75 個月
    const r = py('termination/scripts/severance.py', ['--onboard', '2023-03-01', '--leave', '2026-09-01', '--avg-wage', '45000']);
    expect(r.total).toBe(78750);
    // 年資 20 年 → 10 個月，上限 6 個月
    expect(py('termination/scripts/severance.py', ['--onboard', '2006-01-01', '--leave', '2026-01-01', '--avg-wage', '50000']).total).toBe(300000);
  });

  it('資遣費：94/7/1 前到職、選擇新制者，舊制年資照舊制算', () => {
    // 2004-07-01 到職，舊制年資 1 年（1 個月）+ 新制 2005-07-01～2026-07-01 21 年 → 6 個月上限
    const r = py('termination/scripts/severance.py', ['--onboard', '2004-07-01', '--leave', '2026-07-01', '--avg-wage', '40000']);
    expect(r.parts['舊制'].amount).toBe(40000);
    expect(r.parts['新制'].amount).toBe(240000);
    expect(r.total).toBe(280000);
  });

  it('特休：週年制依年資給假，離職時只算當期未休，全額折發不按比例', () => {
    // 2024-03-01 到職，2026-05-15 離職：當期（2026-03-01 起，滿 2 年）10 日，已休 4 日 → 未休 6 日 × 月薪 36,000 / 30
    const r = py('leave/scripts/annual_leave.py', ['--onboard', '2024-03-01', '--leave', '2026-05-15', '--taken', '4', '--monthly-wage', '36000']);
    expect(r.current_period.entitled_days).toBe(10);
    expect(r.unused_days).toBe(6);
    expect(r.unused_wage).toBe(7200);
    // 未滿 6 個月沒有特休
    expect(py('leave/scripts/annual_leave.py', ['--onboard', '2026-01-10', '--leave', '2026-05-01']).current_period).toBeNull();
  });
});

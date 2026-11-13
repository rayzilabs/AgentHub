// 人資顧問（demo/business-agents/hr）特有的規則與 skill 附的試算腳本。
// 格式、skill 清單、MCP 設定、標示、NOTICE、資料日期等共用規則在 business-agents.test.ts。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUSINESS_AGENTS_ROOT, loadDemoAgents, type DemoAgent } from '@/lib/demo';
import { parseSkillsZip } from '@/lib/skills-zip';

const DIR = join(BUSINESS_AGENTS_ROOT, 'hr');

describe('人資顧問', () => {
  let hr: DemoAgent;
  let files: Record<string, string>; // skill zip 裡的檔案（路徑 → 內容），和上架到平台的一樣

  beforeAll(async () => {
    hr = (await loadDemoAgents(BUSINESS_AGENTS_ROOT)).find((a) => a.slug === 'hr')!;
    files = Object.fromEntries(Object.entries(unzipSync(hr.skillsZip)).map(([p, b]) => [p, strFromU8(b)]));
  });

  it('system prompt 要求先取得今天日期', () => {
    // runtime 的 prompt 沒有今天日期；期限、法規是否已施行、年度費率都依賴日期
    expect(hr.input.system_prompt).toContain('TZ=Asia/Taipei date');
  });

  it('每個 skill 的 description 寫明什麼情況用', () => {
    for (const s of parseSkillsZip(hr.skillsZip)) expect(s.description, s.name).toMatch(/時用|用：/);
  });

  it('沒有美國勞動法的專有名詞', () => {
    const banned = /at-will|FLSA|401\(?k\)?|W-2|\bexempt\b|state law|RSU|EEOC|OSHA|COBRA|FMLA/i;
    expect(JSON.stringify(hr.input)).not.toMatch(banned);
    for (const [path, text] of Object.entries(files)) expect(text, path).not.toMatch(banned);
  });

  it('skill 引用的 references 與 scripts 都在 zip 裡', () => {
    for (const s of parseSkillsZip(hr.skillsZip)) {
      for (const [, rel] of files[`${s.name}/SKILL.md`].matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+)/g)) {
        expect(files, `${s.name} → ${rel}`).toHaveProperty([`${s.name}/${rel}`]);
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

  // 失敗時回傳錯誤訊息，成功時回傳 null
  const pyError = (script: string, args: string[]): string | null => {
    try {
      py(script, args);
      return null;
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
  };

  it('資遣費：勞動部官網範例（年資 3 年 6 個月 15 天、平均工資 30,000）新制 53,125、舊制 107,500', () => {
    // 新制：30,000 × ½ × {3 + (6 + 15/30) ÷ 12} ≒ 53,124.9
    expect(py('termination/scripts/severance.py', ['--onboard', '2022-01-01', '--leave', '2025-07-16', '--avg-wage', '30000']).total).toBe(53125);
    // 舊制：30,000 × {3 + (6 + 1) ÷ 12} ≒ 107,499.9（94/7/1 前的年資）
    expect(py('termination/scripts/severance.py', ['--onboard', '2001-01-01', '--leave', '2004-07-16', '--avg-wage', '30000']).total).toBe(107500);
  });

  it('平均工資：前 6 個月工資總額 ÷ 6（勞動部 83 年函釋），不是 ÷ 總日數 × 30', () => {
    const r = py('termination/scripts/severance.py', ['--onboard', '2023-03-01', '--leave', '2026-09-01', '--wages', '46000,45000,45000,44000,45000,45000']);
    expect(r.avg_monthly_wage).toBe(45000);
  });

  it('跨制：依實際改選新制的日期分段；94/7/1 後到職不能選舊制', () => {
    // 2000 年到職、2008 年才改選新制：舊制 8 年 8 個月＋新制 18 年 9 個月（上限 6 個月）
    const r = py('termination/scripts/severance.py', ['--onboard', '2000-01-01', '--leave', '2026-01-01', '--avg-wage', '40000', '--switch-date', '2008-01-01']);
    expect([r.parts['舊制'].amount, r.parts['新制'].amount]).toEqual([320000, 240000]);
    expect(pyError('termination/scripts/severance.py', ['--onboard', '2010-01-01', '--leave', '2026-01-01', '--avg-wage', '40000', '--old-system'])).toMatch(/94\/7\/1/);
  });

  it('資遣的期限都是曆日：預告天數依年資、最晚通知日、資遣通報與資遣費給付期限', () => {
    const r = py('termination/scripts/severance.py', ['--onboard', '2023-03-01', '--leave', '2026-09-01', '--avg-wage', '45000']);
    expect(r.deadlines).toMatchObject({ notice_days: 30, notify_by: '2026-08-02', report_by: '2026-08-22', pay_by: '2026-10-01' });
    // 年資滿 3 個月未滿 1 年預告 10 日；未滿 3 個月不用預告
    expect(py('termination/scripts/severance.py', ['--onboard', '2026-01-01', '--leave', '2026-06-01', '--avg-wage', '30000']).deadlines.notice_days).toBe(10);
    expect(py('termination/scripts/severance.py', ['--onboard', '2026-04-01', '--leave', '2026-06-01', '--avg-wage', '30000']).deadlines.notice_days).toBe(0);
  });

  it('特休：已休超過可休天數時報錯說明，不會算出負數；協商遞延的天數一併結算', () => {
    expect(pyError('leave/scripts/annual_leave.py', ['--onboard', '2024-03-01', '--leave', '2026-05-15', '--taken', '13'])).toMatch(/已休/);
    const r = py('leave/scripts/annual_leave.py', ['--onboard', '2024-03-01', '--leave', '2026-05-15', '--taken', '4', '--deferred', '2', '--monthly-wage', '36000']);
    expect([r.unused_days, r.unused_wage]).toEqual([8, 9600]);
  });

  it('特休：月底到職，次月沒有相當日時，期間末日是月底、隔天才取得特休（民法第 121 條）', () => {
    const r = py('leave/scripts/annual_leave.py', ['--onboard', '2024-08-31', '--leave', '2025-03-15']);
    expect(r.current_period).toMatchObject({ start: '2025-03-01', entitled_days: 3 });
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

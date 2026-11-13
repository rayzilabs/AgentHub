import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('legal-letter：遲延利息試算腳本', () => {
  const run = (args: string[]) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const script = fileURLToPath(new URL('../demo/business-agents/legal/skills/legal-letter/scripts/interest.py', import.meta.url));
    const out = spawnSync(py, [script, ...args], { encoding: 'utf8' });
    return { code: out.status, json: out.stdout ? JSON.parse(out.stdout) : null, err: out.stderr };
  };

  it('週年 5%、起迄都算入：滿一年就是本金的 5%', () => {
    const { code, json } = run(['--principal', '100000', '--start', '1150101', '--end', '1151231']);
    expect(code).toBe(0);
    expect(json).toMatchObject({ principal: 100000, rate: 0.05, start: '115.1.1', end: '115.12.31', amount: 5000 });
    expect(json.basis_years).toMatchObject({ full: 1, remainder_days: 0 });
  });

  it('不足一年按該年度天數比例；可用西元日期與自訂利率', () => {
    const { json } = run(['--principal', '365000', '--rate', '10', '--start', '2026-01-01', '--end', '2026-01-10']);
    expect(json).toMatchObject({ rate: 0.1, amount: 1000, basis_years: { full: 0, remainder_days: 10, denominator: 365 } });
  });

  it('年息一律以百分比解讀：--rate 1 是 1%', () => {
    const { json } = run(['--principal', '100000', '--rate', '1', '--start', '1150101', '--end', '1151231']);
    expect(json).toMatchObject({ rate: 0.01, amount: 1000 });
  });

  it('2 月 29 日起算：一年期間到隔年 2 月 28 日（民法第 121 條第 2 項，沒有相當日以月末為末日）', () => {
    const { json } = run(['--principal', '100000', '--start', '20240229', '--end', '20250228']);
    expect(json).toMatchObject({ amount: 5000, basis_years: { full: 1, remainder_days: 0 } });
  });

  it('年息超過週年 16% 時附警告（民法第 205 條）', () => {
    expect(run(['--principal', '100000', '--rate', '20', '--start', '1150101', '--end', '1151231']).json.warning).toContain('第 205 條');
    expect(run(['--principal', '100000', '--start', '1150101', '--end', '1151231']).json.warning).toBeUndefined();
  });

  it('本金或年息是負數時拒絕', () => {
    const { code, err } = run(['--principal', '-1', '--start', '1150101', '--end', '1151231']);
    expect(code).not.toBe(0);
    expect(err).toContain('不能是負數');
  });

  it('日期錯誤時回傳錯誤訊息與非零結束碼', () => {
    const { code, err } = run(['--principal', '1', '--start', '1151301', '--end', '1151231']);
    expect(code).not.toBe(0);
    expect(err).toContain('日期不存在');
  });
});

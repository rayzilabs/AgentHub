// 人資顧問的兩個平台代管 MCP（demo/hosted-mcp/taiwan-payroll、taiwan-holidays）。
// 啟動測試會在套件目錄跑 npm ci（第一次較慢），再以本機 JWKS 當作平台簽通行證呼叫。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMcpJson } from '@/lib/services/hosted-mcp';
import { createPayrollEngine, getAvailableYears } from '../demo/hosted-mcp/taiwan-payroll/packages/core/src/index';
import { addWorkdays, countWorkdays } from '../demo/hosted-mcp/taiwan-holidays/src/engine/index';
import { loadCalendars } from '../demo/hosted-mcp/taiwan-holidays/src/data';
import { parseCalendarCsv, pickLatestCsv } from '../demo/hosted-mcp/taiwan-holidays/scripts/update-calendar.mjs';

const root = fileURLToPath(new URL('../demo/hosted-mcp/', import.meta.url));
const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/hr-mcp-baseline.json', import.meta.url)), 'utf8')) as Record<
  'payroll' | 'holidays',
  { name: string; args: Record<string, unknown>; isError: boolean; structured: unknown; text: string }[]
>;

describe('代管套件格式', () => {
  it('兩個套件的 mcp.json 都是 node、用 package.json 安裝，並附 lock 檔與上游授權', () => {
    for (const name of ['taiwan-payroll', 'taiwan-holidays']) {
      const dir = join(root, name);
      expect(parseMcpJson(readFileSync(join(dir, 'mcp.json'), 'utf8'))).toEqual({ runtime: 'node', start: 'node --import tsx server.mjs', install: 'package.json' });
      expect(existsSync(join(dir, 'package-lock.json'))).toBe(true);
      expect(readFileSync(join(dir, 'LICENSE'), 'utf8')).toMatch(/MIT License/);
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toMatch(/更新/);
    }
  });
});

describe('taiwan-payroll 上游官方範例向量', () => {
  const dir = join(root, 'taiwan-payroll/testdata');
  const collect = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (statSync(p).isDirectory()) return collect(p);
      return n.endsWith('.json') && n !== 'schema.json' ? [p] : [];
    });
  const files = collect(dir);

  it('有至少 30 筆向量，涵蓋所有內建年度', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(getAvailableYears()).toEqual([2024, 2025, 2026]);
  });

  const subset = (actual: unknown, expected: Record<string, unknown>, path: string): void => {
    for (const [k, e] of Object.entries(expected)) {
      const a = (actual as Record<string, unknown>)?.[k];
      if (e !== null && typeof e === 'object') subset(a, e as Record<string, unknown>, `${path}${k}.`);
      else expect(a, `${path}${k}`).toBe(e);
    }
  };
  for (const file of files) {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    it(`${v.id}`, () => {
      const engine = createPayrollEngine({ year: v.year });
      const kind = (v.kind ?? 'calculate') as string;
      const run: Record<string, (i: never) => unknown> = {
        calculate: engine.calculate,
        withholding: engine.calculateWithholding,
        'employer-supplementary': engine.calculateEmployerSupplementary,
        supplementary: engine.calculateSupplementary,
        prorated: engine.calculateProrated,
        'old-age-pension': engine.calculateOldAgePension,
        'old-age-lump-sum': engine.calculateOldAgeLumpSum,
        'old-age-single-payment': engine.calculateOldAgeSinglePayment,
      };
      subset(run[kind](v.input as never), v.expected, '');
    });
  }
});

describe('taiwan-holidays 行事曆資料與更新腳本', () => {
  it('data/ 有 2017–2027 年，每年天數正確', () => {
    const cal = loadCalendars();
    expect(Object.keys(cal).map(Number)).toEqual([2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]);
    expect(cal[2024]).toHaveLength(366);
    expect(cal[2027]).toHaveLength(365);
  });

  it('116 年春節與上游遠端版算法一致', () => {
    const days = Object.values(loadCalendars()).flat();
    expect(countWorkdays(days, '2027-01-01', '2027-02-28')).toEqual({ workdays: 35, holidays: 24, makeupWorkdays: 0 });
    expect(addWorkdays(days, '2026-12-28', 10)).toEqual({ date: '2027-01-12' });
  });

  it('parseCalendarCsv：解析官方 CSV（UTF-8 BOM 與 Big5），2 是放假、0 是上班', () => {
    const csv = '﻿西元日期,星期,是否放假,備註\r\n20250208,六,0,補行上班\r\n20250209,日,2,\r\n20250210,一,0,\r\n';
    const expected = [
      { date: '20250208', week: '六', isHoliday: false, description: '補行上班' },
      { date: '20250209', week: '日', isHoliday: true, description: '' },
      { date: '20250210', week: '一', isHoliday: false, description: '' },
    ];
    expect(parseCalendarCsv(new TextEncoder().encode(csv))).toEqual(expected);
    // 舊年度的檔案是 Big5：「西元日期,星期,是否放假,備註\n20250208,六,0,補行上班\n」（iconv 產生）
    const big5 = Uint8Array.from(Buffer.from('a6e8a4b8a4e9b4c12cac50b4c12cac4fa75fa9f1b0b22cb3c6b5f90a32303235303230382ca4bb2c302cb8c9a6e6a457af5a0a', 'hex'));
    expect(parseCalendarCsv(big5)).toEqual([expected[0]]);
  });

  it('pickLatestCsv：每年只取最新一份、不要 Google 行事曆專用版', () => {
    const d = (desc: string, folder: string) => ({ resourceFormat: 'CSV', resourceDescription: desc, resourceDownloadUrl: `https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/${folder}/x.csv` });
    const picked = pickLatestCsv([
      d('114年中華民國政府行政機關辦公日曆表', '202407'),
      d('114年中華民國政府行政機關辦公日曆表_Google行事曆專用', '202407'),
      d('114年中華民國政府行政機關辦公日曆表(1141020更新)', '202510'),
      d('116年中華民國政府行政機關辦公日曆表', '202607'),
    ]);
    expect(picked).toEqual({ 2025: picked[2025], 2027: picked[2027] });
    expect(picked[2025]).toContain('202510');
    expect(picked[2027]).toContain('202607');
  });
});

// ---- 本機啟動，模擬平台呼叫 ----

function es256Jwt(key: KeyObject, claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'test' })}.${b64(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe.each([
  ['taiwan-payroll', 'payroll'],
  ['taiwan-holidays', 'holidays'],
] as const)('本機啟動 %s', (name, key) => {
  const dir = join(root, name);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let jwks: Server;
  let child: ChildProcess;
  let mcpUrl = '';
  let platformUrl = '';

  beforeAll(async () => {
    if (!existsSync(join(dir, 'node_modules'))) {
      execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32' });
    }
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'ES256', use: 'sig' }] }));
    });
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    platformUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    const port = await freePort();
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
    child = spawn(process.execPath, ['--import', 'tsx', 'server.mjs'], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), AGENTHUB_MCP_URL: mcpUrl, AGENTHUB_PLATFORM_URL: platformUrl },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(mcpUrl, { method: 'POST' });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`${name} 沒有在 20 秒內啟動`);
  }, 240_000);

  afterAll(() => {
    child?.kill();
    jwks?.close();
  });

  const token = (aud = mcpUrl) => es256Jwt(privateKey, { iss: platformUrl, aud, exp: Math.floor(Date.now() / 1000) + 300 });
  async function rpc(method: string, params: Record<string, unknown>, t: string | null = token()) {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (t) headers['x-agenthub-token'] = t;
    const res = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: res.status, body: await res.json() };
  }

  it('沒有通行證或 aud 不符都回 401', async () => {
    expect((await rpc('tools/list', {}, null)).status).toBe(401);
    expect((await rpc('tools/list', {}, token('http://other/mcp'))).status).toBe(401);
  });

  it('initialize 與 tools/list', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.status).toBe(200);
    const tools = (await rpc('tools/list', {})).body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(tools).toEqual(
      key === 'payroll'
        ? ['calculate_employer_supplementary_premium', 'calculate_income_tax_withholding', 'calculate_old_age_lump_sum', 'calculate_old_age_pension', 'calculate_old_age_single_payment', 'calculate_payroll', 'calculate_prorated', 'calculate_supplementary_premium', 'list_years']
        : ['add_workdays', 'count_workdays', 'next_makeup_workday', 'optimize_leave'],
    );
  });

  it.each(baseline[key].map((c) => [c.name, JSON.stringify(c.args), c] as const))('與原遠端版一致：%s %s', async (_n, _a, c) => {
    const { body } = await rpc('tools/call', { name: c.name, arguments: c.args });
    const r = body.result ?? { isError: true };
    expect(!!r.isError).toBe(c.isError);
    expect(r.structuredContent ?? null).toEqual(c.structured);
    if (!c.isError) expect(r.content.map((x: { text: string }) => x.text).join('\n')).toBe(c.text);
  });
});

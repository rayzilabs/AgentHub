import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { publicJwk, signCreatorToken } from '@/lib/platform-tokens';
import { verifyPlatformToken } from '@/demo/hosted-mcp/taiwan-law/auth.mjs';
import { testSigningKey } from './helpers';
import { createLy, currentTerm } from '@/demo/hosted-mcp/taiwan-law/ly.mjs';

const PKG = fileURLToPath(new URL('../demo/hosted-mcp/taiwan-law/', import.meta.url));

const pem = testSigningKey;

describe('taiwan-law 代管套件：平台通行證', () => {
  const key = pem();
  const opts = { audience: 'https://law.sprites.app/mcp', issuer: 'https://platform.test', jwks: async () => ({ keys: [publicJwk(key)] }) };
  const token = (claims: Partial<{ iss: string; aud: string }> = {}, signer = key, now = Date.now()) =>
    signCreatorToken({ iss: opts.issuer, aud: opts.audience, sub: 'u', project_id: 'p', template_id: 't', ...claims }, signer, now);

  it('接受平台簽發、aud 與 iss 都對的通行證', async () => {
    await expect(verifyPlatformToken(token(), opts)).resolves.toBeUndefined();
  });

  it('拒絕沒有通行證、別的網址、別的平台、別把鑰匙簽的、過期的通行證', async () => {
    await expect(verifyPlatformToken(undefined, opts)).rejects.toThrow('缺少平台通行證');
    await expect(verifyPlatformToken(token({ aud: 'https://other.sprites.app/mcp' }), opts)).rejects.toThrow(/通行證無效/);
    await expect(verifyPlatformToken(token({ iss: 'https://evil.test' }), opts)).rejects.toThrow(/通行證無效/);
    await expect(verifyPlatformToken(token({}, pem()), opts)).rejects.toThrow(/通行證無效/);
    await expect(verifyPlatformToken(token({}, key, Date.now() - 3600_000), opts)).rejects.toThrow(/通行證無效/);
    await expect(verifyPlatformToken('a.b', opts)).rejects.toThrow(/通行證無效/);
  });

  it('拒絕 alg 不是 ES256 與沒有 exp 的通行證', async () => {
    const [h, p, s] = token().split('.');
    const swap = (part: string, change: object) =>
      Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(part, 'base64url').toString()), ...change })).toString('base64url');
    await expect(verifyPlatformToken(`${swap(h, { alg: 'none' })}.${p}.${s}`, opts)).rejects.toThrow(/通行證無效/);
    const noExp = signCreatorToken({ iss: opts.issuer, aud: opts.audience, sub: 'u', project_id: 'p', template_id: 't' }, key);
    const [nh, np] = noExp.split('.');
    const payload = JSON.parse(Buffer.from(np, 'base64url').toString());
    delete payload.exp;
    await expect(verifyPlatformToken(`${nh}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`, opts)).rejects.toThrow(/通行證無效/);
  });

  it('遇到不認得的 kid 會強制重抓一次公鑰（平台換鑰匙時不用等快取過期）', async () => {
    const calls: boolean[] = [];
    const jwks = async (force?: boolean) => { calls.push(Boolean(force)); return { keys: force ? [publicJwk(key)] : [] }; };
    await expect(verifyPlatformToken(token(), { ...opts, jwks })).resolves.toBeUndefined();
    expect(calls).toEqual([false, true]);
  });

  it('取不到平台公鑰時回 503，不是 401', async () => {
    const e = await verifyPlatformToken(token(), { ...opts, jwks: async () => { throw new Error('timeout'); } }).then(() => null, (x: Error) => x);
    expect(e).toMatchObject({ status: 503 });
    expect(String(e?.message)).toContain('取不到平台公鑰');
  });
});


describe('taiwan-law 代管套件：立法院官方開放資料', () => {
  const bill = (term: string, no: string, name: string, extra: Record<string, string> = {}) => ({
    term, sessionPeriod: '04', sessionTimes: '14', meetingTimes: '', billNo: no, billName: name,
    billOrg: '本院委員王小明等17人', billProposer: '王小明　　', billCosignatory: '李大華　　陳美玲　　', billStatus: '交付審查',
    pdfUrl: `https://ppg.ly.gov.tw/${no}.pdf`, docUrl: `https://ppg.ly.gov.tw/${no}.doc`, ...extra,
  });
  const bills: Record<string, object[]> = {
    11: [bill('11', '202110000001', '「個人資料保護法第二條條文修正草案」，請審議案。'), bill('11', '202110000002', '「勞動基準法第三十條條文修正草案」，請審議案。', { billStatus: '三讀', billProposer: '', billOrg: '行政院' })],
    10: [bill('10', '202010000001', '「個人資料保護法部分條文修正草案」案。', { billStatus: '審查完畢' })],
  };
  const third = [{ docuNo: '1', itemNo: '001', title: '修正個人資料保護法部分條文，咨請公布。', thirdReading: '11-04-08', url: 'https://ppg.ly.gov.tw/a.pdf', note: '' },
    { docuNo: '2', itemNo: '001', title: '修正產業創新條例部分條文，咨請公布。', thirdReading: '11-05-23', url: 'https://ppg.ly.gov.tw/b.pdf', note: '' }];
  const requested: string[] = [];
  const fakeFetch = async (url: string) => {
    requested.push(url);
    const u = new URL(url);
    if (!u.hostname.endsWith('data.ly.gov.tw')) throw new Error(`不該連到 ${u.hostname}`);
    const body = u.pathname.endsWith('ID20Action.action') ? { dataList: bills[u.searchParams.get('term')!] ?? [] } : { jsonList: third };
    return new Response(JSON.stringify(body));
  };
  const now = new Date('2026-11-12T00:00:00+08:00');
  const { searchBills, getLawProgress, getLawVersions } = createLy(fakeFetch, () => now);

  it('依日期算出目前是第幾屆（第 11 屆自 2024 年 2 月起）', () => {
    expect(currentTerm(new Date('2024-01-31T12:00:00+08:00'))).toBe(10);
    expect(currentTerm(now)).toBe(11);
    expect(currentTerm(new Date('2028-02-01T12:00:00+08:00'))).toBe(12);
  });

  it('搜尋議案：只連立法院官方資料，依關鍵字、提案人、狀態篩選，拆開提案人與連署人', async () => {
    const out = await searchBills({ keyword: '個人資料保護法', limit: 10 });
    expect(out.bills.map((b: { bill_no: string }) => b.bill_no)).toEqual(['202110000001', '202010000001']);
    expect(out.bills[0]).toMatchObject({ proposers: ['王小明'], cosignatories: ['李大華', '陳美玲'], status: '交付審查', term: '11', document_pdf: 'https://ppg.ly.gov.tw/202110000001.pdf' });
    expect(out.attribution).toContain('政府資料開放授權條款');
    expect((await searchBills({ keyword: '個人資料保護法', term: 10 })).bills).toHaveLength(1);
    expect((await searchBills({ keyword: '法', billStatus: '三讀' })).bills.map((b: { bill_no: string }) => b.bill_no)).toEqual(['202110000002']);
    expect((await searchBills({ proposer: '行政院' })).bills).toHaveLength(1);
  });

  it('同時進來的查詢共用同一次下載，之後用快取', async () => {
    const before = requested.length;
    const ly = createLy(fakeFetch, () => now);
    await Promise.all([ly.searchBills({ keyword: '法' }), ly.getLawProgress('法'), ly.searchBills({ proposer: '王' })]);
    expect(requested.length - before).toBe(2);
  });

  it('法律的立法歷程：統計各狀態，只列名稱含這部法律的議案', async () => {
    const out = await getLawProgress('個人資料保護法', 1);
    expect(out).toMatchObject({ success: true, law_name: '個人資料保護法', total_bills: 2, status_summary: { 交付審查: 1, 審查完畢: 1 }, truncated: true });
    expect(out.bills).toHaveLength(1);
  });

  it('三讀紀錄：從資料集 373 找名稱含這部法律的三讀條文', async () => {
    const out = await getLawVersions('個人資料保護法', 30);
    expect(out.versions).toEqual([{ title: '修正個人資料保護法部分條文，咨請公布。', third_reading_meeting: '11-04-08', document_pdf: 'https://ppg.ly.gov.tw/a.pdf', note: '' }]);
    expect(out.source_url).toBe('https://data.ly.gov.tw/odw/openDatasetJson.action?id=373&selectTerm=all&page=1');
    expect(requested.every((u) => new URL(u).hostname === 'data.ly.gov.tw')).toBe(true);
  });
});

describe('taiwan-law 代管套件：server.js 的修改', () => {
  const server = readFileSync(`${PKG}server.js`, 'utf8');

  it('不連民間 LYAPI，也不向 legaltech.org.tw 下載資料檔', () => {
    expect(server).not.toContain('ly.govapi.tw');
    expect(server).not.toContain('process.env.ASSET_UPSTREAM');
    expect(server).toContain('import { getLawProgress, getLawVersions, searchBills } from "./ly.mjs";');
  });

  it('/mcp 先驗平台通行證', () => {
    expect(server).toContain('await globalThis.agenthubVerify(req);');
  });
});

describe('taiwan-law 代管套件：實際啟動', () => {
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

  it('沒有通行證回 401；帶平台通行證可以列出工具', async () => {
    const key = pem();
    const platform = createServer((_, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicJwk(key)] })));
    const platformUrl = `http://127.0.0.1:${await listen(platform)}`;
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const child = spawn(process.execPath, ['start.mjs'], { cwd: PKG, env: { ...process.env, PORT: String(port), AGENTHUB_MCP_URL: mcpUrl, AGENTHUB_PLATFORM_URL: platformUrl }, stdio: 'pipe' });
    try {
      const post = (headers: Record<string, string>) => fetch(mcpUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      for (let i = 0; i < 50; i++) {
        if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect((await post({})).status).toBe(401);
      const token = signCreatorToken({ iss: platformUrl, aud: mcpUrl, sub: 'u', project_id: 'p', template_id: 't' }, key);
      const res = await post({ 'x-agenthub-token': token });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
      const names = body.result.tools.map((t: { name: string }) => t.name);
      expect(names).toHaveLength(14);
      expect(names).toEqual(expect.arrayContaining(['search_taiwan_laws', 'search_taiwan_bills', 'get_taiwan_law_progress', 'get_taiwan_law_versions']));
    } finally {
      child.kill();
      platform.close();
    }
  });
});

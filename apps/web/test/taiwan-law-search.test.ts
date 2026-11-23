import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLawArticles, parseLawList, searchByKeyword, splitQuery } from '@/demo/hosted-mcp/taiwan-law/law-search.mjs';

type Row = { name: string; pcode: string; date?: string; abolished?: boolean };
type Law = { name: string; articles: { number: string; text: string; url?: string }[] } & Record<string, unknown>;

// 以下 HTML 片段照 2026-11-23 全國法規資料庫實際頁面
const listPage = (rows: Row[], total = rows.length) => `<li><a href="LawSearchResult.aspx?cur=Ld&ty=ONEBAR&kw=x">法條內容<span class="badge">${total}</span></a></li>
${rows.map((r) => `<tr><td>1.</td><td>
  ${r.abolished ? '<span class="label-fei">廢</span>' : ''}<a id="hlkLawLink" title="${r.name}" href="../Hot/AddHotLaw.ashx?pcode=${r.pcode}&amp;cur=Ld&amp;kw=x">${r.name}</a>
  (民國 ${r.date ?? '113 年 07 月 31 日'} )</td></tr>`).join('')}`;
const article = (pcode: string, no: string, body: string) =>
  `<div class="row"><div class="col-no"> <a href="/LawClass/LawSingle.aspx?pcode=${pcode}&flno=${no}&kw=x">第 ${no} 條</a></div><div class="col-data"><div class="law-article">\n${body}</div>\n</div></div>`;
const contentPage = (body: string, abolished = false) =>
  `<th>法規名稱：</th><td>${abolished ? '<span class="label-fei">廢</span>' : ''}<a id="hlLawName" href="LawAll.aspx?pcode=x">某法</a></td><div class="law-reg-content">${body}</div>`;
const EMPTY = '<th>法規名稱：</th><td><a id="hlLawName">某法</a></td>查無資料。請重新輸入查詢條件！';
const ERROR_PAGE = '<html><title>系統訊息</title></html>';
const SINGLE = 'https://law.moj.gov.tw/LawClass/LawSingle.aspx';

describe('taiwan-law 關鍵字檢索：解析官方頁面', () => {
  it('清單頁：取出名稱、pcode、修正日期，標出已廢止的法規', () => {
    const html = listPage([
      { name: '勞動基準法', pcode: 'N0030001' },
      { name: '事務管理規則', pcode: 'A0030027', date: '94 年 06 月 29 日', abolished: true },
      { name: '民法', pcode: 'B0000001' },
    ]);
    expect(parseLawList(html)).toEqual({
      total: 3,
      laws: [
        { name: '勞動基準法', pcode: 'N0030001', amended: '民國 113 年 07 月 31 日', abolished: false },
        { name: '事務管理規則', pcode: 'A0030027', amended: '民國 94 年 06 月 29 日', abolished: true },
        { name: '民法', pcode: 'B0000001', amended: '民國 113 年 07 月 31 日', abolished: false },
      ],
    });
  });

  it('清單頁：官方回 0 筆是正常結果；錯誤頁或解析不出法規要丟錯', () => {
    expect(parseLawList(listPage([]))).toEqual({ total: 0, laws: [] });
    expect(() => parseLawList(ERROR_PAGE)).toThrow('看不懂');
    expect(() => parseLawList(listPage([], 9))).toThrow('看不懂');
  });

  it('條文頁：各項款換行、去掉標示，附單條官方網址', () => {
    const html = contentPage(
      article('N0030001', '9-1', '<div class="line-0000 show-number">不得為離職後<mark>競業禁止</mark>之約定：</div><div class="line-0004">一、營業利益。</div>')
      + article('N0030001', '15', '<div class="line-0000">第二條&amp;文</div>'));
    expect(parseLawArticles(html)).toEqual({ abolished: false, articles: [
      { number: '第 9-1 條', text: '不得為離職後競業禁止之約定：\n一、營業利益。', url: `${SINGLE}?pcode=N0030001&flno=9-1` },
      { number: '第 15 條', text: '第二條&文', url: `${SINGLE}?pcode=N0030001&flno=15` },
    ] });
  });

  it('條文頁：純文字格式與「本條文有附件」也能解析，並認出已廢止的法規', () => {
    const html = contentPage(
      '<div class="row"><div class="col-no"><i class="fa"></i><span class="sr-only">本條文有附件</span> <a href="/LawClass/LawSingle.aspx?pcode=A0030027&flno=335&kw=x">第 335 條</a></div>'
      + '<div class="col-data text-pre">其<mark>試用期</mark>間\n得停止試用。</div></div>', true);
    expect(parseLawArticles(html)).toEqual({ abolished: true, articles: [
      { number: '第 335 條', text: '其試用期間\n得停止試用。', url: `${SINGLE}?pcode=A0030027&flno=335` },
    ] });
  });

  it('條文頁：「查無資料」是正常的空結果；其他解析不出條文的頁面要丟錯', () => {
    expect(parseLawArticles(EMPTY).articles).toEqual([]);
    expect(() => parseLawArticles(ERROR_PAGE)).toThrow('看不懂');
  });
});

describe('taiwan-law 關鍵字檢索：拆出法規名稱與關鍵字', () => {
  const data = {
    pcode_map: {
      勞動基準法: 'N0030001', 職業安全衛生法: 'N0060001', 民法: 'B0000001', 公司法: 'J0080001',
      採購申訴審議規則: 'A0030070', 勞工請假規則: 'N0030006', 勞動基準法施行細則: 'N0030002', 舊事法: 'X1',
    },
    abolished_set: ['X1'],
  };
  const split = (q: string) => splitQuery(q, data, { 勞基法: '勞動基準法' });

  it('法規名稱（含簡稱、省略「法」「規則」）沒有其他詞：只有法規', () => {
    expect(split('勞動基準法')).toEqual({ law: { name: '勞動基準法', pcode: 'N0030001' }, terms: [] });
    expect(split('勞基法')).toEqual({ law: { name: '勞動基準法', pcode: 'N0030001' }, terms: [] });
    expect(split('勞工請假')).toEqual({ law: { name: '勞工請假規則', pcode: 'N0030006' }, terms: [] });
  });

  it('法規名稱加關鍵字：有沒有空白、誰先誰後都拆得開，取最長的名稱', () => {
    const osh = { law: { name: '職業安全衛生法', pcode: 'N0060001' }, terms: ['申訴'] };
    expect(split('職業安全衛生法 申訴')).toEqual(osh);
    expect(split('申訴 職業安全衛生法')).toEqual(osh);
    expect(split('職業安全衛生法申訴')).toEqual(osh);
    expect(split('勞動基準法施行細則 競業禁止')).toEqual({ law: { name: '勞動基準法施行細則', pcode: 'N0030002' }, terms: ['競業禁止'] });
    expect(split('勞基法資遣費')).toEqual({ law: { name: '勞動基準法', pcode: 'N0030001' }, terms: ['資遣費'] });
  });

  it('只是某部法規名稱的一部分，不當成指定那部法規', () => {
    expect(split('申訴')).toEqual({ law: null, terms: ['申訴'] });
    expect(split('公司法人')).toEqual({ law: null, terms: ['公司法人'] });
    expect(split('定型化契約，審閱期')).toEqual({ law: null, terms: ['定型化契約', '審閱期'] });
  });

  it('省略字尾時不猜已廢止的法規', () => {
    expect(split('舊事')).toEqual({ law: null, terms: ['舊事'] });
  });
});

describe('taiwan-law 關鍵字檢索：查詢', () => {
  const index = { update_date: '2026-11-13', laws: [
    { n: '公司法', p: 'J0080001', d: '2025-12-26', a: [['第 1 條', '公司定義']] },
    { n: '勞動基準法', p: 'N0030001', d: '2024-07-31', a: [['第 9-1 條', '離職後競業禁止之約定'], ['第 17 條', '資遣費']] },
    { n: '勞動基準法施行細則', p: 'N0030002', d: '2024-01-01', a: [['第 7-1 條', '競業禁止'], ['第 7-2 條', '競業禁止、競業禁止'], ['第 7-3 條', '競業禁止']] },
    { n: '勞動契約法', p: 'N0030010', d: '1936-12-25', e: '施行日期以命令定之。', a: [['第 14 條', '特約']] },
  ] };
  const rows: Row[] = [
    { name: '公司法', pcode: 'J0080001' }, { name: '勞動基準法', pcode: 'N0030001' },
    { name: '工廠法', pcode: 'N0030007', abolished: true }, { name: '勞動基準法施行細則', pcode: 'N0030002' },
  ];
  const contents: Record<string, string> = {
    J0080001: contentPage(article('J0080001', '120', '同類營業')),
    N0030001: contentPage(article('N0030001', '9-1', '離職後競業禁止')),
    N0030002: contentPage(['7-1', '7-2', '7-3'].map((n) => article('N0030002', n, '競業禁止')).join('')),
    N0030007: contentPage(article('N0030007', '1', '競業禁止'), true),
  };
  type Over = {
    list?: string | Error; contents?: Record<string, string | Error>; law?: { name: string; pcode: string };
    terms?: string[]; limit?: number; index?: null; abolished?: string[];
  };
  const run = async (over: Over = {}) => {
    const urls: string[] = [];
    const out = await searchByKeyword({
      law: over.law ?? null, terms: over.terms ?? ['競業禁止'], limit: over.limit ?? 3, abolished: over.abolished ?? [],
      loadIndex: async () => { if (over.index === null) throw new Error('沒有檔案'); return index; },
      fetchHtml: async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        if (u.hostname !== 'law.moj.gov.tw') throw new Error(`不該連到 ${u.hostname}`);
        const page = u.pathname.endsWith('LawSearchResult.aspx')
          ? over.list ?? listPage(rows) : (over.contents ?? contents)[u.searchParams.get('pcode')!] ?? EMPTY;
        if (page instanceof Error) throw page;
        return page;
      },
      deadline: Date.now() + 5000,
    });
    return { out: out as { results: Law[]; note?: string; unavailable?: object[]; other_laws?: Law[] } & Record<string, unknown>, urls };
  };
  const names = (laws: Law[] = []) => laws.map((l) => l.name);
  const numbers = (l: Law) => l.articles.map((a) => a.number);

  it('找到相關條文：提到最多次的法規排前面，排除已廢止的，每條附官方網址與修正日期', async () => {
    const { out, urls } = await run();
    expect(names(out.results)).toEqual(['勞動基準法施行細則', '勞動基準法', '公司法']);
    expect(numbers(out.results[0])).toEqual(['第 7-1 條', '第 7-2 條', '第 7-3 條']);
    expect(out.results[1]).toMatchObject({
      pcode: 'N0030001', amended_date: '民國 113 年 07 月 31 日', url: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0030001',
      articles: [{ number: '第 9-1 條', url: `${SINGLE}?pcode=N0030001&flno=9-1` }],
    });
    expect(out.results.every((l) => l.data_date === undefined)).toBe(true);
    expect(out.retrieved_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(out.total_laws).toBe(3);
    expect(new URL(urls[0]).searchParams.get('kw')).toBe('競業禁止');
    expect(urls.some((u) => u.includes('N0030007'))).toBe(false);
  });

  it('只抓 limit 部的條文，其餘命中的法規列出名稱', async () => {
    const { out, urls } = await run({ limit: 1 });
    expect(names(out.results)).toEqual(['勞動基準法施行細則']);
    expect(urls).toHaveLength(2);
    expect(names(out.other_laws)).toEqual(['勞動基準法', '公司法']);
  });

  it('平台的廢止清單裡的法規也排除', async () => {
    const { out } = await run({ abolished: ['J0080001'] });
    expect(names(out.results)).toEqual(['勞動基準法施行細則', '勞動基準法']);
  });

  it('有生效註記的法規（例如尚未施行）附上註記與註記的資料日期', async () => {
    const { out } = await run({
      list: listPage([{ name: '勞動契約法', pcode: 'N0030010' }]), contents: { N0030010: contentPage(article('N0030010', '14', '競業禁止')) },
    });
    expect(out.results[0]).toMatchObject({ effective_note: '施行日期以命令定之。', effective_note_date: '2026-11-13' });
  });

  it('清單超過一頁時，本地索引找到的法規也列入候選', async () => {
    const { out } = await run({ list: listPage(rows.slice(0, 1), 103) });
    expect(names(out.results)).toEqual(['勞動基準法施行細則', '勞動基準法', '公司法']);
  });

  it('一部法規命中很多條：只回 6 條，優先留提到最多次的，並說明總數', async () => {
    const many = Array.from({ length: 8 }, (_, i) => article('N0030001', String(i + 1), i === 7 ? '競業禁止競業禁止' : '競業禁止')).join('');
    const { out } = await run({ list: listPage([rows[1]]), contents: { N0030001: contentPage(many) } });
    expect(numbers(out.results[0])).toEqual(['第 1 條', '第 2 條', '第 3 條', '第 4 條', '第 5 條', '第 8 條']);
    expect(out.results[0].matched_articles).toBe(8);
  });

  it('指定法規：只查那一部，用剩下的詞', async () => {
    const { out, urls } = await run({
      law: { name: '職業安全衛生法', pcode: 'N0060001' }, terms: ['申訴'], contents: { N0060001: contentPage(article('N0060001', '39', '工作者得申訴')) },
    });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('kw')).toBe('申訴');
    expect(numbers(out.results[0])).toEqual(['第 39 條']);
  });

  it('指定的法規已廢止：標示出來', async () => {
    const { out } = await run({ law: { name: '工廠法', pcode: 'N0030007' } });
    expect(out.results[0].abolished).toBe(true);
    expect(out.note).toContain('已廢止');
  });

  it('官方查無結果：回空結果與說明，不退回前 6 條、也不用本地資料', async () => {
    const none = await run({ list: listPage([]) });
    expect(none.out.results).toEqual([]);
    expect(none.out.note).toContain('沒有條文');
    const inLaw = await run({ law: { name: '勞動基準法', pcode: 'N0030001' }, contents: {} });
    expect(inLaw.out.results).toEqual([]);
    expect(inLaw.out.note).toContain('勞動基準法');
  });

  it.each([['連不上', new Error('timeout')], ['改版', ERROR_PAGE]])('官方清單%s：改用本地索引，標示資料日期與範圍，附官方網址', async (_, list) => {
    const { out } = await run({ list, limit: 2 });
    expect(names(out.results)).toEqual(['勞動基準法施行細則', '勞動基準法']);
    expect(out.results[1]).toMatchObject({
      data_date: '2026-11-13', amended_date: '2024-07-31', articles: [{ number: '第 9-1 條', url: `${SINGLE}?pcode=N0030001&flno=9-1` }],
    });
    expect(out.note).toContain('2026-11-13');
    expect(out.note).toContain('勞動部');
    expect(out.retrieved_at).toBeUndefined();
  });

  it('單部條文頁失敗：有本地資料就用本地的並標日期，沒有就列為暫時取不到', async () => {
    const { out } = await run({
      list: listPage([rows[1], { name: '銀行法', pcode: 'G0380001' }]), contents: { N0030001: new Error('timeout'), G0380001: new Error('timeout') },
    });
    expect(out.results).toMatchObject([{ name: '勞動基準法', data_date: '2026-11-13' }]);
    expect(out.note).toContain('2026-11-13');
    expect(out.unavailable).toMatchObject([{ pcode: 'G0380001', url: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0380001' }]);
  });

  it('指定法規的條文頁失敗：用本地那一部', async () => {
    const { out } = await run({ law: { name: '勞動基準法', pcode: 'N0030001' }, contents: { N0030001: new Error('timeout') } });
    expect(out.results).toMatchObject([{ name: '勞動基準法', data_date: '2026-11-13', articles: [{ number: '第 9-1 條' }] }]);
  });

  it('官方與本地都失敗：丟出清楚的錯誤', async () => {
    await expect(run({ list: new Error('timeout'), index: null })).rejects.toThrow(/全國法規資料庫.*timeout/);
  });

  it('本地索引壞掉不影響官方結果', async () => {
    const { out } = await run({ index: null });
    expect(names(out.results)).toEqual(['公司法', '勞動基準法', '勞動基準法施行細則']);
  });
});

describe('taiwan-law 關鍵字檢索：接到 server.js', () => {
  it('沒帶條號的關鍵字查詢走 law-search.mjs，並讀條文索引', () => {
    const server = readFileSync(fileURLToPath(new URL('../demo/hosted-mcp/taiwan-law/server.js', import.meta.url)), 'utf8');
    expect(server).toContain('import { searchByKeyword, splitQuery } from "./law-search.mjs";');
    expect(server).toContain('await searchByKeyword({');
    expect(server).toContain('loadLegalData("law-articles.json"');
  });
});

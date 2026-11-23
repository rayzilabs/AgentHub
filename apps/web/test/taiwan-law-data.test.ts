import { describe, expect, it } from 'vitest';
import { buildArticles, buildHistories, buildIndex, buildPcodeAll, checkCounts, parseConsPage } from '@/scripts/taiwan-law-data';

const law = (name: string, pcode: string, extra: Record<string, string> = {}) => ({
  LawName: name, LawURL: `https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=${pcode}`, LawAbandonNote: '', LawHistories: `${name}沿革`, ...extra,
});

describe('taiwan-law 資料檔：法務部開放資料', () => {
  const laws = [law('民法', 'B0000001'), law('動員戡亂時期臨時條款', 'A0000005', { LawAbandonNote: '廢' })];
  const orders = [law('個人資料保護法施行細則', 'I0050022'), law('某某辦法', '0000001')];

  it('名稱對 pcode、廢止清單與件數，日期用法務部資料的更新日', () => {
    expect(buildPcodeAll(laws, orders, '2026/10/30 上午 12:00:00')).toEqual({
      version: 2, update_date: '2026-10-30', law_count: 2, order_count: 2, abolished_count: 1, total: 4,
      pcode_map: { 民法: 'B0000001', 動員戡亂時期臨時條款: 'A0000005', 個人資料保護法施行細則: 'I0050022', 某某辦法: '0000001' },
      abolished_set: ['A0000005'],
    });
  });

  it('沿革依 pcode 第一個英文字母分檔，數字開頭的放 0', () => {
    expect(buildHistories([...laws, ...orders])).toEqual({
      B: { B0000001: '民法沿革' }, A: { A0000005: '動員戡亂時期臨時條款沿革' }, I: { I0050022: '個人資料保護法施行細則沿革' }, 0: { '0000001': '某某辦法沿革' },
    });
  });
});

describe('taiwan-law 資料檔：條文索引', () => {
  const item = (name: string, pcode: string, extra: object = {}) => ({
    ...law(name, pcode), LawCategory: '行政＞勞動部＞勞動條件及就業平等目', LawModifiedDate: '20240731', LawEffectiveNote: '',
    LawArticles: [{ ArticleType: 'C', ArticleNo: '', ArticleContent: '第 一 章 總則' }, { ArticleType: 'A', ArticleNo: '第 1 條', ArticleContent: '第一項。\r\n第二項。' }], ...extra,
  });

  it('收現行法律與勞動部主管的現行命令，只留條文，附資料日期、修正日期與生效註記', () => {
    const out = buildArticles(
      [item('勞動契約法', 'N0030010', { LawEffectiveNote: '施行日期以命令\r\n  定之。' }), item('工廠法', 'N0030007', { LawAbandonNote: '廢' })],
      [item('勞動基準法施行細則', 'N0030002'), item('某某辦法', 'G0000001', { LawCategory: '行政＞財政部＞關務目' }), item('舊細則', 'N1', { LawAbandonNote: '廢', LawCategory: '廢止法規＞勞動部' })],
      '2026/11/13 上午 12:00:00', { laws: 1, orders: 1 },
    );
    expect(out).toEqual({ update_date: '2026-11-13', laws: [
      { n: '勞動契約法', p: 'N0030010', d: '2024-07-31', e: '施行日期以命令定之。', a: [['第 1 條', '第一項。\n第二項。']] },
      { n: '勞動基準法施行細則', p: 'N0030002', d: '2024-07-31', a: [['第 1 條', '第一項。\n第二項。']] },
    ] });
  });

  it('筆數太少時中止，不產生索引', () => {
    expect(() => buildArticles([item('民法', 'B0000001')], [], '2026/11/13 上午 12:00:00')).toThrow('筆數不足');
  });
});

const field = (title: string, inner: string) => `<ul class="flex"><li class="title">${title}</li><li class="text" title="${title}">${inner}</li></ul>`;
const page = (fields: string, next?: string) => `<html><body><div class="btn_list"><span>第1筆</span>${next ? `<a class="next" href="${next}">▶</a>` : ''}</div>
<div class="lawPage">${fields}</div><!--Article_End--></body></html>`;

describe('taiwan-law 資料檔：憲法法庭網站', () => {
  it('釋字頁：解析字號、日期、爭點、解釋文、理由書、相關法令（去重）、意見書，並找出下一筆', () => {
    const html = page(
      field('解釋字號', ' 釋字第748號【同性二人婚姻自由案】') + field('解釋公布院令', ' 中華民國 106年05月24日 ')
      + field('解釋爭點', '<ul class="num-list"><li>是否違憲？ </li></ul>')
      + field('解釋文', '<ul class="paragraphs"><li><label>1</label><pre title="解釋文"> 第一段。 </pre></li><li><label></label><pre title="解釋文">第二段&#20737;</pre></li></ul>')
      + field('理由書', '<pre>理由內容</pre>')
      + field('相關法令', '<div class="lawLinkList"><a>憲法第7條(36.01.01)</a><a>憲法第7條(36.01.01)</a><a>民法第972條</a></div>')
      + field('意見書、抄本等文件', '<a><strong>釋字第748號解釋_OCR</strong></a><a><strong>黃大法官協同意見書</strong></a>'),
      '/docdata.aspx?fid=100&amp;id=310930',
    );
    const out = parseConsPage(html, 'https://cons.judicial.gov.tw/docdata.aspx?fid=100&id=310929');
    expect(out).toEqual({
      kind: 'old', key: '748', next: 'https://cons.judicial.gov.tw/docdata.aspx?fid=100&id=310930',
      case: {
        case_number: '釋字第748號【同性二人婚姻自由案】', date: '中華民國 106年05月24日', issues: '是否違憲？',
        main_text: '第一段。\n第二段儁', main_text_truncated: false, related_statutes: '憲法第7條(36.01.01)\n民法第972條',
        has_reasoning: true, has_opinions: true, reasoning: '理由內容', opinions: '黃大法官協同意見書',
        source_url: 'https://cons.judicial.gov.tw/docdata.aspx?fid=100&id=310929',
      },
    });
  });

  it('較新的釋字頁把意見書放在「意見書」欄位', () => {
    const html = page(field('解釋字號', '釋字第800號') + field('意見書', '<a><strong>甲大法官提出之協同意見書</strong></a><a><strong>聲請書_OCR</strong></a>'));
    expect(parseConsPage(html, 'https://cons.judicial.gov.tw/docdata.aspx?fid=100&id=1').case).toMatchObject({ has_opinions: true, opinions: '甲大法官提出之協同意見書' });
  });

  it('憲判字頁：以「年_號」為鍵，最後一筆沒有下一筆', () => {
    const html = page(
      field('判決字號', '115年憲判字第3號【少年保護事件禁止再行移送案】') + field('判決日期', '115年03月27日') + field('聲請人', '某法官')
      + field('案由', '<ul class="num-list"><li>聲請法規範憲法審查。</li></ul>') + field('主文', '<pre>主文內容</pre>') + field('理由', '<pre>理由</pre>')
      + field('判決摘要', '<pre>摘要</pre>') + field('相關法令', '<a>少年事件處理法第15條</a>'),
    );
    const out = parseConsPage(html, 'https://cons.judicial.gov.tw/docdata.aspx?fid=38&id=358150');
    expect(out).toMatchObject({ kind: 'new', key: '115_3', next: null });
    expect(out?.case).toEqual({
      case_number: '115年憲判字第3號【少年保護事件禁止再行移送案】', date: '115年03月27日', petitioner: '某法官', issue_summary: '聲請法規範憲法審查。',
      main_text: '主文內容', main_text_truncated: false, summary: '摘要', summary_truncated: false, related_statutes: '少年事件處理法第15條',
      has_reasoning: true, has_opinions: false, reasoning: '理由', opinions: '', source_url: 'https://cons.judicial.gov.tw/docdata.aspx?fid=38&id=358150',
    });
  });

  it('不是釋字也不是憲判字的頁面（例如裁定）回傳 null 但保留下一筆', () => {
    const out = parseConsPage(page(field('判決字號', '113年憲裁字第1號'), '/docdata.aspx?fid=38&id=2'), 'https://cons.judicial.gov.tw/docdata.aspx?fid=38&id=1');
    expect(out).toEqual({ kind: null, key: null, case: null, next: 'https://cons.judicial.gov.tw/docdata.aspx?fid=38&id=2' });
  });

  it('索引只放字號與爭點', () => {
    expect(buildIndex({ 1: { case_number: '釋字第1號', issues: '爭點', main_text: '長文' } }, { '111_1': { case_number: '111年憲判字第1號', issue_summary: '案由', main_text: '長文' } }))
      .toEqual({ old: { 1: { case_number: '釋字第1號', issues: '爭點' } }, new: { '111_1': { case_number: '111年憲判字第1號', issue_summary: '案由' } } });
  });
});

describe('taiwan-law 資料檔：寫檔前的筆數檢查', () => {
  const ok = { laws: 1351, orders: 10454, oldCases: 813, newCases: 59 };

  it('筆數都夠就通過', () => {
    expect(() => checkCounts(ok)).not.toThrow();
  });

  it('任何一種資料太少就整批中止，並說是哪一種', () => {
    expect(() => checkCounts({ ...ok, newCases: 0 })).toThrow(/憲判字只有 0 號/);
    expect(() => checkCounts({ ...ok, oldCases: 800 })).toThrow(/釋字只有 800 號/);
    expect(() => checkCounts({ ...ok, laws: 10 })).toThrow(/法律只有 10 部/);
    expect(() => checkCounts({ ...ok, orders: 10 })).toThrow(/命令只有 10 部/);
  });
});

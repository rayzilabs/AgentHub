// 立法歷程三個工具：改接立法院開放資料服務平台（data.ly.gov.tw），取代原程式使用的民間 LYAPI。
// 資料集 20「議案提案」每天 04:15 更新、只能整屆下載（第 11 屆約 6 MB），所以整屆抓下來在記憶體篩選並快取。
import { constants } from 'node:crypto';
import { get } from 'node:https';

const LY = 'https://data.ly.gov.tw/odw';
const TTL_MS = 6 * 3600_000;
const attribution = () =>
  `立法院 ${new Date().getFullYear()} 立法院開放資料服務平台；此開放資料依政府資料開放授權條款（Open Government Data License）進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。條款：https://data.gov.tw/license`;

/** data.ly.gov.tw 只支援舊式 TLS 重新協商，Node 內建 fetch 會拒絕；只對這個網站放寬 */
export function lyFetch(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT, headers: { accept: 'application/json' }, timeout: 60_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('立法院開放資料平台逾時')));
    req.on('error', reject);
  });
}

/** 第 11 屆自 2024-02-01 起，每屆四年 */
export function currentTerm(date = new Date()) {
  const tw = new Date(date.getTime() + 8 * 3600_000);
  const months = (tw.getUTCFullYear() - 2024) * 12 + tw.getUTCMonth() - 1;
  return 11 + Math.floor(months / 48);
}

const BILLS_SOURCE = '立法院開放資料平台（議案提案，資料集 20）';
const THIRD_READING_URL = `${LY}/openDatasetJson.action?id=373&selectTerm=all&page=1`;
const billsUrl = (term) =>
  `${LY}/ID20Action.action?term=${term}&sessionPeriod=&sessionTimes=&meetingTimes=&billName=&billOrg=&billProposer=&billCosignatory=&fileType=json`;
const names = (s) => (s ?? '').split(/[\s　]+/).filter(Boolean);
const toBill = (b) => ({
  bill_no: b.billNo ?? '',
  title: b.billName ?? '',
  proposing_unit: b.billOrg ?? '',
  proposers: names(b.billProposer),
  cosignatories: names(b.billCosignatory),
  status: b.billStatus ?? '',
  term: b.term ?? '',
  session: b.sessionPeriod ?? '',
  session_times: b.sessionTimes ?? '',
  document_pdf: b.pdfUrl ?? '',
  document_doc: b.docUrl ?? '',
});
// 議案編號是等長數字字串，直接比較即可；新的在前
const newestFirst = (a, b) => (a.bill_no < b.bill_no ? 1 : a.bill_no > b.bill_no ? -1 : 0);

/**
 * 只快取本屆、上一屆與三讀資料集（整理成回傳用的欄位、排好序），過期就清掉；
 * 同時進來的請求共用同一次下載。查更早的屆別不快取。
 */
export function createLy(fetchFn = lyFetch, now = () => new Date()) {
  const cache = new Map();

  async function fetchJson(url) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`立法院開放資料平台回應 ${res.status}`);
    // 平台在 JSON 前面會多送空白行
    return JSON.parse((await res.text()).trim());
  }

  function cached(url, load) {
    for (const [key, entry] of cache) if (Date.now() - entry.at >= TTL_MS) cache.delete(key);
    const hit = cache.get(url);
    if (hit) return hit.value;
    const value = fetchJson(url).then(load);
    cache.set(url, { at: Date.now(), value });
    value.catch(() => cache.delete(url));
    return value;
  }

  const loadBills = (d) => (d.dataList ?? []).map(toBill).sort(newestFirst);
  const billsOf = (term) => (term >= currentTerm(now()) - 1 ? cached(billsUrl(term), loadBills) : fetchJson(billsUrl(term)).then(loadBills));

  /** 沒指定屆別時查本屆與上一屆 */
  async function recentBills(term) {
    const terms = term ? [term] : [currentTerm(now()), currentTerm(now()) - 1];
    const lists = await Promise.all(terms.map(billsOf));
    return { terms, bills: lists.flat() };
  }

  /** @param {{ keyword?: string, proposer?: string, term?: number, billStatus?: string, limit?: number }} opts */
  async function searchBills({ keyword = '', proposer = '', term, billStatus = '', limit = 10 }) {
    const { terms, bills } = await recentBills(term);
    const kw = keyword.trim();
    const who = proposer.trim();
    const matched = bills.filter((b) =>
      (!kw || b.title.includes(kw))
      && (!who || b.proposers.some((n) => n.includes(who)) || b.proposing_unit.includes(who))
      && (!billStatus || b.status === billStatus));
    const max = Math.min(limit, 50);
    return {
      success: true,
      terms_searched: terms,
      total: matched.length,
      bills: matched.slice(0, max),
      truncated: matched.length > max,
      source: BILLS_SOURCE,
      source_url: billsUrl(terms[0]),
      attribution: attribution(),
    };
  }

  async function getLawProgress(law, maxBills = 10) {
    const name = law.trim();
    const { terms, bills } = await recentBills();
    const matched = bills.filter((b) => b.title.includes(name));
    const status_summary = {};
    for (const b of matched) status_summary[b.status || '未標示'] = (status_summary[b.status || '未標示'] ?? 0) + 1;
    return {
      success: true,
      law_name: name,
      terms_searched: terms,
      total_bills: matched.length,
      status_summary,
      bills: matched.slice(0, maxBills),
      truncated: matched.length > maxBills,
      source: BILLS_SOURCE,
      source_url: billsUrl(terms[0]),
      attribution: attribution(),
      note: '只查本屆與上一屆、名稱含這部法律的議案；關係文書連結為立法院官方文件（ppg.ly.gov.tw），引用前請開啟核對。',
    };
  }

  async function getLawVersions(law, limit = 30) {
    const name = law.trim();
    const rows = await cached(THIRD_READING_URL, (d) => (d.jsonList ?? []).map((r) => ({
      title: r.title ?? '', third_reading_meeting: r.thirdReading ?? '', document_pdf: r.url ?? '', note: r.note ?? '',
    })));
    const matched = rows.filter((r) => r.title.includes(name));
    return {
      success: true,
      law_name: name,
      total: matched.length,
      versions: matched.slice(0, limit),
      truncated: matched.length > limit,
      source: '立法院開放資料平台（三讀通過條文＆附帶決議，資料集 373）',
      source_url: THIRD_READING_URL,
      attribution: attribution(),
      note: '本資料集只有 2023 年起的三讀紀錄（third_reading_meeting 為「屆-會期-會次」）；完整修正沿革請用 search_taiwan_laws 查全國法規資料庫的沿革。',
    };
  }

  return { searchBills, getLawProgress, getLawVersions };
}

// server.js 匯入的三個工具
export const { searchBills, getLawProgress, getLawVersions } = createLy();

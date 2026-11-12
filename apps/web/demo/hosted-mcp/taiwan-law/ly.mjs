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

const caches = new WeakMap();
async function getJson(url, fetchFn) {
  if (!caches.has(fetchFn)) caches.set(fetchFn, new Map());
  const cache = caches.get(fetchFn);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`立法院開放資料平台回應 ${res.status}`);
  // 平台在 JSON 前面會多送空白行
  const value = JSON.parse((await res.text()).trim());
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** 第 11 屆自 2024-02-01 起，每屆四年 */
export function currentTerm(date = new Date()) {
  const tw = new Date(date.getTime() + 8 * 3600_000);
  const months = (tw.getUTCFullYear() - 2024) * 12 + tw.getUTCMonth() - 1;
  return 11 + Math.floor(months / 48);
}

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

/** 沒指定屆別時查本屆與上一屆 */
async function loadBills(term, now, fetchFn) {
  const terms = term ? [term] : [currentTerm(now), currentTerm(now) - 1];
  const lists = await Promise.all(terms.map((t) => getJson(billsUrl(t), fetchFn).then((d) => d.dataList ?? [])));
  return { terms, bills: lists.flat().sort((a, b) => String(b.billNo).localeCompare(String(a.billNo))) };
}

/** @param {{ keyword?: string, proposer?: string, term?: number, billStatus?: string, limit?: number, now?: Date }} opts */
export async function searchBills({ keyword = '', proposer = '', term, billStatus = '', limit = 10, now = new Date() }, fetchFn = lyFetch) {
  const { terms, bills } = await loadBills(term, now, fetchFn);
  const kw = keyword.trim();
  const who = proposer.trim();
  const matched = bills.filter((b) =>
    (!kw || (b.billName ?? '').includes(kw))
    && (!who || (b.billProposer ?? '').includes(who) || (b.billOrg ?? '').includes(who))
    && (!billStatus || b.billStatus === billStatus));
  const max = Math.min(limit, 50);
  return {
    success: true,
    terms_searched: terms,
    total: matched.length,
    bills: matched.slice(0, max).map(toBill),
    truncated: matched.length > max,
    source: '立法院開放資料平台（議案提案，資料集 20）',
    source_url: billsUrl(terms[0]),
    attribution: attribution(),
  };
}

export async function getLawProgress(law, maxBills = 10, fetchFn = lyFetch, now = new Date()) {
  const name = law.trim();
  const { terms, bills } = await loadBills(undefined, now, fetchFn);
  const matched = bills.filter((b) => (b.billName ?? '').includes(name));
  const status_summary = {};
  for (const b of matched) status_summary[b.billStatus || '未標示'] = (status_summary[b.billStatus || '未標示'] ?? 0) + 1;
  return {
    success: true,
    law_name: name,
    terms_searched: terms,
    total_bills: matched.length,
    status_summary,
    bills: matched.slice(0, maxBills).map(toBill),
    truncated: matched.length > maxBills,
    source: '立法院開放資料平台（議案提案，資料集 20）',
    source_url: billsUrl(terms[0]),
    attribution: attribution(),
    note: '只查本屆與上一屆、名稱含這部法律的議案；關係文書連結為立法院官方文件（ppg.ly.gov.tw），引用前請開啟核對。',
  };
}

const THIRD_READING_URL = `${LY}/openDatasetJson.action?id=373&selectTerm=all&page=1`;

export async function getLawVersions(law, limit = 30, fetchFn = lyFetch) {
  const name = law.trim();
  const data = await getJson(THIRD_READING_URL, fetchFn);
  const matched = (data.jsonList ?? []).filter((r) => (r.title ?? '').includes(name));
  return {
    success: true,
    law_name: name,
    total: matched.length,
    versions: matched.slice(0, limit).map((r) => ({ title: r.title ?? '', third_reading_meeting: r.thirdReading ?? '', document_pdf: r.url ?? '', note: r.note ?? '' })),
    truncated: matched.length > limit,
    source: '立法院開放資料平台（三讀通過條文＆附帶決議，資料集 373）',
    source_url: THIRD_READING_URL,
    attribution: attribution(),
    note: '本資料集只有 2023 年起的三讀紀錄（third_reading_meeting 為「屆-會期-會次」）；完整修正沿革請用 search_taiwan_laws 查全國法規資料庫的沿革。',
  };
}

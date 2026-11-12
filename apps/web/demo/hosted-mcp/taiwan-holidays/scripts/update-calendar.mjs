// 從政府資料開放平台「中華民國政府行政機關辦公日曆表」（資料集 14718，人事行政總處提供）
// 下載各年度 CSV，轉成 data/<西元年>.json。
// 用法：node scripts/update-calendar.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATASET_API = 'https://data.gov.tw/api/v2/rest/dataset/14718';
const HEADERS = { 'user-agent': 'Mozilla/5.0' };

/** 每個民國年只取最新一份（依下載網址裡的 dgpa/files/<年月> 判斷），不要 Google 行事曆專用版。回傳 { 西元年: 網址 } */
export function pickLatestCsv(distributions) {
  const best = {};
  for (const d of distributions) {
    if (d.resourceFormat?.toUpperCase() !== 'CSV' || d.resourceDescription.includes('Google')) continue;
    const roc = /(\d{3})年/.exec(d.resourceDescription);
    if (!roc) continue;
    const year = Number(roc[1]) + 1911;
    const stamp = /dgpa\/files\/(\d{6})/.exec(d.resourceDownloadUrl)?.[1] ?? '';
    if (!best[year] || stamp > best[year].stamp) best[year] = { stamp, url: d.resourceDownloadUrl };
  }
  return Object.fromEntries(Object.entries(best).map(([y, v]) => [y, v.url]));
}

/** 官方 CSV（欄位：西元日期,星期,是否放假,備註；2 是放假、0 是上班）。舊年度是 Big5，新年度是 UTF-8 BOM（TextDecoder 會去掉 BOM） */
export function parseCalendarCsv(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('big5').decode(bytes);
  }
  return text
    .split(/\r?\n/)
    .filter((line) => /^\d{8},/.test(line)) // 只留資料列，標題列與空行都會被濾掉
    .map((line) => {
      const [date, week, off, ...note] = line.split(',');
      return { date, week, isHoliday: off.trim() === '2', description: note.join(',').trim() };
    });
}

async function main() {
  const res = await fetch(DATASET_API, { headers: HEADERS });
  if (!res.ok) throw new Error(`資料集 API 回 ${res.status}`);
  const urls = pickLatestCsv((await res.json()).result.distribution);
  for (const [year, url] of Object.entries(urls)) {
    const csv = await fetch(url, { headers: HEADERS });
    if (!csv.ok) throw new Error(`${year} 年 CSV 回 ${csv.status}：${url}`);
    const days = parseCalendarCsv(new Uint8Array(await csv.arrayBuffer()));
    const expected = new Date(Number(year), 1, 29).getMonth() === 1 ? 366 : 365;
    if (days.length !== expected || !days.every((d) => d.date.startsWith(year))) {
      throw new Error(`${year} 年資料有 ${days.length} 天，應為 ${expected} 天，請檢查官方檔案：${url}`);
    }
    writeFileSync(fileURLToPath(new URL(`../data/${year}.json`, import.meta.url)), `${JSON.stringify(days, null, 1)}\n`);
    console.log(`${year}：${days.filter((d) => d.isHoliday).length} 天放假`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

// 讀 data/<西元年>.json（scripts/update-calendar.mjs 從政府資料開放平台產生）。年度依檔案自動決定。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Calendar } from './engine/types';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));

export function loadCalendars(): Record<number, Calendar> {
  // 年份當物件鍵時本來就由小到大排列
  const years = readdirSync(dataDir).flatMap((name) => /^(\d{4})\.json$/.exec(name)?.[1] ?? []);
  return Object.fromEntries(years.map((y) => [y, JSON.parse(readFileSync(`${dataDir}${y}.json`, 'utf8')) as Calendar]));
}

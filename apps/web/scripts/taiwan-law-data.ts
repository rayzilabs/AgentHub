// 重新產生代管 taiwan-law MCP 的資料檔（apps/web/demo/hosted-mcp/taiwan-law/data/legal-data/）。
// 用法：cd apps/web && node scripts/taiwan-law-data.ts（約 80 分鐘）
// 資料來源都是官方：法務部全國法規資料庫開放 API（法規名稱、pcode、沿革）、憲法法庭網站（釋字、憲判字）。
// 每月跑一次，或重大修法、新憲判字公布後跑；跑完 commit，再跑 seed-business-agents.ts 部署新版本。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

type MojLaw = { LawName: string; LawURL: string; LawAbandonNote: string; LawHistories: string };
type Case = Record<string, string | boolean>;

const pcodeOf = (law: MojLaw) => new URL(law.LawURL).searchParams.get('pcode') ?? new URL(law.LawURL).searchParams.get('PCode') ?? '';

/** 「2026/10/30 上午 12:00:00」→「2026-10-30」 */
const isoDate = (s: string) => {
  const [y, m, d] = s.split(' ')[0].split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

export function buildPcodeAll(laws: MojLaw[], orders: MojLaw[], updateDate: string) {
  const all = [...laws, ...orders];
  const abolished = all.filter((l) => l.LawAbandonNote).map(pcodeOf);
  return {
    version: 2,
    update_date: isoDate(updateDate),
    law_count: laws.length,
    order_count: orders.length,
    abolished_count: abolished.length,
    total: all.length,
    pcode_map: Object.fromEntries(all.map((l) => [l.LawName, pcodeOf(l)])),
    abolished_set: abolished,
  };
}

export function buildHistories(all: MojLaw[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const l of all) {
    const pcode = pcodeOf(l);
    const group = /^[A-Za-z]/.test(pcode) ? pcode[0].toUpperCase() : '0';
    (out[group] ??= {})[pcode] = l.LawHistories;
  }
  return out;
}

const decode = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** 欄位的 HTML 原文：從 <li class="text" title="欄位"> 到下一個欄位標題為止 */
function fieldHtml(html: string, title: string): string | null {
  const open = new RegExp(`<li[^>]*class="text"[^>]*title="${title}"[^>]*>`).exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  const end = rest.search(/<li[^>]*class="title"|<!--Article_End/);
  return end < 0 ? rest : rest.slice(0, end);
}

function lines(inner: string | null): string[] {
  if (!inner) return [];
  const text = inner.replace(/<label>[\s\S]*?<\/label>/g, '').replace(/<\/(li|pre|a|p|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  return decode(text).split('\n').map((l) => l.trim()).filter(Boolean);
}

const field = (html: string, title: string) => lines(fieldHtml(html, title)).join('\n');
const statutes = (html: string) => [...new Set(lines(fieldHtml(html, '相關法令')))].join('\n');
const opinions = (html: string, title: string) =>
  [...(fieldHtml(html, title) ?? '').matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) => decode(m[1]).trim()).filter((t) => t.includes('意見書')).join('\n');

export function parseConsPage(html: string, url: string): { kind: 'old' | 'new' | null; key: string | null; case: Case | null; next: string | null } {
  const nextHref = /<a[^>]*class="next"[^>]*href="([^"]+)"/.exec(html)?.[1];
  const next = nextHref ? new URL(decode(nextHref), url).toString() : null;
  const oldNo = /^釋字第(\d+)號/.exec(field(html, '解釋字號'));
  if (oldNo) {
    const reasoning = field(html, '理由書');
    // 早期釋字的欄位叫「意見書、抄本等文件」，較新的叫「意見書」
    const ops = [opinions(html, '意見書、抄本等文件'), opinions(html, '意見書')].filter(Boolean).join('\n');
    return {
      kind: 'old', key: oldNo[1], next,
      case: {
        case_number: field(html, '解釋字號'), date: field(html, '解釋公布院令'), issues: field(html, '解釋爭點'),
        main_text: field(html, '解釋文'), main_text_truncated: false, related_statutes: statutes(html),
        has_reasoning: Boolean(reasoning), has_opinions: Boolean(ops), reasoning, opinions: ops, source_url: url,
      },
    };
  }
  const newNo = /^(\d+)年憲判字第(\d+)號/.exec(field(html, '判決字號'));
  if (newNo) {
    const reasoning = field(html, '理由');
    const ops = opinions(html, '意見書');
    return {
      kind: 'new', key: `${newNo[1]}_${newNo[2]}`, next,
      case: {
        case_number: field(html, '判決字號'), date: field(html, '判決日期'), petitioner: field(html, '聲請人'), issue_summary: field(html, '案由'),
        main_text: field(html, '主文'), main_text_truncated: false, summary: field(html, '判決摘要'), summary_truncated: false,
        related_statutes: statutes(html), has_reasoning: Boolean(reasoning), has_opinions: Boolean(ops), reasoning, opinions: ops, source_url: url,
      },
    };
  }
  return { kind: null, key: null, case: null, next };
}

export function buildIndex(oldCases: Record<string, Case>, newCases: Record<string, Case>) {
  const pick = (c: Case, keys: string[]) => Object.fromEntries(keys.map((k) => [k, c[k]]));
  return {
    old: Object.fromEntries(Object.entries(oldCases).map(([k, c]) => [k, pick(c, ['case_number', 'issues'])])),
    new: Object.fromEntries(Object.entries(newCases).map(([k, c]) => [k, pick(c, ['case_number', 'issue_summary'])])),
  };
}

const MOJ = 'https://law.moj.gov.tw/api/Ch';
/** 沿著「下一筆」連結抓完；起點是第一筆 */
const CONS_START = {
  old: 'https://cons.judicial.gov.tw/docdata.aspx?fid=100&id=310182',
  new: 'https://cons.judicial.gov.tw/docdata.aspx?fid=38&id=310024',
};
const OUT = fileURLToPath(new URL('../demo/hosted-mcp/taiwan-law/data/legal-data', import.meta.url));
const UA = { 'user-agent': 'AgentHub taiwan-law data builder' };

async function fetchRetry(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
      if (res.ok) return res;
      if (attempt >= 3) throw new Error(`${url} 回應 ${res.status}`);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

/** 只留用得到的欄位：完整檔含全部條文，整份留在記憶體會佔很多空間 */
async function mojLaws(kind: 'Law' | 'Order'): Promise<{ UpdateDate: string; Laws: MojLaw[] }> {
  const zip = unzipSync(new Uint8Array(await (await fetchRetry(`${MOJ}/${kind}/JSON`)).arrayBuffer()));
  const name = Object.keys(zip).find((n) => n.endsWith('.json'));
  if (!name) throw new Error(`法務部 ${kind} 壓縮檔裡沒有 JSON`);
  const data = JSON.parse(new TextDecoder().decode(zip[name]).replace(/^﻿/, '')) as { UpdateDate: string; Laws: MojLaw[] };
  return {
    UpdateDate: data.UpdateDate,
    Laws: data.Laws.map(({ LawName, LawURL, LawAbandonNote, LawHistories }) => ({ LawName, LawURL, LawAbandonNote, LawHistories })),
  };
}

async function crawl(start: string): Promise<Record<string, Case>> {
  const out: Record<string, Case> = {};
  const seen = new Set<string>();
  for (let url: string | null = start; url && !seen.has(url); ) {
    seen.add(url);
    const page = parseConsPage(await (await fetchRetry(url)).text(), url);
    if (page.key && page.case) out[page.key] = page.case;
    if (seen.size % 50 === 0) console.log(`${start} 已抓 ${seen.size} 頁`);
    url = page.next;
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

/** 寫檔前的最低筆數（2026-11 實際：法律 1,351、命令 10,454、釋字 813、憲判字 59）；網站改版時解析結果會變少，寧可中止也不要寫入空資料 */
const MIN = { laws: 1000, orders: 8000, oldCases: 813, newCases: 59 };

export function checkCounts(counts: { laws: number; orders: number; oldCases: number; newCases: number }): void {
  const problems = [
    counts.laws < MIN.laws && `法律只有 ${counts.laws} 部（應至少 ${MIN.laws}）`,
    counts.orders < MIN.orders && `命令只有 ${counts.orders} 部（應至少 ${MIN.orders}）`,
    counts.oldCases < MIN.oldCases && `釋字只有 ${counts.oldCases} 號（應有 ${MIN.oldCases}）`,
    counts.newCases < MIN.newCases && `憲判字只有 ${counts.newCases} 號（應至少 ${MIN.newCases}）`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`資料筆數不足，沒有寫入任何檔案：${problems.join('；')}。請檢查法務部 API 或憲法法庭網站是否改版。`);
}

async function main(): Promise<void> {
  // 三者互不相關；兩條憲法法庭爬取各自仍逐頁進行
  const [[law, order], oldCases, newCases] = await Promise.all([
    mojLaws('Law').then(async (l) => [l, await mojLaws('Order')] as const),
    crawl(CONS_START.old),
    crawl(CONS_START.new),
  ]);
  checkCounts({ laws: law.Laws.length, orders: order.Laws.length, oldCases: Object.keys(oldCases).length, newCases: Object.keys(newCases).length });

  await mkdir(OUT, { recursive: true });
  const write = (name: string, data: unknown) => writeFile(path.join(OUT, name), JSON.stringify(data));
  await write('pcode_all.json', buildPcodeAll(law.Laws, order.Laws, law.UpdateDate));
  for (const [group, items] of Object.entries(buildHistories([...law.Laws, ...order.Laws]))) await write(`histories-${group}.json`, items);
  await write('old_cases.json', oldCases);
  await write('new_cases.json', newCases);
  await write('interp-index.json', buildIndex(oldCases, newCases));
  console.log(`法務部資料：法律 ${law.Laws.length}、命令 ${order.Laws.length}（更新日 ${law.UpdateDate}）`);
  console.log(`憲法法庭：釋字 ${Object.keys(oldCases).length} 號、憲判字 ${Object.keys(newCases).length} 號`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

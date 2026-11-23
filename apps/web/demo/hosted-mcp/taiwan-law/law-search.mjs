// 用關鍵字找相關條文：即時查全國法規資料庫的「法條內容」檢索；官方連不上或改版時改用套件內的條文索引
// （data/legal-data/law-articles.json：現行法律＋勞動部主管命令），並標示資料日期。
// 索引另外用來排序：官方清單只能依名稱、日期、位階排，看不出哪部最相關，所以用索引裡提到關鍵字的次數排。
import { fetchLawsWithin, unavailableNote } from './law-fetch.mjs';

const SITE = 'https://law.moj.gov.tw';
const ARTICLES_PER_LAW = 6;
const OTHER_LAWS = 10;
const lawUrl = (pcode) => `${SITE}/LawClass/LawAll.aspx?pcode=${encodeURIComponent(pcode)}`;
const articleUrl = (pcode, no) => `${SITE}/LawClass/LawSingle.aspx?pcode=${encodeURIComponent(pcode)}&flno=${encodeURIComponent(no)}`;
// 依位階排序、每頁 60 筆（網站只收 20、40、60，其他值會被導到錯誤頁）
const listUrl = (kw) => `${SITE}/Law/LawSearchResult.aspx?cur=Ld&ty=ONEBAR&kw=${encodeURIComponent(kw)}&set=LPCODE%7CASC&psize=60`;
const contentUrl = (pcode, kw) => `${SITE}/LawClass/LawSearchContent.aspx?pcode=${encodeURIComponent(pcode)}&kw=${encodeURIComponent(kw)}`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };
const textOf = (html) => html
  .replace(/<br\s*\/?>|<\/div>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(x?)([\da-f]+);/gi, (_, hex, n) => String.fromCodePoint(parseInt(n, hex ? 16 : 10)))
  .replace(/&(amp|lt|gt|quot|nbsp);/g, (_, n) => ENTITIES[n])
  .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');

/** 「法條內容」清單頁 */
export function parseLawList(html) {
  const total = html.match(/法條內容<span class="badge">(\d+)/)?.[1];
  const laws = [...html.matchAll(/(<span class="label-fei">[^<]*<\/span>\s*)?<a id="hlkLawLink" title="([^"]+)" href="[^"]*\?pcode=([^&"]+)&amp;cur=Ld[^"]*">[^<]*<\/a>\s*\((民國[^)]*)\)/g)]
    .map(([, fei, name, pcode, amended]) => ({ name: textOf(name), pcode, amended: amended.trim(), abolished: Boolean(fei) }));
  if (total === undefined || (Number(total) > 0 && !laws.length)) throw new Error('全國法規資料庫的搜尋結果頁看不懂（可能暫時故障或改版）');
  return { total: Number(total), laws };
}

/** 單部法規的條文檢索頁 */
export function parseLawArticles(html) {
  const articles = [...html.matchAll(/<div class="col-no">(?:(?!<\/div>)[\s\S])*?<a href="[^"]*pcode=([^&"]+)&(?:amp;)?flno=([^&"]+)[^"]*">([^<]*)<\/a>\s*<\/div>\s*<div class="col-data(?:"><div class="law-article">([\s\S]*?)<\/div>\s*<\/div>| text-pre">([\s\S]*?)<\/div>)/g)]
    .map(([, pcode, no, number, divs, pre]) => ({ number: textOf(number), text: textOf(divs ?? pre), url: articleUrl(pcode, no) }));
  if (!articles.length && !html.includes('查無資料')) throw new Error('全國法規資料庫的條文頁看不懂（可能暫時故障或改版）');
  return { abolished: /class="label-fei"/.test(html), articles };
}

const SUFFIXES = ['法', '條例', '通則', '規則', '細則', '辦法', '準則', '標準'];

/** 把查詢拆成法規名稱（可省略字尾、可用簡稱）與關鍵字；沒有關鍵字時 terms 是空的 */
export function splitQuery(query, pcodeData, aliases) {
  const map = pcodeData?.pcode_map ?? {};
  const abolished = new Set(pcodeData?.abolished_set);
  const named = (s) => {
    const name = map[s] ? s : aliases[s];
    return name && map[name] ? { name, pcode: map[name] } : null;
  };
  const terms = query.replace(/[，。！？、；：「」『』（）(),?]/g, ' ').split(/\s+/).filter((t) => t.length >= 2).slice(0, 8);
  const whole = terms.join('');
  const suffixed = SUFFIXES.map((s) => named(whole + s)).find((l) => l && !abolished.has(l.pcode));
  const only = named(whole) ?? suffixed;
  if (only) return { law: only, terms: [] };
  for (const [i, term] of terms.entries()) {
    for (let end = term.length; end >= 2; end--) {
      const rest = term.slice(end);
      const law = rest.length === 1 ? null : named(term.slice(0, end));
      if (law) return { law, terms: [...terms.slice(0, i), ...(rest ? [rest] : []), ...terms.slice(i + 1)] };
    }
  }
  return { law: null, terms };
}

const occurrences = (text, terms) => Math.min(...terms.map((t) => text.split(t).length - 1));

/** 命中太多條時只留提到最多次的，維持條號順序 */
function pickArticles(articles, terms) {
  if (articles.length <= ARTICLES_PER_LAW) return articles;
  const keep = new Set([...articles].sort((a, b) => occurrences(b.text, terms) - occurrences(a.text, terms)).slice(0, ARTICLES_PER_LAW));
  return articles.filter((a) => keep.has(a));
}

/** 索引裡每部法規含全部關鍵字的條文，提到最多次的排前面 */
function searchIndex(index, terms) {
  return index.laws.map((law) => {
    const hits = law.a.filter(([, text]) => terms.every((t) => text.includes(t)));
    return { law, hits, score: hits.reduce((sum, [, text]) => sum + occurrences(text, terms), 0) };
  }).filter((h) => h.hits.length).sort((a, b) => b.score - a.score);
}

/**
 * @param {{ law: { name: string, pcode: string } | null, terms: string[], limit: number, abolished: string[], deadline: number,
 *   loadIndex: () => Promise<{ update_date: string, laws: object[] }>, fetchHtml: (url: string) => Promise<string> }} opts
 */
export async function searchByKeyword({ law, terms, limit, abolished, loadIndex, fetchHtml, deadline }) {
  const kw = terms.join(' ');
  const sourceUrl = law ? contentUrl(law.pcode, kw) : listUrl(kw);
  const index = await loadIndex().catch(() => null);
  const local = new Map((index ? searchIndex(index, terms) : []).map((h) => [h.law.p, h]));
  const effective = new Map(index?.laws.filter((l) => l.e).map((l) => [l.p, l.e]));
  const gone = new Set(abolished);

  let candidates;
  let listError;
  if (law) {
    candidates = [law];
  } else {
    try {
      const list = parseLawList(await fetchHtml(sourceUrl));
      candidates = list.laws.filter((l) => !l.abolished && !gone.has(l.pcode));
      if (list.total > list.laws.length) {
        const listed = new Set(list.laws.map((l) => l.pcode));
        candidates.push(...[...local.values()].filter((h) => !listed.has(h.law.p)).map((h) => ({ name: h.law.n, pcode: h.law.p })));
      }
      const score = (l) => local.get(l.pcode)?.score ?? 0;
      candidates.sort((a, b) => score(b) - score(a));
    } catch (e) {
      if (!index) throw new Error(`全國法規資料庫暫時查不到：${e.message}`);
      listError = e;
      candidates = [...local.values()].map((h) => ({ name: h.law.n, pcode: h.law.p }));
    }
  }

  const entry = (l, amended, articles, extra) => {
    const note = effective.get(l.pcode);
    return {
      name: l.name, pcode: l.pcode, url: lawUrl(l.pcode), ...(amended ? { amended_date: amended } : {}), ...extra,
      ...(note ? { effective_note: note, effective_note_date: index.update_date } : {}),
      matched_articles: articles.length, articles: pickArticles(articles, terms),
    };
  };
  const fromIndex = (l) => {
    const hit = local.get(l.pcode);
    return hit && entry(l, hit.law.d, hit.hits.map(([number, text]) => ({ number, text, url: articleUrl(l.pcode, number.replace(/[第條\s]/g, '')) })), { data_date: index.update_date });
  };

  const chosen = candidates.slice(0, limit).map((l) => ({ ...l, url: lawUrl(l.pcode) }));
  const official = listError ? { results: [], unavailable: chosen } : await fetchLawsWithin(chosen, async (l) => {
    const page = parseLawArticles(await fetchHtml(contentUrl(l.pcode, kw)));
    return entry(l, l.amended, page.articles, page.abolished ? { abolished: true } : {});
  }, { deadline });

  const byPcode = new Map(official.results.map((r) => [r.pcode, r]));
  const failed = new Map(official.unavailable.map((u) => [u.pcode, u]));
  const results = [];
  const unavailable = [];
  for (const l of chosen) {
    const result = byPcode.get(l.pcode) ?? fromIndex(l);
    if (!result) unavailable.push(failed.get(l.pcode));
    else if (result.articles.length) results.push(result);
  }

  const localScope = index && `法務部開放資料 ${index.update_date} 版，只收現行法律與勞動部主管命令`;
  const usedLocal = results.some((r) => r.data_date);
  const notes = [
    usedLocal && `標有 data_date 的結果來自本地資料（${localScope}），因為全國法規資料庫暫時連不上或回應異常；引用前請開官方網址核對。`,
    listError && !results.length && `全國法規資料庫暫時連不上或回應異常，本地資料（${localScope}）也沒有條文同時提到「${kw}」，不代表沒有相關規定。`,
    results.some((r) => r.abolished) && '標有 abolished 的法規已廢止，不可當成現行規定引用。',
    !listError && !results.length && !unavailable.length && `${law ? `${law.name}裡` : '現行法規裡'}沒有條文同時提到「${kw}」。請減少關鍵字、改用法條用語，或用法規名稱加條號查詢。`,
    unavailableNote(unavailable, chosen.length),
  ].filter(Boolean);
  const others = candidates.slice(limit);
  return {
    source: usedLocal || listError ? '法務部全國法規資料庫（部分或全部為本地備援資料，見 note）' : '法務部全國法規資料庫', source_url: sourceUrl, results,
    ...(law ? {} : { total_laws: candidates.length }),
    ...(others.length ? { other_laws: others.slice(0, OTHER_LAWS).map(({ name, pcode }) => ({ name, pcode, url: lawUrl(pcode) })) } : {}),
    ...(unavailable.length ? { unavailable } : {}),
    ...(notes.length ? { note: notes.join('\n') } : {}),
    ...(listError ? {} : { retrieved_at: new Date().toISOString() }),
  };
}

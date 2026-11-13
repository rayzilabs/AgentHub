// 關鍵字查法規時要抓多部法規的全文頁（LawAll）。大部法規（例如民法）的全文頁，法務部伺服器要 20 秒以上才回應，
// 原程式一部一部等、一部逾時整個工具就失敗。這裡改成同時抓、整體有時限，單部失敗或超時只列在 unavailable。
const TIMEOUT = Symbol('timeout');

/**
 * @template T
 * @param {{ name: string, pcode: string, url: string }[]} laws
 * @param {(law: { name: string, pcode: string, url: string }) => Promise<T>} fetchOne
 * @param {{ deadline: number }} opts 整個工具呼叫的截止時間（epoch 毫秒）
 * @returns {Promise<{ results: T[], unavailable: { name: string, pcode: string, url: string, reason: string }[] }>}
 */
export async function fetchLawsWithin(laws, fetchOne, { deadline }) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - Date.now())); });
  const settled = await Promise.all(laws.map((law) =>
    Promise.race([fetchOne(law).then((value) => ({ value }), (error) => ({ error })), expired])));
  clearTimeout(timer);
  const results = [];
  const unavailable = [];
  settled.forEach((s, i) => {
    const { name, pcode, url } = laws[i];
    if (s === TIMEOUT) unavailable.push({ name, pcode, url, reason: '官方網站回應太慢，超過時限' });
    else if ('error' in s) unavailable.push({ name, pcode, url, reason: s.error?.message || String(s.error) });
    else results.push(s.value);
  });
  return { results, unavailable };
}

export function unavailableNote(unavailable, total) {
  if (!unavailable.length) return undefined;
  const which = unavailable.length === total ? `這 ${total} 部法規全部暫時取不到` : `其中 ${unavailable.length} 部暫時取不到`;
  return `${which}（全國法規資料庫的全文頁回應太慢或連線失敗）。請稍後再試、改用條號查詢（article_number），或直接開 unavailable 裡的官方網址。`;
}

// 驗證平台通行證（X-AgentHub-Token，ES256 JWT）。只用 Node 內建 crypto，部署時不用裝套件。
import { createPublicKey, verify } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * @param {string | undefined} token
 * @param {{ audience: string, issuer: string, jwks: () => Promise<{ keys: object[] }>, now?: number }} opts
 */
export async function verifyPlatformToken(token, { audience, issuer, jwks, now = Date.now() }) {
  if (!token) throw fail(401, '缺少平台通行證');
  const parts = token.split('.');
  let header, payload;
  try {
    if (parts.length !== 3) throw new Error('格式不正確');
    header = decode(parts[0]);
    payload = decode(parts[1]);
  } catch (e) {
    throw fail(401, `通行證無效：${e.message}`);
  }
  let keys;
  try {
    ({ keys } = await jwks());
  } catch (e) {
    throw fail(503, `取不到平台公鑰：${e.message}`);
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  const valid = header.alg === 'ES256' && jwk
    && verify('sha256', data, { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, sig);
  if (!valid) throw fail(401, '通行證無效：簽章不正確');
  const sec = now / 1000;
  if (payload.iss !== issuer) throw fail(401, '通行證無效：簽發平台不符');
  if (payload.aud !== audience) throw fail(401, '通行證無效：對象網址不符');
  if (typeof payload.exp !== 'number' || payload.exp + 30 < sec) throw fail(401, '通行證無效：已過期');
}

/** 公鑰快取五分鐘；平台換鑰匙時最多五分鐘內生效 */
export function cachedJwks(url, fetchImpl = fetch) {
  let cache = null;
  return async () => {
    if (cache && Date.now() - cache.at < 300_000) return cache.value;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = { at: Date.now(), value: await res.json() };
    return cache.value;
  };
}

import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { HttpError } from '@/lib/http';

const PROJECT_TOKEN_TTL_MS = 20 * 60_000;
const CREATOR_TOKEN_TTL_MS = 5 * 60_000;
const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const encode = (header: object, payload: object) => `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;

/** runtime → 閘道：只對這個專案有效、20 分鐘過期 */
export function signProjectToken(projectId: string, secret: string, now = Date.now()): string {
  const data = encode({ alg: 'HS256', typ: 'JWT' }, { project_id: projectId, exp: Math.floor((now + PROJECT_TOKEN_TTL_MS) / 1000) });
  return `${data}.${b64u(createHmac('sha256', secret).update(data).digest())}`;
}

export function verifyProjectToken(token: string, secret: string, now = Date.now()): string {
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) throw new HttpError(401, '通行證格式不正確');
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new HttpError(401, '通行證簽章不正確');
  let payload: { project_id?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, '通行證內容不正確');
  }
  if (typeof payload.project_id !== 'string' || typeof payload.exp !== 'number') throw new HttpError(401, '通行證內容不正確');
  if (payload.exp * 1000 <= now) throw new HttpError(401, '通行證已過期');
  return payload.project_id;
}

/** 公開給創作者驗證用的公鑰（不含私鑰欄位） */
export function publicJwk(privateKeyPem: string) {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' });
  const kid = createHash('sha256').update(`${jwk.crv}.${jwk.x}.${jwk.y}`).digest('base64url').slice(0, 16);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, alg: 'ES256' as const, use: 'sig' as const };
}

/** 閘道 → 創作者 MCP：證明這次呼叫來自平台、屬於哪個專案與顧問 */
export function signCreatorToken(
  claims: { iss: string; aud: string; sub: string; project_id: string; template_id: string | null },
  privateKeyPem: string,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const data = encode(
    { alg: 'ES256', typ: 'JWT', kid: publicJwk(privateKeyPem).kid },
    { ...claims, iat, exp: iat + CREATOR_TOKEN_TTL_MS / 1000, jti: randomUUID() },
  );
  const sig = sign('sha256', Buffer.from(data), { key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

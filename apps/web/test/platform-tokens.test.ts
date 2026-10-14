import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { publicJwk, signCreatorToken, signProjectToken, verifyProjectToken } from '@/lib/platform-tokens';

const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('專案通行證', () => {
  it('簽發後驗證得到 project_id', () => {
    expect(verifyProjectToken(signProjectToken('p1', 's'), 's')).toBe('p1');
  });

  it('簽章不符、過期、格式錯誤都回 401', () => {
    const cases: [string, string, number][] = [
      [signProjectToken('p1', 's'), 'other', Date.now()],
      [signProjectToken('p1', 's', 0), 's', 21 * 60_000],
      ['abc', 's', 0],
      [`${signProjectToken('p1', 's')}.x`, 's', Date.now()],
    ];
    for (const [token, secret, now] of cases) {
      const e = errorOf(() => verifyProjectToken(token, secret, now));
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(401);
    }
  });
});

describe('創作者通行證', () => {
  it('ES256 簽章可用公開的 JWK 驗證；欄位與 5 分鐘效期正確', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const token = signCreatorToken({ iss: 'https://p', aud: 'https://c/mcp', sub: 'i1', project_id: 'p1', template_id: 't1' }, pem, now);
    const [h, p, s] = token.split('.');
    const jwk = publicJwk(pem);
    expect(decode(h)).toMatchObject({ alg: 'ES256', kid: jwk.kid });
    expect(decode(p)).toMatchObject({
      iss: 'https://p', aud: 'https://c/mcp', sub: 'i1', project_id: 'p1', template_id: 't1', iat: now / 1000, exp: now / 1000 + 300,
    });
    expect(typeof decode(p).jti).toBe('string');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
    expect(jwk).not.toHaveProperty('d');
  });
});

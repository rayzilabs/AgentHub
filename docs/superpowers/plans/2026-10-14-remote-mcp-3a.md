# 遠端 MCP 3a＋3c：閘道、通行證、用量、大量資料慣例 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 創作者可以在範本加入自己架的 `remote` 型 MCP；agent 經平台閘道呼叫，閘道驗證專案通行證、簽創作者通行證、轉送並記用量；創作者網址與身分憑證都不進 Sprite。

**Architecture:** Vercel 轉送對話時附上專案通行證（HS256）；runtime 對 `remote` 型 MCP 改連 `/api/mcp/<顧問id>/<MCP 名稱>`；閘道查 `remote_mcp_targets`（只有 service_role 讀得到）找出創作者網址，簽 ES256 創作者通行證轉送，`tools/call` 寫進 `mcp_usage`；公鑰在 `/.well-known/jwks.json`。

**Tech Stack:** Node `crypto`（不新增 JWT 套件）、Next.js 16 route handlers、`@ai-sdk/mcp` streamable HTTP、Supabase、Vitest、pgTAP。

**Spec:** `docs/superpowers/specs/2026-10-14-remote-mcp-design.md`；長期參考 `docs/security-model.md`。

## Global Constraints

- 專案通行證：HS256，`{ project_id, exp }`，20 分鐘；密鑰 Vercel 環境變數 `RUNTIME_TOKEN_SECRET`。**未設定時**：不附通行證、chat 照常運作，`remote` 型 MCP 顯示「目前無法使用」（避免設定環境變數前就讓對話壞掉）。
- 創作者通行證：ES256，`{ iss, aud, sub, project_id, template_id, iat, exp, jti }`，5 分鐘；私鑰 `MCP_SIGNING_KEY`（PKCS8 PEM）；`kid` = 公鑰座標 SHA-256 的前 16 字元（base64url）。一律放在 `X-AgentHub-Token`，自己架時 `Authorization: Bearer` 也放同一張。
- 閘道路徑 `/api/mcp/<顧問id>/<MCP 名稱>`（一位顧問可有多個 remote MCP）。
- 創作者網址存在範本的 `mcp_servers`（公開範本頁本來就會去掉網址）；租用時 `hire_agent` 把網址搬到 `remote_mcp_targets`，`agent_instances.mcp_servers` 只留 `{ name, transport: 'remote' }`。（與 spec 2.5 的 `agent_templates.remote_mcp` 不同：功能相同、少一個欄位，Task 7 更新 spec。）
- `remote` 型不接受 `headers`、`required_secrets`。
- 不新增 npm 套件。用 `corepack pnpm`；測試打雲端 Supabase；Windows 既有 runtime 基準失敗 6 個。
- 本分支每個 Task 本機自動 commit；migration 套用、Vercel 環境變數、push、`publish-runtime`、`redeploy-runtime` 先取得使用者同意。

## Review Focus

1. **通行證被拿去呼叫別的專案的顧問**：閘道必須比對 `instance.project_id === token.project_id`。→ Task 4 測試。
2. **顧問被移出專案後**：同一張未過期的專案通行證必須立刻被拒。→ Task 4 測試。
3. **`RUNTIME_TOKEN_SECRET` 尚未設定**：chat 不能因此壞掉。→ Task 5 測試。
4. **閘道把不該轉的標頭轉給創作者**（例如租用者的 cookie、平台的 Authorization）：只轉白名單。→ Task 4 測試。
5. **MCP 名稱含 `/` 或 `..`**：路徑段要編碼，查表以完整名稱比對。→ Task 4、6 測試。

---

## 檔案結構

```text
apps/web/lib/platform-tokens.ts                     專案通行證、創作者通行證、公鑰 JWK
apps/web/lib/services/remote-mcp.ts                 resolveRemoteTarget、toolCallName、recordUsage
apps/web/app/api/mcp/[instanceId]/[name]/route.ts   閘道
apps/web/app/.well-known/jwks.json/route.ts         公鑰
apps/web/lib/env.ts、lib/sprites.ts、app/api/threads/[id]/chat/route.ts   環境變數、轉送附通行證、.env 加 PLATFORM_URL
apps/web/lib/schemas.ts、components/template-editor.tsx                  remote 型
supabase/migrations/20261014000001_remote_mcp.sql、supabase/tests/remote_mcp.test.sql
packages/runtime/src/{config,types,mcp,server,run,consultant}.ts、agents/{build,prompts}.ts
docs/creator/remote-mcp.md
```

---

## Task 0：基準線

- [ ] 分支 `feat/remote-mcp`；跑 runtime、web 測試與 typecheck。Expected：runtime 6 個 Windows 基準失敗，其餘通過。

## Task 1：通行證工具

**Files:** Create `apps/web/lib/platform-tokens.ts`；Test `apps/web/test/platform-tokens.test.ts`

**Interfaces — Produces:** `signProjectToken(projectId: string, secret: string, now?: number): string`、`verifyProjectToken(token: string, secret: string, now?: number): string`（回傳 project_id，失敗丟 `HttpError(401)`）、`publicJwk(privateKeyPem: string): JsonWebKey & { kid: string; alg: 'ES256'; use: 'sig' }`、`signCreatorToken(claims: { iss: string; aud: string; sub: string; project_id: string; template_id: string | null }, privateKeyPem: string, now?: number): string`

- [ ] **Step 1：寫失敗的測試**

```ts
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { publicJwk, signCreatorToken, signProjectToken, verifyProjectToken } from '@/lib/platform-tokens';

const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('專案通行證', () => {
  it('簽發後驗證得到 project_id', () => {
    expect(verifyProjectToken(signProjectToken('p1', 's'), 's')).toBe('p1');
  });
  it('簽章不符、過期、格式錯誤都回 401', () => {
    const t = signProjectToken('p1', 's', 0);
    for (const [token, secret, now] of [[signProjectToken('p1', 's'), 'other', Date.now()], [t, 's', 21 * 60_000], ['abc', 's', 0]] as const) {
      const e = (() => { try { verifyProjectToken(token, secret, now); } catch (err) { return err; } })();
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
    expect(decode(p)).toMatchObject({ iss: 'https://p', aud: 'https://c/mcp', sub: 'i1', project_id: 'p1', template_id: 't1', exp: now / 1000 + 300 });
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
    expect(jwk).not.toHaveProperty('d');
  });
});
```

- [ ] **Step 2：確認失敗**（模組不存在）
- [ ] **Step 3：實作** `apps/web/lib/platform-tokens.ts`：

```ts
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
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { project_id?: unknown; exp?: unknown };
  if (typeof payload.project_id !== 'string' || typeof payload.exp !== 'number') throw new HttpError(401, '通行證內容不正確');
  if (payload.exp * 1000 <= now) throw new HttpError(401, '通行證已過期');
  return payload.project_id;
}

/** 公開給創作者驗證用的公鑰（不含私鑰欄位） */
export function publicJwk(privateKeyPem: string) {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }) as JsonWebKey;
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
```

- [ ] **Step 4：通過**；typecheck。**Step 5：Commit** — `feat(web): 專案通行證與創作者通行證`

## Task 2：資料庫

**Files:** Create `supabase/migrations/20261014000001_remote_mcp.sql`、`supabase/tests/remote_mcp.test.sql`

- [ ] **Step 1：pgTAP 測試**（`plan(6)`，前言同既有測試）：
  - `has_table('public','remote_mcp_targets')`、`has_table('public','mcp_usage')`
  - 兩張表 `relrowsecurity = true`（`select ok((select relrowsecurity from pg_class where oid = 'public.remote_mcp_targets'::regclass), …)`，`mcp_usage` 同）
  - 建立 creator／renter／project、一個範本 `mcp_servers = '[{"name":"fin","transport":"remote","url":"https://c.example/mcp"}]'`，`hire_agent` 後：
    - `agent_instances.mcp_servers` 等於 `'[{"name":"fin","transport":"remote"}]'::jsonb`（網址已去掉）
    - `remote_mcp_targets` 有一列 `('fin','self','https://c.example/mcp')`
- [ ] **Step 2：migration**

```sql
-- 子專案 3：創作者 MCP 的網址只有閘道（service_role）讀得到；用量只由閘道寫入
create table public.remote_mcp_targets (
  instance_id uuid not null references public.agent_instances (id) on delete cascade,
  mcp_name text not null,
  kind text not null default 'self' check (kind in ('self', 'hosted')),
  url text,
  primary key (instance_id, mcp_name)
);
alter table public.remote_mcp_targets enable row level security;

create table public.mcp_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null,
  instance_id uuid not null,
  template_id uuid,
  creator_id uuid,
  mcp_name text not null,
  tool text not null,
  ok boolean not null,
  duration_ms int not null
);
alter table public.mcp_usage enable row level security;
create index mcp_usage_template_created on public.mcp_usage (template_id, created_at desc);
```

  接著 `create or replace function public.hire_agent(...)`：**整段複製** `supabase/migrations/20261002000003_instance_description.sql` 裡的函式，只改兩處：
  1. `insert into public.agent_instances (...) values (..., t.mcp_servers)` 的最後一個值改成：

```sql
(select coalesce(jsonb_agg(case when s ->> 'transport' = 'remote'
                                then jsonb_build_object('name', s ->> 'name', 'transport', 'remote')
                                else s end), '[]'::jsonb)
   from jsonb_array_elements(t.mcp_servers) s)
```

  2. `returning id into v_instance_id;` 之後加：

```sql
  insert into public.remote_mcp_targets (instance_id, mcp_name, kind, url)
  select v_instance_id, s ->> 'name', 'self', s ->> 'url'
    from jsonb_array_elements(t.mcp_servers) s
   where s ->> 'transport' = 'remote';
```

  最後保留原本的 `revoke`／`grant`。
- [ ] **Step 3：套用（對外動作，先取得使用者同意）**：與 10/13 相同，請使用者在 Supabase Dashboard SQL Editor 執行 migration 內容（CLI 帳號看不到 Eric 的專案）；之後以 REST 確認兩張表存在、`hire_agent` 行為（Task 4 的測試會實際覆蓋）。pgTAP 留給 Eric 跑 `pnpm db:test`。
- [ ] **Step 4：Commit** — `feat(db): 遠端 MCP 目標與用量資料表，租用時把創作者網址移出 Sprite 可讀範圍`

## Task 3：範本支援 remote 型

**Files:** Modify `apps/web/lib/schemas.ts`、`apps/web/components/template-editor.tsx`；Test `apps/web/test/schemas.test.ts`

- [ ] **Step 1：測試**

```ts
it('remote 型：需要網址，不接受 headers 與金鑰', () => {
  expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', url: 'https://c.example/mcp' }).success).toBe(true);
  expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote' }).success).toBe(false);
  expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', url: 'https://c.example/mcp', headers: { A: 'b' } }).success).toBe(false);
  expect(McpServerSchema.safeParse({ name: 'fin', transport: 'remote', url: 'https://c.example/mcp', required_secrets: [{ key: 'K' }] }).success).toBe(false);
});
```

- [ ] **Step 2：確認失敗**
- [ ] **Step 3：實作**
  - `transport: z.enum(['stdio', 'http', 'remote'])`；`superRefine` 加：`remote` 沒有 `url` → 「MCP「x」需要網址」；有 `headers` 或非空 `required_secrets` → 「remote 型由平台通行證驗證，不能設定標頭或金鑰」。
  - `template-editor.tsx`：`McpDraft.transport` 加 `'remote'`；下拉選單加「你的 MCP（經平台閘道）」；`remote` 只顯示網址欄位，說明文字「平台會以通行證呼叫，驗證方式見創作者文件」；`fromDraft` 回傳 `{ name, transport: 'remote', url }`；`toDraft` 支援 remote。
- [ ] **Step 4：web 測試、typecheck、lint 通過**。**Step 5：Commit** — `feat(web): 範本可以加入創作者自己架的 remote 型 MCP`

## Task 4：閘道與公鑰

**Files:** Create `apps/web/lib/services/remote-mcp.ts`、`apps/web/app/api/mcp/[instanceId]/[name]/route.ts`、`apps/web/app/.well-known/jwks.json/route.ts`；Modify `apps/web/lib/env.ts`；Test `apps/web/test/remote-mcp.test.ts`

**Interfaces — Produces:** `env.runtimeTokenSecret: string | undefined`、`env.mcpSigningKey: string`、`env.platformUrl: string`；`resolveRemoteTarget(db, instanceId, mcpName, projectId): Promise<{ url: string; templateId: string | null; creatorId: string | null }>`；`toolCallName(body: string | undefined): string | null`；`recordUsage(db, row)`

- [ ] **Step 1：env**（`lib/env.ts` 加）

```ts
  /** 未設定時不簽專案通行證（remote 型 MCP 會顯示無法使用，對話照常） */
  get runtimeTokenSecret() { return process.env.RUNTIME_TOKEN_SECRET || undefined; },
  get mcpSigningKey() { return required('MCP_SIGNING_KEY'); },
  get platformUrl() {
    if (process.env.PLATFORM_URL) return process.env.PLATFORM_URL;
    return process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000';
  },
```

- [ ] **Step 2：寫失敗的測試**（`test/remote-mcp.test.ts`）：
  - `toolCallName`：`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"rate"}}` → `'rate'`；`tools/list`、非 JSON、`undefined` → `null`；批次陣列取第一個 `tools/call`。
  - 整合（雲端 DB）：用 `seedUser`／`createProject`／範本＋`hire_agent`（範本含 `remote` 型、網址指向測試內以 `node:http` 開在隨機 port 的假 MCP）建立顧問；`vi.stubEnv('RUNTIME_TOKEN_SECRET','s')`、`vi.stubEnv('MCP_SIGNING_KEY', pem)`、`vi.stubEnv('PLATFORM_URL','https://p.test')`；直接呼叫 route 的 `POST`：
    1. 帶正確專案通行證 → 200，回應本文是假 MCP 的回覆；假 MCP 收到的 `x-agenthub-token` 可用 `publicJwk(pem)` 驗證，`sub`＝顧問 id、`project_id`、`aud`＝假 MCP 網址；`authorization` 是同一張；**沒有**收到請求方的 `cookie`。
    2. `mcp_usage` 多一筆 `tool = 'rate'`、`ok = true`。
    3. 別的專案的通行證 → 403；沒有通行證 → 401；MCP 名稱不存在 → 404。
    4. 刪掉這個 `agent_instance` 後，同一張通行證 → 403 或 404。
    5. `GET /.well-known/jwks.json` 回 `{ keys: [publicJwk(pem)] }`。
- [ ] **Step 3：確認失敗**
- [ ] **Step 4：實作**
  - `lib/services/remote-mcp.ts`：

```ts
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';

export async function resolveRemoteTarget(db: Db, instanceId: string, mcpName: string, projectId: string) {
  const { data: inst, error } = await db.from('agent_instances')
    .select('project_id, role, template_id, template:agent_templates(creator_id)').eq('id', instanceId).maybeSingle();
  if (error) throw error;
  if (!inst || inst.role !== 'consultant') throw new HttpError(404, '找不到這位顧問');
  if (inst.project_id !== projectId) throw new HttpError(403, '這位顧問不屬於這個專案');
  const { data: target, error: tErr } = await db.from('remote_mcp_targets')
    .select('kind, url').eq('instance_id', instanceId).eq('mcp_name', mcpName).maybeSingle();
  if (tErr) throw tErr;
  if (!target || target.kind !== 'self' || !target.url) throw new HttpError(404, '找不到這個工具服務');
  const creatorId = (inst.template as { creator_id?: string } | null)?.creator_id ?? null;
  return { url: target.url as string, templateId: inst.template_id as string | null, creatorId };
}

/** JSON-RPC 本文是 tools/call 時回傳工具名稱（批次取第一個），其餘回傳 null */
export function toolCallName(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const call = list.find((m) => (m as { method?: unknown })?.method === 'tools/call') as { params?: { name?: unknown } } | undefined;
    return typeof call?.params?.name === 'string' ? call.params.name : null;
  } catch {
    return null;
  }
}

export type UsageRow = {
  project_id: string; instance_id: string; template_id: string | null; creator_id: string | null;
  mcp_name: string; tool: string; ok: boolean; duration_ms: number;
};

export async function recordUsage(db: Db, row: UsageRow): Promise<void> {
  const { error } = await db.from('mcp_usage').insert(row);
  if (error) throw error;
}
```

  - `app/api/mcp/[instanceId]/[name]/route.ts`：

```ts
import { env } from '@/lib/env';
import { HttpError, route } from '@/lib/http';
import { signCreatorToken, verifyProjectToken } from '@/lib/platform-tokens';
import { recordUsage, resolveRemoteTarget, toolCallName } from '@/lib/services/remote-mcp';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

/** 只轉 MCP 需要的請求標頭；請求方的 cookie、Authorization 等一律不轉 */
const FORWARD = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);

type Ctx = { params: Promise<{ instanceId: string; name: string }> };

async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const { instanceId, name } = await params;
  const secret = env.runtimeTokenSecret;
  if (!secret) throw new HttpError(503, '平台尚未設定專案通行證');
  const bearer = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!bearer) throw new HttpError(401, '缺少專案通行證');
  const projectId = verifyProjectToken(bearer, secret);
  const db = adminDb();
  const target = await resolveRemoteTarget(db, instanceId, name, projectId);

  const body = req.method === 'POST' ? await req.text() : undefined;
  const tool = toolCallName(body);
  const token = signCreatorToken(
    { iss: env.platformUrl, aud: target.url, sub: instanceId, project_id: projectId, template_id: target.templateId },
    env.mcpSigningKey,
  );
  const headers = new Headers();
  for (const k of FORWARD) {
    const v = req.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set('x-agenthub-token', token);
  headers.set('authorization', `Bearer ${token}`);

  const started = Date.now();
  const usage = (ok: boolean) => tool
    ? recordUsage(db, { project_id: projectId, instance_id: instanceId, template_id: target.templateId, creator_id: target.creatorId, mcp_name: name, tool, ok, duration_ms: Date.now() - started })
        .catch((e) => console.error('[mcp] 無法記錄用量', e))
    : Promise.resolve();
  let upstream: Response;
  try {
    upstream = await fetch(target.url, { method: req.method, headers, body });
  } catch {
    await usage(false);
    throw new HttpError(502, '工具服務無法連線');
  }
  await usage(upstream.ok);
  const out = new Headers();
  upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v); });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const POST = route(handle);
export const GET = route(handle);
export const DELETE = route(handle);
```

  - `app/.well-known/jwks.json/route.ts`：`export const GET = route(async () => ({ keys: [publicJwk(env.mcpSigningKey)] }));`（若 Next.js 不吃以 `.` 開頭的路由資料夾，改放 `app/api/jwks/route.ts` 並在 `next.config.ts` 加 `rewrites` 把 `/.well-known/jwks.json` 指過去，記 ledger）。
- [ ] **Step 5：web 測試、typecheck、lint 通過**。**Step 6：Commit** — `feat(web): 遠端 MCP 閘道與公鑰`

## Task 5：轉送對話附專案通行證、runtime 知道平台網址

**Files:** Modify `apps/web/lib/sprites.ts`、`apps/web/app/api/threads/[id]/chat/route.ts`；Test `apps/web/test/sprites.test.ts`

- [ ] **Step 1：測試**
  - `forwardChat(url, body, { projectToken: 'tok', token: 't', fetchImpl })`：請求標頭有 `x-agenthub-token: tok`；不給 `projectToken` 時沒有這個標頭。
  - `installRuntime` 寫的 `.env` 含 `PLATFORM_URL="…"`。
- [ ] **Step 2：確認失敗**
- [ ] **Step 3：實作**
  - `forwardChat` 的 `opts` 加 `projectToken?: string`；有值時加 `'x-agenthub-token': opts.projectToken`。
  - chat route：`const secret = env.runtimeTokenSecret;` → `forwardChat(project.sprite_url, …, { projectToken: secret ? signProjectToken(project.id, secret) : undefined })`。
  - `installRuntime` 的 `.env` 加 `PLATFORM_URL: env.platformUrl`。
- [ ] **Step 4：通過**。**Step 5：Commit** — `feat(web): 轉送對話時附上專案通行證`

## Task 6：runtime 改連閘道

**Files:** Modify `packages/runtime/src/{config,types,mcp,server,run,consultant}.ts`、`agents/build.ts`；Test `packages/runtime/test/mcp.test.ts`、`test/server.test.ts`

**Interfaces — Produces:** `type McpGateway = { baseUrl: string; token: string; instanceId: string }`；`connectMcpServers(servers, secrets, cwd, sandbox, connect?, timeoutMs?, gateway?)`；`ConsultantContext.gateway?: { baseUrl: string; token: string }`；`startRun(deps, { threadId, text, platformToken? })`

- [ ] **Step 1：測試**
  - `mcp.test.ts`：`remote` 型＋gateway → fake connect 收到 `{ type: 'http', url: 'https://p/api/mcp/i1/fin%2Fx', headers: { Authorization: 'Bearer tok' } }`（名稱 `fin/x` 被編碼）；沒有 gateway → warnings 含「平台閘道未設定」。
  - `server.test.ts`：`/chat` 帶 `x-agenthub-token: tok`，專案有一位含 `remote` 型 MCP 的顧問、config 有 `PLATFORM_URL` → 用 `vi.spyOn` 包 `connectMcpServers`（或比照 build.test 的 `vi.mock('../src/mcp')`）確認收到 gateway `{ baseUrl, token: 'tok', instanceId }`。
- [ ] **Step 2：確認失敗**
- [ ] **Step 3：實作**
  - `config.ts`：`PLATFORM_URL: z.url().optional()`。
  - `types.ts`：`transport: 'stdio' | 'http' | 'remote'`。
  - `mcp.ts`：`transportFor` 加參數 `gateway?: McpGateway`；`remote` 型：

```ts
  if (server.transport === 'remote') {
    if (!gateway) throw new Error('平台閘道未設定');
    return {
      type: 'http' as const,
      url: `${gateway.baseUrl}/api/mcp/${gateway.instanceId}/${encodeURIComponent(server.name)}`,
      headers: { Authorization: `Bearer ${gateway.token}` },
    };
  }
```

  - `server.ts`：`startRun(deps, { threadId, text, platformToken: c.req.header('x-agenthub-token') })`。
  - `run.ts`：`platformToken` 與 `config.PLATFORM_URL` 都有時組 `gateway = { baseUrl, token }`，傳給單一顧問的 `buildConsultant` 與 `createConsultantRunner`；`consultant.ts` 的 deps 加 `gateway?` 並傳進 `buildConsultant`；`build.ts` 呼叫 `connectMcpServers(..., gateway && { ...gateway, instanceId: ctx.instance.id })`。
- [ ] **Step 4：runtime 全部測試、typecheck**。**Step 5：Commit** — `feat(runtime): remote 型 MCP 經平台閘道呼叫`

## Task 7：3c 與文件

**Files:** Modify `packages/runtime/src/agents/prompts.ts`；Create `docs/creator/remote-mcp.md`；Modify `docs/superpowers/specs/2026-10-14-remote-mcp-design.md`、`docs/security-model.md`、`CLAUDE.md`；Test `packages/runtime/test/build.test.ts`

- [ ] **Step 1：測試**：`buildConsultantInstructions(...)` 含「download_url」與「curl」。
- [ ] **Step 2：實作**：顧問指示加一行「工具回傳 `download_url` 時，用 bash 以 curl 下載到工作目錄再處理，不要把大量資料貼進回覆。」
- [ ] **Step 3：`docs/creator/remote-mcp.md`**：remote 型怎麼設定；通行證在 `X-AgentHub-Token`；公鑰 `https://<平台>/.well-known/jwks.json`；Python（PyJWT `PyJWKClient`）與 Node（`jose` `createRemoteJWKSet`／`jwtVerify`）驗證範例（檢查 `iss`、`aud`＝自己的網址、`exp`）；大量資料回 `{ download_url, expires_in }` 的慣例；單次工具呼叫 300 秒上限。
- [ ] **Step 4：spec 2.3／2.4 的閘道路徑改成 `/api/mcp/<顧問id>/<MCP 名稱>`；spec 2.5 改成「網址存在範本 mcp_servers，租用時搬到 remote_mcp_targets」；security-model 子專案 3 改 🚧；CLAUDE.md 架構加一條閘道說明。**
- [ ] **Step 5：Commit** — `docs: 創作者遠端 MCP 文件與大量資料慣例`

## Task 8：上線（對外動作，先取得使用者同意）

- [ ] 產生金鑰：`RUNTIME_TOKEN_SECRET`（32 bytes 隨機）與 `MCP_SIGNING_KEY`（P-256 PKCS8 PEM）。**這台電腦疑似遭入侵**：建議使用者或 Eric 在另一台可信任的電腦用以下指令產生，直接貼進 Vercel，不經過這台：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}))"
```

- [ ] 使用者／Eric 在 Vercel（`rayzilabs-2056/agenthub`）設定兩個環境變數（Production）。
- [ ] 完整驗證 → `finishing-a-development-branch` → 合併 `main`、push、確認 Vercel 成功（失敗且是 Google Fonts 時請使用者 Redeploy）。
- [ ] `publish-runtime` → `redeploy-runtime`（重啟所有 Sprite；`.env` 加上 `PLATFORM_URL`）→ 逐台確認健康。
- [ ] 確認 `https://<平台>/.well-known/jwks.json` 回公鑰；正式環境端對端驗收留到子專案 4（金融顧問的 MCP）。
- [ ] security-model 改 ✅（3a），更新記憶。

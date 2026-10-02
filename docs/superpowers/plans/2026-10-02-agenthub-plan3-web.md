# AgentHub 計畫 3：Web 前後端與 Sprite 部署實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建好 `apps/web`（Next.js 16，部署在 Vercel）：登入、創作者上架（表單 + skill zip + MCP）、市集、一鍵啟用、專案工作區（顧問名單、檔案、記憶、對話串流與顧問發言即時顯示），以及建立專案時自動在 Fly Sprite 部署 agent runtime；最後部署到 Vercel production 並用 API 冒煙測試跑通整條流程。

**Architecture:** 瀏覽器只跟 Vercel 溝通。所有 Supabase 存取都在伺服器端：登入用 `@supabase/ssr`（session cookie），資料存取用 secret key 的 admin client，權限在每支 API 的 service 函式裡檢查（是否為擁有者）。商業邏輯放在 `lib/services/*`（接收 `db` 與 `userId`，可直接對雲端 Supabase 測試），route handler 只做「驗證身分 → 解析輸入 → 呼叫 service → 回 JSON」。runtime 用 esbuild 打包成單一 `main.js` 上傳到 Storage；建立專案時以 `after()` 在背景建立 Sprite、下載 runtime、註冊服務、等 `/health`。對話由 Vercel 轉送到 Sprite 私有網址，串流原樣回傳給 `useChat`。

**Tech Stack:** Next.js 16.3（App Router、`proxy.ts`）、React 19、Tailwind CSS v4 + `@tailwindcss/typography`、`@supabase/ssr` 0.12、`@supabase/supabase-js`、`ai` v7 + `@ai-sdk/react`、`@fly/sprites` 0.2.3、zod 4、fflate、yaml、react-markdown 10 + remark-gfm、esbuild、Vitest 5。

**Spec:** `docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md`（§2、§4、§5.1–§5.7、§7）

**前置條件：** 計畫 1、2 已完成（runtime 在 `packages/runtime`，資料庫 migration 已推到雲端）。

## Global Constraints

- 沿用計畫 1 的環境規則：雲端 Supabase 只用 `--linked`（ref `xrcyllzqionkwareukif`）、`.env` 不可印出或 commit、commit 訊息結尾加 `Claude-Session: https://claude.ai/code/session_019gWKBjFHT2VamSLeQeXEqj`、不 push（push 只在 Task 8 由指定步驟執行）。
- 伺服器端環境變數名稱（本機從 repo 根目錄 `.env` 讀，Vercel 上設定同名變數）：`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`、`FLY_SPRITES_TOKEN`、`VERTEX_API_EXPRESS_MODE_KEY`。**不使用 `NEXT_PUBLIC_` 前綴**：瀏覽器不直接連 Supabase。
- 瀏覽器唯一的例外：上傳檔案時用伺服器發的 Supabase Storage 簽名網址直接 `PUT`（規格 §4）。
- 登入只做 Email + 密碼。註冊用 admin API `createUser({ email_confirm: true })` 後直接登入，不寄確認信。
- API 也接受 `Authorization: Bearer <Supabase access token>`（給冒煙測試腳本用），沒有 Bearer 才看 cookie。
- 需要登入的頁面：`/projects`、`/projects/*`、`/creator`、`/creator/*`，未登入導向 `/login?next=<原路徑>`。市集 `/` 與 `/templates/*` 不用登入。
- 每支 API 失敗時回 `{ error: string }`，狀態碼：未登入 401、找不到或不是擁有者 404、輸入錯誤 400、狀態衝突 409、Sprite 連不上 502、其他 500。錯誤訊息是給使用者看的繁體中文。
- 對話 API `POST /api/threads/:id/chat` 的 body 是 `{ text: string }`，轉送到 Sprite 時是 `{ thread_id, text }`；連線失敗或 502/503/504 時等 1 秒重試，最多 3 次。route 設 `maxDuration = 300`。
- **規格修正（Ruling）：** 規格 §4 的 `GET /api/runs/:id` 改由 `GET /api/threads/:id/messages` 回傳 `{ messages, running, error }` 取代，前端不需要知道 run id；`running` 只在最新 run 為 `running` 且開始未滿 20 分鐘時為 true（規格 §7）。
- Sprite 名稱：`agenthub-<project id>`；只建立與刪除這個前綴的 Sprite。Sprite 網址用私有模式（`urlSettings: { auth: 'sprite' }`），請求帶 `Authorization: Bearer <FLY_SPRITES_TOKEN>`。
- runtime 安裝位置：Sprite 使用者的 `$HOME/agenthub/`（`main.js`、`.env`、`agents/`、`shared/`），服務名稱 `runtime`，`httpPort: 8080`。runtime 安裝檔在 Storage `runtime/main.js`。
- Vercel：專案 `agenthub`（team `rayzilabs-2056`），Root Directory `apps/web`，框架 Next.js，Node 24.x，函式區域 `sin1`。
- **介面設計 token（所有 UI 任務必須使用）：**
  - 顏色：`paper #F4F6F9`（頁面底色）、`surface #FFFFFF`、`ink #172033`（主文字）、`muted #5B6578`、`line #DCE1E8`、`brand #1F4E79`（主要按鈕、連結；沿用簡報的藍）、`brand-soft #E3ECF5`、`seal #B8322A`（「同意」印章）、`ochre #8A6D1F`（「有保留」印章）。
  - 顧問識別色（依顧問在專案中的順序循環使用）：`#1F4E79`、`#2E7D6B`、`#8E4C9E`、`#B5651D`、`#3D6FB6`、`#A23B5A`。顏色只用來辨識「誰在說話」，不做裝飾。
  - 字體：標題與 agent 名稱用「霞鶩文楷 TC」（Google Fonts `LXGW WenKai TC`），內文用 `Noto Sans TC`。字級 14 / 16 / 20 / 28 / 40px。
  - 唯一的大膽元素：討論中的立場以傾斜的印章呈現（紅色「同意」、赭色「保留」）。其他地方保持安靜：不用漸層、不用全大寫標籤、不在每張卡片加陰影、不加無意義的進場動畫。
  - 文案：從使用者角度、主動語態，按鈕說清楚會發生什麼（「建立專案」「加入這位顧問」「送出」）；錯誤說明發生什麼與怎麼處理；空狀態引導下一步。
  - 品質底線：手機寬度可用、鍵盤焦點可見（`:focus-visible` 外框用 brand 色）、尊重 `prefers-reduced-motion`。

## Review Focus

1. **非擁有者存取別人的專案、對話、記憶、範本草稿**：一律 404，不洩漏存在與否。→ Task 3、Task 4 service 測試。
2. **skill zip 內容異常**（沒有 SKILL.md、缺 name/description、重名、`__MACOSX` 垃圾檔）：上架時逐項列出問題，不寫入資料庫。→ Task 2、Task 3 測試。
3. **Sprite 剛醒來服務還沒準備好**：對話轉送遇到連線錯誤或 502/503/504 會重試，三次都失敗才回 502。→ Task 5 測試。
4. **串流被 Vercel 時間上限切斷或使用者重新整理**：前端改用輪詢 `messages` 直到 `running = false`，顯示已儲存的完整回覆或錯誤原因。→ Task 4 `running`／`error` 測試、Task 7 手動驗證、Task 8 冒煙測試。
5. **啟用 agent 時漏填金鑰、範本未上架**：回 400／404 與清楚訊息，不留下半個 agent。→ Task 4 測試。

---

## 檔案結構

```
pnpm-workspace.yaml                    （改）allowBuilds: esbuild
packages/runtime/
  package.json                         （改）build、publish-runtime script；esbuild 依賴
  scripts/build.mjs                    esbuild 打包 → dist/main.js
  scripts/publish.mjs                  打包並上傳到 Storage runtime/main.js
apps/web/
  package.json、next.config.ts、tsconfig.json、postcss.config.mjs、vercel.json、vitest.config.ts、proxy.ts
  app/
    layout.tsx、globals.css
    page.tsx                           市集
    login/page.tsx、login/login-form.tsx、login/actions.ts
    templates/[id]/page.tsx            agent 介紹 + 啟用
    creator/page.tsx、creator/[id]/page.tsx
    projects/page.tsx、projects/[id]/page.tsx
    api/**/route.ts                    （見 Task 3–5）
  components/
    nav.tsx、markdown.tsx、seal.tsx、hire-form.tsx、new-template-button.tsx、template-editor.tsx、new-project-form.tsx
    workspace/workspace.tsx、agent-roster.tsx、file-panel.tsx、memory-panel.tsx、chat.tsx、message-view.tsx、delegation-card.tsx、discussion-view.tsx
  lib/
    env.ts、http.ts、auth.ts、client-api.ts、agent-output.ts、colors.ts、text.ts
    supabase/server.ts、supabase/admin.ts、supabase/proxy.ts
    schemas.ts、skills-zip.ts、sprites.ts
    services/templates.ts、services/projects.ts、services/threads.ts、services/files.ts
  scripts/redeploy-runtime.ts、scripts/smoke.ts
  test/global-setup.ts、test/helpers.ts、test/*.test.ts
```

---

### Task 1: Next.js 骨架、登入與共用基礎

**Files:**
- Create: `apps/web/**`（由 create-next-app 產生後修改）、`apps/web/lib/env.ts`、`lib/http.ts`、`lib/auth.ts`、`lib/client-api.ts`、`lib/supabase/server.ts`、`lib/supabase/admin.ts`、`lib/supabase/proxy.ts`、`proxy.ts`、`app/layout.tsx`、`app/globals.css`、`app/page.tsx`（暫時版本）、`app/login/*`、`components/nav.tsx`、`vitest.config.ts`、`test/global-setup.ts`、`test/helpers.ts`
- Test: `apps/web/test/http.test.ts`、`apps/web/test/auth.test.ts`

**Interfaces:**
- Produces（後續 Task 都會用）：
  - `env.supabaseUrl`、`env.supabasePublishableKey`、`env.supabaseSecretKey`、`env.spritesToken`、`env.vertexKey`（getter，缺值時丟錯）
  - `type Db = SupabaseClient`；`adminDb(): Db`
  - `createSessionClient(): Promise<SupabaseClient>`
  - `class HttpError(status: number, message: string)`；`route(handler)`：包裝 route handler、把 `HttpError`/`ZodError`/其他錯誤轉成 JSON；`readJson(req, schema)`
  - `currentUser(req?: Request): Promise<User | null>`、`requireUser(req?: Request): Promise<User>`
  - `api<T>(path: string, init?: RequestInit): Promise<T>`（瀏覽器端 fetch，非 2xx 時丟 `Error(error 訊息)`）
  - 測試工具：`testDb()`、`seedUser(db): Promise<{ id: string; email: string; password: string }>`

- [ ] **Step 1: 產生 Next.js 專案並整理成 monorepo 成員**

```bash
cd /Users/eric/Desktop/AgentHub/apps 2>/dev/null || mkdir -p /Users/eric/Desktop/AgentHub/apps && cd /Users/eric/Desktop/AgentHub/apps
pnpm create next-app@16.3.8 web --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-pnpm --yes --skip-install --disable-git
cd web
rm -f pnpm-workspace.yaml AGENTS.md CLAUDE.md
```

把 `apps/web/package.json` 的 `name` 改成 `"@agenthub/web"`，刪掉 `packageManager` 欄位，`scripts` 改成：

```json
{
  "dev": "node --env-file=../../.env node_modules/next/dist/bin/next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

並加入 `"engines": { "node": "24.x" }`。

安裝依賴（在 repo 根目錄）：

```bash
cd /Users/eric/Desktop/AgentHub
pnpm -F @agenthub/web add @supabase/ssr@^0.12.7 @supabase/supabase-js@^2.117.2 ai@^7.0.126 @ai-sdk/react @fly/sprites@^0.2.3 zod@^4 fflate yaml react-markdown@^10 remark-gfm@^4
pnpm -F @agenthub/web add -D @tailwindcss/typography vitest@^5 @types/node@^24 tsx
pnpm install
```

在 repo 根目錄 `pnpm-workspace.yaml` 末尾加入（pnpm 12 需要明確允許 esbuild、sharp 的安裝腳本）：

```yaml
allowBuilds:
  esbuild: true
  sharp: true
  unrs-resolver: true
```

然後再執行一次 `pnpm install`，確認沒有 `ERR_PNPM_IGNORED_BUILDS`。

- [ ] **Step 2: 共用伺服器模組**

建立 `apps/web/lib/env.ts`：

```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

export const env = {
  get supabaseUrl() { return required('SUPABASE_URL'); },
  get supabasePublishableKey() { return required('SUPABASE_PUBLISHABLE_KEY'); },
  get supabaseSecretKey() { return required('SUPABASE_SECRET_KEY'); },
  get spritesToken() { return required('FLY_SPRITES_TOKEN'); },
  get vertexKey() { return required('VERTEX_API_EXPRESS_MODE_KEY'); },
};
```

建立 `apps/web/lib/supabase/admin.ts`：

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

export type Db = SupabaseClient;

let cached: Db | undefined;

export function adminDb(): Db {
  cached ??= createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
```

建立 `apps/web/lib/supabase/server.ts`：

```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

export async function createSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Component 內無法寫 cookie；proxy 會負責更新 session
        }
      },
    },
  });
}
```

建立 `apps/web/lib/supabase/proxy.ts`：

```ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';

const PROTECTED = ['/projects', '/creator'];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  if (!data?.claims && PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }
  return response;
}
```

建立 `apps/web/proxy.ts`：

```ts
import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

建立 `apps/web/lib/http.ts`：

```ts
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function route<C>(handler: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const result = await handler(req, ctx);
      if (result instanceof Response) return result;
      return Response.json(result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) {
        return Response.json({ error: e.issues[0]?.message ?? '請求格式錯誤' }, { status: 400 });
      }
      console.error('[api]', e);
      return Response.json({ error: '伺服器發生錯誤，請稍後再試' }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, '請求內容不是有效的 JSON');
  }
  return schema.parse(body);
}
```

建立 `apps/web/lib/auth.ts`：

```ts
import type { User } from '@supabase/supabase-js';
import { HttpError } from '@/lib/http';
import { adminDb } from '@/lib/supabase/admin';
import { createSessionClient } from '@/lib/supabase/server';

export async function currentUser(req?: Request): Promise<User | null> {
  const token = req?.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    const { data, error } = await adminDb().auth.getUser(token);
    return error ? null : data.user;
  }
  const supabase = await createSessionClient();
  const { data } = await supabase.auth.getUser();
  return data.user;
}

export async function requireUser(req?: Request): Promise<User> {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, '請先登入');
  return user;
}
```

建立 `apps/web/lib/client-api.ts`：

```ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `請求失敗（${res.status}）`);
  return body as T;
}
```

- [ ] **Step 3: 設計 token、版面與導覽列**

`apps/web/app/globals.css` 整個換成：

```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";

@theme {
  --color-paper: #f4f6f9;
  --color-surface: #ffffff;
  --color-ink: #172033;
  --color-muted: #5b6578;
  --color-line: #dce1e8;
  --color-brand: #1f4e79;
  --color-brand-soft: #e3ecf5;
  --color-seal: #b8322a;
  --color-ochre: #8a6d1f;
  --font-display: var(--font-wenkai), "Noto Sans TC", serif;
  --font-sans: var(--font-noto), system-ui, sans-serif;
}

html {
  background: var(--color-paper);
  color: var(--color-ink);
}

body {
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.7;
}

:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

`apps/web/app/layout.tsx` 整個換成：

```tsx
import type { Metadata } from 'next';
import { LXGW_WenKai_TC, Noto_Sans_TC } from 'next/font/google';
import { Nav } from '@/components/nav';
import './globals.css';

const wenkai = LXGW_WenKai_TC({ weight: ['400', '700'], variable: '--font-wenkai', preload: false, display: 'swap' });
const noto = Noto_Sans_TC({ weight: ['400', '500', '700'], variable: '--font-noto', preload: false, display: 'swap' });

export const metadata: Metadata = {
  title: 'AgentHub',
  description: '雇用專業人士做好的 agent，讓他們在你的專案裡一起工作',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant-TW" className={`${wenkai.variable} ${noto.variable}`}>
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
```

如果 `next build` 回報 `LXGW_WenKai_TC` 不存在於 `next/font/google`，改成在 `globals.css` 最上方加 `@import url('https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC:wght@400;700&family=Noto+Sans+TC:wght@400;500;700&display=swap');`，並把 `--font-display` / `--font-sans` 改成直接寫字體名稱，layout 不再 import 字體。

建立 `apps/web/components/nav.tsx`：

```tsx
import Link from 'next/link';
import { signOut } from '@/app/login/actions';
import { currentUser } from '@/lib/auth';

export async function Nav() {
  const user = await currentUser();
  return (
    <header className="border-b border-line bg-surface">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="font-display text-xl font-bold text-ink">AgentHub</Link>
        <Link href="/" className="text-muted hover:text-ink">市集</Link>
        {user && <Link href="/projects" className="text-muted hover:text-ink">我的專案</Link>}
        {user && <Link href="/creator" className="text-muted hover:text-ink">我上架的 agent</Link>}
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user ? (
            <>
              <span className="text-muted">{user.email}</span>
              <form action={signOut}>
                <button className="rounded border border-line px-3 py-1 hover:border-ink">登出</button>
              </form>
            </>
          ) : (
            <Link href="/login" className="rounded bg-brand px-3 py-1 text-white">登入</Link>
          )}
        </div>
      </nav>
    </header>
  );
}
```

`apps/web/app/page.tsx` 暫時換成（Task 6 會改成市集）：

```tsx
export default function Home() {
  return <h1 className="mt-10 font-display text-[40px]">AgentHub</h1>;
}
```

- [ ] **Step 4: 登入頁**

建立 `apps/web/app/login/actions.ts`：

```ts
'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { adminDb } from '@/lib/supabase/admin';
import { createSessionClient } from '@/lib/supabase/server';

export type LoginState = { error?: string };

const Credentials = z.object({
  email: z.email('請輸入有效的 Email'),
  password: z.string().min(8, '密碼至少 8 個字元'),
});

function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/projects';
}

function parse(formData: FormData) {
  return Credentials.safeParse({ email: formData.get('email'), password: formData.get('password') });
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: 'Email 或密碼不正確' };
  redirect(safeNext(formData.get('next')));
}

export async function signUp(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = parse(formData);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { error: createError } = await adminDb().auth.admin.createUser({ ...parsed.data, email_confirm: true });
  if (createError) {
    return {
      error: /already|registered|exists/i.test(createError.message)
        ? '這個 Email 已經註冊過，請直接登入'
        : `無法建立帳號：${createError.message}`,
    };
  }
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: '帳號已建立，但登入失敗，請再試一次' };
  redirect(safeNext(formData.get('next')));
}

export async function signOut() {
  const supabase = await createSessionClient();
  await supabase.auth.signOut();
  redirect('/');
}
```

建立 `apps/web/app/login/login-form.tsx`：

```tsx
'use client';

import { useActionState } from 'react';
import { signIn, signUp, type LoginState } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [signInState, signInAction, signingIn] = useActionState<LoginState, FormData>(signIn, {});
  const [signUpState, signUpAction, signingUp] = useActionState<LoginState, FormData>(signUp, {});
  const error = signInState.error ?? signUpState.error;
  const busy = signingIn || signingUp;

  return (
    <form className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="text-sm text-muted">Email</span>
        <input name="email" type="email" required autoComplete="email"
          className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" />
      </label>
      <label className="block">
        <span className="text-sm text-muted">密碼（至少 8 個字元）</span>
        <input name="password" type="password" required minLength={8} autoComplete="current-password"
          className="mt-1 w-full rounded border border-line bg-surface px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-seal">{error}</p>}
      <div className="flex gap-3">
        <button formAction={signInAction} disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
          登入
        </button>
        <button formAction={signUpAction} disabled={busy} className="rounded border border-line px-4 py-2 disabled:opacity-60">
          建立帳號
        </button>
      </div>
    </form>
  );
}
```

建立 `apps/web/app/login/page.tsx`：

```tsx
import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto mt-12 max-w-sm">
      <h1 className="font-display text-[28px]">登入 AgentHub</h1>
      <p className="mb-6 mt-1 text-muted">還沒有帳號？填好 Email 和密碼後按「建立帳號」。</p>
      <LoginForm next={next ?? '/projects'} />
    </div>
  );
}
```

- [ ] **Step 5: 測試設定與測試**

建立 `apps/web/vitest.config.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
```

建立 `apps/web/test/global-setup.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export default function setup() {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  return async () => {
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (;;) {
      const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const testUsers = data.users.filter((u) => u.email?.endsWith('@test.local'));
      if (testUsers.length === 0) break;
      const results = await Promise.all(testUsers.map((u) => db.auth.admin.deleteUser(u.id)));
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    }
  };
}
```

建立 `apps/web/test/helpers.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { Db } from '@/lib/supabase/admin';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

export function testDb(): Db {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function seedUser(db: Db): Promise<{ id: string; email: string; password: string }> {
  const email = `u-${randomUUID()}@test.local`;
  const password = 'password-123';
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return { id: data.user.id, email, password };
}
```

（global setup 在主程序載入 `.env`，但測試檔在 worker 執行，所以 `helpers.ts` 也要載入一次；`process.loadEnvFile` 不會覆蓋已存在的變數。）

建立 `apps/web/test/http.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError, readJson, route } from '@/lib/http';

const req = (body?: string) => new Request('http://x/api', { method: 'POST', body });

describe('route', () => {
  it('回傳物件時轉成 JSON', async () => {
    const res = await route(async () => ({ a: 1 }))(req(), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('HttpError 轉成對應狀態碼與訊息', async () => {
    const res = await route(async () => { throw new HttpError(404, '找不到這個專案'); })(req(), {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '找不到這個專案' });
  });

  it('ZodError 轉成 400 並帶第一個問題', async () => {
    const res = await route(async (r) => readJson(r, z.object({ name: z.string().min(1, '請填寫名稱') })))(req('{"name":""}'), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '請填寫名稱' });
  });

  it('不是 JSON 時回 400', async () => {
    const res = await route(async (r) => readJson(r, z.object({})))(req('not json'), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '請求內容不是有效的 JSON' });
  });

  it('其他錯誤回 500，不洩漏內部訊息', async () => {
    const res = await route(async () => { throw new Error('db password wrong'); })(req(), {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '伺服器發生錯誤，請稍後再試' });
  });

  it('回傳 Response 時原樣送出', async () => {
    const res = await route(async () => new Response('raw', { status: 201 }))(req(), {});
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('raw');
  });
});
```

建立 `apps/web/test/auth.test.ts`：

```ts
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { currentUser, requireUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { seedUser, testDb } from './helpers';

const db = testDb();

describe('Bearer 驗證', () => {
  it('有效的 access token 取得使用者；無效的 token 視為未登入', async () => {
    const user = await seedUser(db);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    expect(error).toBeNull();
    const token = data.session!.access_token;

    const ok = await currentUser(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }));
    expect(ok?.id).toBe(user.id);

    const bad = new Request('http://x', { headers: { authorization: 'Bearer not-a-token' } });
    expect(await currentUser(bad)).toBeNull();
    await expect(requireUser(bad)).rejects.toBeInstanceOf(HttpError);
  });
});
```

- [ ] **Step 6: 確認測試、型別與 build**

```bash
pnpm -F @agenthub/web test
pnpm -F @agenthub/web typecheck
cd apps/web && node --env-file=../../.env node_modules/next/dist/bin/next build && cd ../..
```

Expected: 7 個測試 PASS；typecheck 無錯誤；`next build` 成功。若 build 對 `app/page.tsx` 等頁面要求靜態產生而讀不到 cookie，該頁加 `export const dynamic = 'force-dynamic';`。

- [ ] **Step 7: 本機手動確認登入**

```bash
pnpm -F @agenthub/web dev
```

瀏覽 `http://localhost:3000/login`，用 `demo-<任意>@test.local` 建立帳號 → 應導向 `/projects`（目前 404 也可以，只要導向成功、導覽列出現 Email 與「登出」）；按「登出」回到 `/`。直接開 `/projects` 應被導向 `/login?next=%2Fprojects`。

- [ ] **Step 8: Commit**

```bash
git add apps/web pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(web): Next.js 骨架、登入與共用基礎"
```

---

### Task 2: skill zip 解析與輸入格式

**Files:**
- Create: `apps/web/lib/skills-zip.ts`、`apps/web/lib/schemas.ts`
- Test: `apps/web/test/skills-zip.test.ts`、`apps/web/test/schemas.test.ts`

**Interfaces:**
- Produces:
  - `type SkillMeta = { name: string; description: string; path: string }`
  - `class SkillZipError extends Error { problems: string[] }`
  - `parseSkillsZip(bytes: Uint8Array): SkillMeta[]`（依 `path` 排序；有任何問題就丟 `SkillZipError`，列出全部問題）
  - `McpServerSchema`、`type McpServer`、`TemplateInputSchema`、`type TemplateInput`、`TemplatePatchSchema`、`type TemplatePatch`

- [ ] **Step 1: 寫測試**

建立 `apps/web/test/skills-zip.test.ts`：

```ts
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseSkillsZip, SkillZipError } from '@/lib/skills-zip';

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const skill = (name: string, description: string, body = '內容') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

function problemsOf(bytes: Uint8Array): string[] {
  try {
    parseSkillsZip(bytes);
  } catch (e) {
    if (e instanceof SkillZipError) return e.problems;
    throw e;
  }
  throw new Error('應該要丟出 SkillZipError');
}

describe('parseSkillsZip', () => {
  it('每個含 SKILL.md 的資料夾算一個 skill，path 是資料夾路徑', () => {
    expect(parseSkillsZip(zip({
      'skills/contract/SKILL.md': skill('contract-review', '審查合約風險'),
      'skills/contract/checklist.md': '清單',
      'skills/dcf/SKILL.md': skill('dcf', '現金流折現估值'),
    }))).toEqual([
      { name: 'contract-review', description: '審查合約風險', path: 'skills/contract' },
      { name: 'dcf', description: '現金流折現估值', path: 'skills/dcf' },
    ]);
  });

  it('SKILL.md 在 zip 根目錄時 path 為空字串', () => {
    expect(parseSkillsZip(zip({ 'SKILL.md': skill('solo', '單一 skill') }))).toEqual([
      { name: 'solo', description: '單一 skill', path: '' },
    ]);
  });

  it('忽略 __MACOSX 與 ._ 開頭的檔案', () => {
    expect(parseSkillsZip(zip({
      'a/SKILL.md': skill('a', 'A'),
      '__MACOSX/a/._SKILL.md': 'garbage',
      'a/._SKILL.md': 'garbage',
    }))).toHaveLength(1);
  });

  it('description 可以是 YAML 多行字串', () => {
    const text = '---\nname: multi\ndescription: >\n  第一行\n  第二行\n---\n';
    expect(parseSkillsZip(zip({ 'm/SKILL.md': text }))[0].description).toBe('第一行 第二行');
  });

  it('沒有任何 SKILL.md', () => {
    expect(problemsOf(zip({ 'readme.md': 'x' }))).toEqual(['zip 裡找不到任何 SKILL.md']);
  });

  it('逐項列出缺少的欄位與重名', () => {
    expect(problemsOf(zip({
      'a/SKILL.md': '沒有 frontmatter',
      'b/SKILL.md': '---\nname: b\n---\n',
      'c/SKILL.md': skill('dup', 'C'),
      'd/SKILL.md': skill('dup', 'D'),
    }))).toEqual([
      'a/SKILL.md：開頭缺少 --- 包住的設定區（name、description）',
      'b/SKILL.md：缺少 description',
      'd/SKILL.md：name「dup」和 c/SKILL.md 重複',
    ]);
  });

  it('不是 zip 檔', () => {
    expect(problemsOf(strToU8('not a zip'))).toEqual(['檔案不是有效的 zip']);
  });
});
```

建立 `apps/web/test/schemas.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { McpServerSchema, TemplateInputSchema, TemplatePatchSchema } from '@/lib/schemas';

describe('McpServerSchema', () => {
  it('stdio 需要 command；http 需要 url', () => {
    expect(McpServerSchema.safeParse({ name: 'a', transport: 'stdio' }).error?.issues[0].message).toBe('MCP「a」需要啟動指令');
    expect(McpServerSchema.safeParse({ name: 'b', transport: 'http' }).error?.issues[0].message).toBe('MCP「b」需要網址');
    expect(McpServerSchema.parse({ name: 'c', transport: 'stdio', command: 'npx', args: ['x'] }).required_secrets).toEqual([]);
  });

  it('名稱與金鑰名稱格式', () => {
    expect(McpServerSchema.safeParse({ name: '台股', transport: 'http', url: 'https://x.dev' }).success).toBe(false);
    expect(McpServerSchema.safeParse({
      name: 'fin', transport: 'http', url: 'https://x.dev', required_secrets: [{ key: 'lower' }],
    }).success).toBe(false);
  });
});

describe('TemplateInputSchema', () => {
  it('補上預設值並修剪空白', () => {
    expect(TemplateInputSchema.parse({ name: '  法務顧問 ' })).toEqual({
      name: '法務顧問', description: '', category: '', system_prompt: '', mcp_servers: [],
    });
  });

  it('MCP 名稱不可重複', () => {
    const r = TemplateInputSchema.safeParse({
      name: 'x',
      mcp_servers: [
        { name: 'a', transport: 'http', url: 'https://a.dev' },
        { name: 'a', transport: 'http', url: 'https://b.dev' },
      ],
    });
    expect(r.error?.issues[0].message).toBe('MCP 名稱「a」重複');
  });

  it('patch 全部欄位可省略', () => {
    expect(TemplatePatchSchema.parse({ process_upload: true })).toEqual({ process_upload: true });
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/web test test/skills-zip.test.ts test/schemas.test.ts
```

Expected: FAIL，找不到 `@/lib/skills-zip`。

- [ ] **Step 3: 實作**

建立 `apps/web/lib/skills-zip.ts`：

```ts
import { strFromU8, unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';

export type SkillMeta = { name: string; description: string; path: string };

export class SkillZipError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function isJunk(file: string): boolean {
  return file.startsWith('__MACOSX/') || file.split('/').pop()!.startsWith('._');
}

export function parseSkillsZip(bytes: Uint8Array): SkillMeta[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SkillZipError(['檔案不是有效的 zip']);
  }

  const skillFiles = Object.keys(files)
    .filter((f) => !isJunk(f) && (f === 'SKILL.md' || f.endsWith('/SKILL.md')))
    .sort();
  if (skillFiles.length === 0) throw new SkillZipError(['zip 裡找不到任何 SKILL.md']);

  const problems: string[] = [];
  const skills: SkillMeta[] = [];
  const seen = new Map<string, string>();

  for (const file of skillFiles) {
    const match = strFromU8(files[file]).match(FRONTMATTER);
    if (!match) {
      problems.push(`${file}：開頭缺少 --- 包住的設定區（name、description）`);
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      meta = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    } catch {
      problems.push(`${file}：設定區不是有效的 YAML`);
      continue;
    }
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    const description = typeof meta.description === 'string' ? meta.description.trim() : '';
    const missing = [!name && 'name', !description && 'description'].filter(Boolean);
    if (missing.length) {
      problems.push(`${file}：缺少 ${missing.join('、')}`);
      continue;
    }
    const duplicateOf = seen.get(name);
    if (duplicateOf) {
      problems.push(`${file}：name「${name}」和 ${duplicateOf} 重複`);
      continue;
    }
    seen.set(name, file);
    skills.push({ name, description, path: file.slice(0, Math.max(0, file.length - '/SKILL.md'.length)) });
  }

  if (problems.length) throw new SkillZipError(problems);
  return skills;
}
```

（`path` 計算：`skills/a/SKILL.md` → `skills/a`；根目錄 `SKILL.md` → `''`。）

建立 `apps/web/lib/schemas.ts`：

```ts
import { z } from 'zod';

export const McpServerSchema = z
  .object({
    name: z.string().trim().min(1, 'MCP 需要名稱').regex(/^[A-Za-z0-9_-]+$/, 'MCP 名稱只能用英數字、- 和 _'),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().optional(),
    args: z.array(z.string()).optional(),
    url: z.url('MCP 網址格式不正確').optional(),
    headers: z.record(z.string(), z.string()).optional(),
    required_secrets: z
      .array(z.object({
        key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, '金鑰名稱只能用大寫英文、數字和底線，且以英文開頭'),
        description: z.string().optional(),
      }))
      .default([]),
  })
  .superRefine((s, ctx) => {
    if (s.transport === 'stdio' && !s.command) {
      ctx.addIssue({ code: 'custom', message: `MCP「${s.name}」需要啟動指令`, path: ['command'] });
    }
    if (s.transport === 'http' && !s.url) {
      ctx.addIssue({ code: 'custom', message: `MCP「${s.name}」需要網址`, path: ['url'] });
    }
  });

export type McpServer = z.infer<typeof McpServerSchema>;

const McpServerList = z.array(McpServerSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.name)) ctx.addIssue({ code: 'custom', message: `MCP 名稱「${s.name}」重複` });
    seen.add(s.name);
  }
});

const TemplateFields = {
  name: z.string().trim().min(1, '請填寫名稱').max(60, '名稱最多 60 個字'),
  description: z.string().trim().max(500, '介紹最多 500 個字'),
  category: z.string().trim().max(30, '分類最多 30 個字'),
  system_prompt: z.string(),
  mcp_servers: McpServerList,
};

export const TemplateInputSchema = z.object({
  name: TemplateFields.name,
  description: TemplateFields.description.default(''),
  category: TemplateFields.category.default(''),
  system_prompt: TemplateFields.system_prompt.default(''),
  mcp_servers: TemplateFields.mcp_servers.default([]),
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export const TemplatePatchSchema = z.object({
  name: TemplateFields.name.optional(),
  description: TemplateFields.description.optional(),
  category: TemplateFields.category.optional(),
  system_prompt: TemplateFields.system_prompt.optional(),
  mcp_servers: TemplateFields.mcp_servers.optional(),
  process_upload: z.boolean().optional(),
});
export type TemplatePatch = z.infer<typeof TemplatePatchSchema>;
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/web test test/skills-zip.test.ts test/schemas.test.ts
pnpm -F @agenthub/web typecheck
```

Expected: 12 個測試 PASS；typecheck 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): skill zip 解析與輸入格式"
```

---

### Task 3: 範本 service 與 API

**Files:**
- Create: `apps/web/lib/services/templates.ts`
- Create: `apps/web/app/api/templates/route.ts`、`app/api/templates/[id]/route.ts`、`app/api/templates/[id]/publish/route.ts`、`app/api/templates/[id]/upload-url/route.ts`
- Test: `apps/web/test/templates.test.ts`

**Interfaces:**
- Consumes: `Db`、`HttpError`、`route`、`readJson`、`requireUser`、`currentUser`、`adminDb`（Task 1）；`parseSkillsZip`、`SkillZipError`、`SkillMeta`、`TemplateInputSchema`、`TemplatePatchSchema`、`McpServer`（Task 2）
- Produces:
  - `type TemplateRow = { id; creator_id; name; description; category; system_prompt; skills_zip_path: string | null; skills: SkillMeta[]; mcp_servers: McpServer[]; status: 'draft' | 'published'; created_at; updated_at }`
  - `type PublishedTemplate = TemplateRow & { creator_name: string }`
  - `listPublishedTemplates(db): Promise<PublishedTemplate[]>`
  - `listMyTemplates(db, userId): Promise<TemplateRow[]>`
  - `getTemplate(db, id, viewerId: string | null): Promise<PublishedTemplate>`（已上架或自己的；否則 404「找不到這個 agent」）
  - `createTemplate(db, userId, input: TemplateInput): Promise<TemplateRow>`
  - `updateTemplate(db, userId, id, patch: TemplatePatch): Promise<TemplateRow>`
  - `createSkillsUploadUrl(db, userId, id): Promise<{ signedUrl: string; path: string }>`
  - `publishTemplate(db, userId, id): Promise<TemplateRow>`（system prompt 空白時 400「請先填寫 system prompt」）
  - API：`GET /api/templates`（市集）、`GET /api/templates?mine=1`、`POST /api/templates`、`GET/PATCH /api/templates/:id`、`POST /api/templates/:id/publish`、`POST /api/templates/:id/upload-url`

- [ ] **Step 1: 寫測試**

建立 `apps/web/test/templates.test.ts`：

```ts
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  createSkillsUploadUrl, createTemplate, getTemplate, listMyTemplates, listPublishedTemplates, publishTemplate, updateTemplate,
} from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function uploadViaSignedUrl(signedUrl: string, bytes: Uint8Array) {
  const res = await fetch(signedUrl, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
  expect(res.ok).toBe(true);
}

const goodZip = () => zipSync({ 'review/SKILL.md': strToU8('---\nname: review\ndescription: 審合約\n---\n') });

async function expectStatus(p: Promise<unknown>, status: number, message?: string) {
  const e = await p.then(() => { throw new Error('應該失敗'); }, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (message) expect((e as HttpError).message).toBe(message);
}

describe('templates service', () => {
  it('建立草稿、只有自己看得到；上架後出現在市集', async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    const t = await createTemplate(db, creator.id, {
      name: '法務顧問', description: '契約審查', category: '法律', system_prompt: '你是律師', mcp_servers: [],
    });
    expect(t.status).toBe('draft');
    expect((await listMyTemplates(db, creator.id)).map((x) => x.id)).toContain(t.id);
    await expectStatus(getTemplate(db, t.id, other.id), 404, '找不到這個 agent');
    await expectStatus(getTemplate(db, t.id, null), 404);
    expect((await getTemplate(db, t.id, creator.id)).name).toBe('法務顧問');

    await publishTemplate(db, creator.id, t.id);
    const listed = (await listPublishedTemplates(db)).find((x) => x.id === t.id);
    expect(listed?.creator_name).toBe(creator.email.split('@')[0]);
    expect((await getTemplate(db, t.id, null)).status).toBe('published');
  });

  it('別人不能修改或上架', async () => {
    const creator = await seedUser(db);
    const other = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    await expectStatus(updateTemplate(db, other.id, t.id, { name: 'hack' }), 404);
    await expectStatus(publishTemplate(db, other.id, t.id), 404);
    await expectStatus(createSkillsUploadUrl(db, other.id, t.id), 404);
  });

  it('system prompt 空白不能上架', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: '  ', mcp_servers: [] });
    await expectStatus(publishTemplate(db, creator.id, t.id), 400, '請先填寫 system prompt');
  });

  it('上傳 skill zip 後處理：解析 skill、檔名換成內容雜湊、刪掉暫存檔', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const { signedUrl, path } = await createSkillsUploadUrl(db, creator.id, t.id);
    expect(path).toBe(`${t.id}/upload.zip`);
    await uploadViaSignedUrl(signedUrl, goodZip());

    const updated = await updateTemplate(db, creator.id, t.id, { process_upload: true, name: '新名字' });
    expect(updated.name).toBe('新名字');
    expect(updated.skills).toEqual([{ name: 'review', description: '審合約', path: 'review' }]);
    expect(updated.skills_zip_path).toMatch(new RegExp(`^${t.id}/[0-9a-f]{64}\\.zip$`));
    const { data: list } = await db.storage.from('skills').list(t.id);
    expect(list!.map((o) => o.name)).not.toContain('upload.zip');
  });

  it('skill zip 有問題時 400 並列出全部問題，資料不變', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const { signedUrl } = await createSkillsUploadUrl(db, creator.id, t.id);
    await uploadViaSignedUrl(signedUrl, zipSync({ 'a/SKILL.md': strToU8('沒有設定區') }));
    await expectStatus(
      updateTemplate(db, creator.id, t.id, { process_upload: true }),
      400,
      'a/SKILL.md：開頭缺少 --- 包住的設定區（name、description）',
    );
    expect((await getTemplate(db, t.id, creator.id)).skills_zip_path).toBeNull();
  });

  it('還沒上傳就要求處理：400', async () => {
    const creator = await seedUser(db);
    const t = await createTemplate(db, creator.id, { name: 'x', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    await expectStatus(updateTemplate(db, creator.id, t.id, { process_upload: true }), 400, '還沒有上傳 skill 檔案');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/web test test/templates.test.ts
```

Expected: FAIL，找不到 `@/lib/services/templates`。

- [ ] **Step 3: 實作 service**

建立 `apps/web/lib/services/templates.ts`：

```ts
import { createHash } from 'node:crypto';
import { HttpError } from '@/lib/http';
import type { McpServer, TemplateInput, TemplatePatch } from '@/lib/schemas';
import { parseSkillsZip, SkillZipError, type SkillMeta } from '@/lib/skills-zip';
import type { Db } from '@/lib/supabase/admin';

export type TemplateRow = {
  id: string;
  creator_id: string;
  name: string;
  description: string;
  category: string;
  system_prompt: string;
  skills_zip_path: string | null;
  skills: SkillMeta[];
  mcp_servers: McpServer[];
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
};

export type PublishedTemplate = TemplateRow & { creator_name: string };

const COLUMNS = 'id, creator_id, name, description, category, system_prompt, skills_zip_path, skills, mcp_servers, status, created_at, updated_at';
const WITH_CREATOR = `${COLUMNS}, creator:profiles(display_name)`;
const NOT_FOUND = '找不到這個 agent';

function withCreatorName(row: Record<string, unknown>): PublishedTemplate {
  const { creator, ...rest } = row;
  return { ...(rest as TemplateRow), creator_name: (creator as { display_name: string } | null)?.display_name ?? '' };
}

export async function listPublishedTemplates(db: Db): Promise<PublishedTemplate[]> {
  const { data, error } = await db.from('agent_templates').select(WITH_CREATOR).eq('status', 'published').order('updated_at', { ascending: false });
  if (error) throw error;
  return data.map(withCreatorName);
}

export async function listMyTemplates(db: Db, userId: string): Promise<TemplateRow[]> {
  const { data, error } = await db.from('agent_templates').select(COLUMNS).eq('creator_id', userId).order('updated_at', { ascending: false });
  if (error) throw error;
  return data as TemplateRow[];
}

export async function getTemplate(db: Db, id: string, viewerId: string | null): Promise<PublishedTemplate> {
  const { data, error } = await db.from('agent_templates').select(WITH_CREATOR).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NOT_FOUND);
  const row = withCreatorName(data);
  if (row.status !== 'published' && row.creator_id !== viewerId) throw new HttpError(404, NOT_FOUND);
  return row;
}

async function getOwnTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').select(COLUMNS).eq('id', id).eq('creator_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, NOT_FOUND);
  return data as TemplateRow;
}

export async function createTemplate(db: Db, userId: string, input: TemplateInput): Promise<TemplateRow> {
  const { data, error } = await db.from('agent_templates').insert({ ...input, creator_id: userId }).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

export async function createSkillsUploadUrl(db: Db, userId: string, id: string): Promise<{ signedUrl: string; path: string }> {
  await getOwnTemplate(db, userId, id);
  const path = `${id}/upload.zip`;
  const { data, error } = await db.storage.from('skills').createSignedUploadUrl(path, { upsert: true });
  if (error) throw error;
  return { signedUrl: data.signedUrl, path };
}

async function processSkillsUpload(db: Db, id: string): Promise<{ skills_zip_path: string; skills: SkillMeta[] }> {
  const bucket = db.storage.from('skills');
  const uploadPath = `${id}/upload.zip`;
  const { data: blob, error } = await bucket.download(uploadPath);
  if (error || !blob) throw new HttpError(400, '還沒有上傳 skill 檔案');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let skills: SkillMeta[];
  try {
    skills = parseSkillsZip(bytes);
  } catch (e) {
    if (e instanceof SkillZipError) throw new HttpError(400, e.problems.join('\n'));
    throw e;
  }

  const sha = createHash('sha256').update(bytes).digest('hex');
  const finalPath = `${id}/${sha}.zip`;
  const { error: uploadError } = await bucket.upload(finalPath, bytes, { contentType: 'application/zip', upsert: true });
  if (uploadError) throw uploadError;
  await bucket.remove([uploadPath]);
  return { skills_zip_path: finalPath, skills };
}

export async function updateTemplate(db: Db, userId: string, id: string, patch: TemplatePatch): Promise<TemplateRow> {
  await getOwnTemplate(db, userId, id);
  const { process_upload, ...fields } = patch;
  const changes: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() };
  if (process_upload) Object.assign(changes, await processSkillsUpload(db, id));
  const { data, error } = await db.from('agent_templates').update(changes).eq('id', id).select(COLUMNS).single();
  if (error) throw error;
  return data as TemplateRow;
}

export async function publishTemplate(db: Db, userId: string, id: string): Promise<TemplateRow> {
  const template = await getOwnTemplate(db, userId, id);
  if (!template.system_prompt.trim()) throw new HttpError(400, '請先填寫 system prompt');
  const { data, error } = await db
    .from('agent_templates')
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as TemplateRow;
}
```

- [ ] **Step 4: 建立 API route**

建立 `apps/web/app/api/templates/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { TemplateInputSchema } from '@/lib/schemas';
import { createTemplate, listMyTemplates, listPublishedTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request) => {
  if (new URL(req.url).searchParams.get('mine') === '1') {
    const user = await requireUser(req);
    return listMyTemplates(adminDb(), user.id);
  }
  return listPublishedTemplates(adminDb());
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  return createTemplate(adminDb(), user.id, await readJson(req, TemplateInputSchema));
});
```

建立 `apps/web/app/api/templates/[id]/route.ts`：

```ts
import { currentUser, requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { TemplatePatchSchema } from '@/lib/schemas';
import { getTemplate, updateTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await currentUser(req);
  return getTemplate(adminDb(), (await params).id, user?.id ?? null);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return updateTemplate(adminDb(), user.id, (await params).id, await readJson(req, TemplatePatchSchema));
});
```

建立 `apps/web/app/api/templates/[id]/publish/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { publishTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return publishTemplate(adminDb(), user.id, (await params).id);
});
```

建立 `apps/web/app/api/templates/[id]/upload-url/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { createSkillsUploadUrl } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return createSkillsUploadUrl(adminDb(), user.id, (await params).id);
});
```

- [ ] **Step 5: 確認測試通過與 build**

```bash
pnpm -F @agenthub/web test test/templates.test.ts
pnpm -F @agenthub/web typecheck
cd apps/web && node --env-file=../../.env node_modules/next/dist/bin/next build && cd ../..
```

Expected: 6 個測試 PASS；typecheck 無錯誤；build 成功。若簽名網址 `PUT` 原始 bytes 回 400，改成 `FormData`（欄位名稱空字串 `''`、值為 `Blob`）上傳，並在報告說明。

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): 範本 service 與 API"
```

---

### Task 4: 專案、啟用、對話、檔案、記憶的 service 與 API

**Files:**
- Create: `apps/web/lib/services/projects.ts`、`lib/services/threads.ts`、`lib/services/files.ts`
- Create: `app/api/projects/route.ts`（只有 GET；POST 在 Task 5）、`app/api/projects/[id]/route.ts`（只有 GET；DELETE 在 Task 5）、`app/api/projects/[id]/agents/route.ts`、`app/api/projects/[id]/threads/route.ts`、`app/api/projects/[id]/files/route.ts`、`app/api/projects/[id]/files/upload-url/route.ts`、`app/api/projects/[id]/memories/route.ts`、`app/api/threads/[id]/messages/route.ts`
- Test: `apps/web/test/projects.test.ts`、`test/threads.test.ts`、`test/files.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Db`、`HttpError`、`route`、`readJson`、`requireUser`、`adminDb`；Task 2 的 `SkillMeta`；Task 3 的 `createTemplate`、`publishTemplate`（只在測試裡用）
- Produces:
  - `type ProjectRow = { id; owner_id; name; sprite_name: string | null; sprite_url: string | null; sprite_status: 'provisioning' | 'ready' | 'error'; sprite_error: string | null; created_at }`
  - `type AgentSummary = { id; name; description; role: 'consultant' | 'manager'; template_id: string | null; skills: SkillMeta[]; mcp_names: string[] }`
  - `type ThreadRow = { id; project_id; title; created_at }`
  - `type ProjectDetail = { project: ProjectRow; agents: AgentSummary[]; threads: ThreadRow[] }`
  - `listProjects(db, userId)`、`createProject(db, userId, name): Promise<ProjectRow>`、`getOwnProject(db, userId, id): Promise<ProjectRow>`、`getProjectDetail(db, userId, id): Promise<ProjectDetail>`、`setSpriteState(db, id, patch)`、`deleteOwnProject(db, userId, id): Promise<ProjectRow>`
  - `hireAgent(db, userId, projectId, templateId, secrets: Record<string, Record<string, string>>): Promise<string>`
  - `listThreads(db, userId, projectId)`、`createThread(db, userId, projectId, title?)`、`getOwnThread(db, userId, threadId): Promise<{ thread: ThreadRow; project: ProjectRow }>`
  - `type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null }`；`getThreadMessages(db, userId, threadId): Promise<ThreadMessages>`
  - `type MemoryView = { id; instance_id: string | null; agent_name: string | null; content; created_at }`；`listMemories`、`updateMemory(db, userId, projectId, memoryId, content)`、`deleteMemory(db, userId, projectId, memoryId)`
  - `storageFileName(name: string): string`、`createFileUploadUrl(db, userId, projectId, filename): Promise<{ signedUrl: string; name: string }>`、`listFiles(db, userId, projectId): Promise<{ name: string; size: number; updated_at: string | null }[]>`

- [ ] **Step 1: 寫測試**

建立 `apps/web/test/projects.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  createProject, deleteOwnProject, getOwnProject, getProjectDetail, hireAgent, listProjects, setSpriteState,
} from '@/lib/services/projects';
import { createTemplate, publishTemplate } from '@/lib/services/templates';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function expectStatus(p: Promise<unknown>, status: number, message?: string) {
  const e = await p.then(() => { throw new Error('應該失敗'); }, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (message) expect((e as HttpError).message).toBe(message);
}

async function publishedTemplate(creatorId: string, fields: Record<string, unknown> = {}) {
  const t = await createTemplate(db, creatorId, {
    name: '財務顧問', description: '財報分析', category: '財務', system_prompt: '你是會計師', mcp_servers: [], ...fields,
  });
  await publishTemplate(db, creatorId, t.id);
  return t.id;
}

describe('projects service', () => {
  it('建立、列出、只有擁有者看得到', async () => {
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const p = await createProject(db, owner.id, '新產品上市');
    expect(p.sprite_status).toBe('provisioning');
    expect((await listProjects(db, owner.id)).map((x) => x.id)).toEqual([p.id]);
    expect(await listProjects(db, other.id)).toEqual([]);
    await expectStatus(getOwnProject(db, other.id, p.id), 404, '找不到這個專案');
    await expectStatus(getProjectDetail(db, other.id, p.id), 404);
    await expectStatus(deleteOwnProject(db, other.id, p.id), 404);
  });

  it('setSpriteState 更新狀態；刪除專案回傳被刪的資料', async () => {
    const owner = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    await setSpriteState(db, p.id, { sprite_status: 'ready', sprite_url: 'https://s.example' });
    expect((await getOwnProject(db, owner.id, p.id)).sprite_url).toBe('https://s.example');
    expect((await deleteOwnProject(db, owner.id, p.id)).id).toBe(p.id);
    await expectStatus(getOwnProject(db, owner.id, p.id), 404);
  });

  it('啟用 agent：第 2 位顧問時出現主管；detail 帶出 skill 與 MCP 名稱，不帶金鑰', async () => {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    const withMcp = await publishedTemplate(creator.id, {
      name: '法務顧問',
      mcp_servers: [{ name: 'law', transport: 'http', url: 'https://law.example', required_secrets: [{ key: 'LAW_KEY' }] }],
    });
    const plain = await publishedTemplate(creator.id);
    const p = await createProject(db, owner.id, 'p');

    await hireAgent(db, owner.id, p.id, withMcp, { law: { LAW_KEY: 'k' } });
    await hireAgent(db, owner.id, p.id, plain, {});
    const detail = await getProjectDetail(db, owner.id, p.id);
    expect(detail.agents.map((a) => [a.name, a.role])).toEqual([['法務顧問', 'consultant'], ['財務顧問', 'consultant'], ['主管', 'manager']]);
    expect(detail.agents[0].mcp_names).toEqual(['law']);
    expect(JSON.stringify(detail)).not.toContain('"k"');
  });

  it('啟用 agent 的錯誤：缺金鑰 400、未上架 404、別人的專案 404', async () => {
    const creator = await seedUser(db);
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const withMcp = await publishedTemplate(creator.id, {
      mcp_servers: [{ name: 'law', transport: 'http', url: 'https://law.example', required_secrets: [{ key: 'LAW_KEY' }] }],
    });
    const draft = await createTemplate(db, creator.id, { name: 'd', description: '', category: '', system_prompt: 'p', mcp_servers: [] });
    const p = await createProject(db, owner.id, 'p');

    await expectStatus(hireAgent(db, owner.id, p.id, withMcp, {}), 400, '請填寫金鑰：law.LAW_KEY');
    await expectStatus(hireAgent(db, owner.id, p.id, draft.id, {}), 404, '這個 agent 尚未上架');
    await expectStatus(hireAgent(db, other.id, p.id, withMcp, { law: { LAW_KEY: 'k' } }), 404, '找不到這個專案');
    expect((await getProjectDetail(db, owner.id, p.id)).agents).toEqual([]);
  });
});
```

建立 `apps/web/test/threads.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { createProject } from '@/lib/services/projects';
import {
  createThread, deleteMemory, getOwnThread, getThreadMessages, listMemories, listThreads, updateMemory,
} from '@/lib/services/threads';
import { seedUser, testDb } from './helpers';

const db = testDb();

async function setup() {
  const owner = await seedUser(db);
  const project = await createProject(db, owner.id, 'p');
  const thread = await createThread(db, owner.id, project.id);
  return { owner, project, thread };
}

describe('threads service', () => {
  it('建立與列出對話；別人拿不到', async () => {
    const { owner, project, thread } = await setup();
    const other = await seedUser(db);
    expect(thread.title).toBe('新對話');
    expect((await listThreads(db, owner.id, project.id)).map((t) => t.id)).toEqual([thread.id]);
    expect((await getOwnThread(db, owner.id, thread.id)).project.id).toBe(project.id);
    const e = await getOwnThread(db, other.id, thread.id).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(404);
  });

  it('messages 只回 user 與 final 的 ui_message，依時間排序；running 與 error 反映最新 run', async () => {
    const { owner, thread } = await setup();
    const { data: run } = await db.from('runs').insert({ thread_id: thread.id }).select('id').single();
    const ui = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', text }] });
    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'user', content: 'Q', ui_message: ui('u1', 'user', 'Q') });
    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'delegation', content: 'internal' });

    let r = await getThreadMessages(db, owner.id, thread.id);
    expect(r).toEqual({ messages: [ui('u1', 'user', 'Q')], running: true, error: null });

    await db.from('messages').insert({ thread_id: thread.id, run_id: run!.id, kind: 'final', content: 'A', ui_message: ui('a1', 'assistant', 'A') });
    await db.from('runs').update({ status: 'failed', error: '模型掛了' }).eq('id', run!.id);
    r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(r.running).toBe(false);
    expect(r.error).toBe('模型掛了');
  });

  it('running 超過 20 分鐘視為失敗', async () => {
    const { owner, thread } = await setup();
    await db.from('runs').insert({ thread_id: thread.id, started_at: new Date(Date.now() - 21 * 60_000).toISOString() });
    const r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.running).toBe(false);
    expect(r.error).toBe('這次回覆超過 20 分鐘沒有完成');
  });

  it('記憶：列出（帶 agent 名稱）、修改、刪除；別人的專案 404', async () => {
    const { owner, project } = await setup();
    const other = await seedUser(db);
    const { data: agent } = await db.from('agent_instances').insert({ project_id: project.id, role: 'consultant', name: '法務顧問' }).select('id').single();
    const { data: m1 } = await db.from('memories').insert({ project_id: project.id, instance_id: agent!.id, content: '私有記憶' }).select('id').single();
    await db.from('memories').insert({ project_id: project.id, content: '專案記憶' });

    const list = await listMemories(db, owner.id, project.id);
    expect(list.map((m) => [m.content, m.agent_name]).sort()).toEqual([['專案記憶', null], ['私有記憶', '法務顧問']]);

    await updateMemory(db, owner.id, project.id, m1!.id, '改過的記憶');
    expect((await listMemories(db, owner.id, project.id)).map((m) => m.content)).toContain('改過的記憶');
    await deleteMemory(db, owner.id, project.id, m1!.id);
    expect(await listMemories(db, owner.id, project.id)).toHaveLength(1);

    const e = await listMemories(db, other.id, project.id).catch((err) => err);
    expect((e as HttpError).status).toBe(404);
  });
});
```

建立 `apps/web/test/files.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createFileUploadUrl, listFiles, storageFileName } from '@/lib/services/files';
import { createProject } from '@/lib/services/projects';
import { seedUser, testDb } from './helpers';

const db = testDb();

describe('storageFileName', () => {
  it('去掉路徑，只留 Storage 接受的字元', () => {
    expect(storageFileName('../../etc/passwd')).toBe('passwd');
    expect(storageFileName('Q3 report (final).pdf')).toBe('Q3_report_(final).pdf');
    expect(storageFileName('財報.pdf')).toMatch(/^file_\d+\.pdf$/);
    expect(storageFileName('2026財報v2.xlsx')).toBe('2026__v2.xlsx');
  });
});

describe('files service', () => {
  it('取得上傳網址、上傳後列得出來；別人的專案 404', async () => {
    const owner = await seedUser(db);
    const other = await seedUser(db);
    const p = await createProject(db, owner.id, 'p');
    const { signedUrl, name } = await createFileUploadUrl(db, owner.id, p.id, 'brief.md');
    expect(name).toBe('brief.md');
    const res = await fetch(signedUrl, { method: 'PUT', body: '# 需求', headers: { 'content-type': 'text/markdown', 'x-upsert': 'true' } });
    expect(res.ok).toBe(true);
    expect((await listFiles(db, owner.id, p.id)).map((f) => f.name)).toEqual(['brief.md']);
    const e = await listFiles(db, other.id, p.id).catch((err) => err);
    expect(e.status).toBe(404);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/web test test/projects.test.ts test/threads.test.ts test/files.test.ts
```

Expected: FAIL，找不到 `@/lib/services/projects`。

- [ ] **Step 3: 實作 services**

建立 `apps/web/lib/services/projects.ts`：

```ts
import { HttpError } from '@/lib/http';
import type { SkillMeta } from '@/lib/skills-zip';
import type { Db } from '@/lib/supabase/admin';

export type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  sprite_name: string | null;
  sprite_url: string | null;
  sprite_status: 'provisioning' | 'ready' | 'error';
  sprite_error: string | null;
  created_at: string;
};

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  role: 'consultant' | 'manager';
  template_id: string | null;
  skills: SkillMeta[];
  mcp_names: string[];
};

export type ThreadRow = { id: string; project_id: string; title: string; created_at: string };

export type ProjectDetail = { project: ProjectRow; agents: AgentSummary[]; threads: ThreadRow[] };

const COLUMNS = 'id, owner_id, name, sprite_name, sprite_url, sprite_status, sprite_error, created_at';

export async function listProjects(db: Db, userId: string): Promise<ProjectRow[]> {
  const { data, error } = await db.from('projects').select(COLUMNS).eq('owner_id', userId).order('created_at', { ascending: false });
  if (error) throw error;
  return data as ProjectRow[];
}

export async function createProject(db: Db, userId: string, name: string): Promise<ProjectRow> {
  const { data, error } = await db.from('projects').insert({ owner_id: userId, name }).select(COLUMNS).single();
  if (error) throw error;
  return data as ProjectRow;
}

export async function getOwnProject(db: Db, userId: string, id: string): Promise<ProjectRow> {
  const { data, error } = await db.from('projects').select(COLUMNS).eq('id', id).eq('owner_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這個專案');
  return data as ProjectRow;
}

export async function getProjectDetail(db: Db, userId: string, id: string): Promise<ProjectDetail> {
  const project = await getOwnProject(db, userId, id);
  const [agentsResult, threadsResult] = await Promise.all([
    db.from('agent_instances').select('id, name, description, role, template_id, skills, mcp_servers').eq('project_id', id).order('created_at'),
    db.from('threads').select('id, project_id, title, created_at').eq('project_id', id).order('created_at', { ascending: false }),
  ]);
  if (agentsResult.error) throw agentsResult.error;
  if (threadsResult.error) throw threadsResult.error;
  const agents = agentsResult.data
    .map(({ mcp_servers, ...a }) => ({ ...a, mcp_names: (mcp_servers as { name: string }[]).map((s) => s.name) }) as AgentSummary)
    .sort((a, b) => Number(a.role === 'manager') - Number(b.role === 'manager'));
  return { project, agents, threads: threadsResult.data as ThreadRow[] };
}

export async function setSpriteState(
  db: Db,
  id: string,
  patch: Partial<Pick<ProjectRow, 'sprite_name' | 'sprite_url' | 'sprite_status' | 'sprite_error'>>,
): Promise<void> {
  const { error } = await db.from('projects').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteOwnProject(db: Db, userId: string, id: string): Promise<ProjectRow> {
  const project = await getOwnProject(db, userId, id);
  const { error } = await db.from('projects').delete().eq('id', id);
  if (error) throw error;
  return project;
}

export async function hireAgent(
  db: Db,
  userId: string,
  projectId: string,
  templateId: string,
  secrets: Record<string, Record<string, string>>,
): Promise<string> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db.rpc('hire_agent', { p_project_id: projectId, p_template_id: templateId, p_secrets: secrets });
  if (error) {
    if (error.code === '22023') throw new HttpError(400, `請填寫金鑰：${error.message.replace('missing secret ', '')}`);
    if (error.code === 'P0002') throw new HttpError(404, '這個 agent 尚未上架');
    throw error;
  }
  return data as string;
}
```

建立 `apps/web/lib/services/threads.ts`：

```ts
import type { UIMessage } from 'ai';
import { HttpError } from '@/lib/http';
import type { Db } from '@/lib/supabase/admin';
import { getOwnProject, type ProjectRow, type ThreadRow } from './projects';

export type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null };

export type MemoryView = { id: string; instance_id: string | null; agent_name: string | null; content: string; created_at: string };

const STALE_RUN_MS = 20 * 60_000;

export async function listThreads(db: Db, userId: string, projectId: string): Promise<ThreadRow[]> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db.from('threads').select('id, project_id, title, created_at').eq('project_id', projectId).order('created_at', { ascending: false });
  if (error) throw error;
  return data as ThreadRow[];
}

export async function createThread(db: Db, userId: string, projectId: string, title?: string): Promise<ThreadRow> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db
    .from('threads')
    .insert({ project_id: projectId, ...(title ? { title } : {}) })
    .select('id, project_id, title, created_at')
    .single();
  if (error) throw error;
  return data as ThreadRow;
}

export async function getOwnThread(db: Db, userId: string, threadId: string): Promise<{ thread: ThreadRow; project: ProjectRow }> {
  const { data, error } = await db.from('threads').select('id, project_id, title, created_at').eq('id', threadId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, '找不到這串對話');
  const project = await getOwnProject(db, userId, data.project_id).catch(() => {
    throw new HttpError(404, '找不到這串對話');
  });
  return { thread: data as ThreadRow, project };
}

export async function getThreadMessages(db: Db, userId: string, threadId: string): Promise<ThreadMessages> {
  await getOwnThread(db, userId, threadId);
  const [messagesResult, runResult] = await Promise.all([
    db.from('messages').select('ui_message').eq('thread_id', threadId).in('kind', ['user', 'final']).order('created_at'),
    db.from('runs').select('status, error, started_at').eq('thread_id', threadId).order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (messagesResult.error) throw messagesResult.error;
  if (runResult.error) throw runResult.error;

  const messages = messagesResult.data.map((m) => m.ui_message as UIMessage | null).filter((m): m is UIMessage => !!m);
  const run = runResult.data;
  if (!run) return { messages, running: false, error: null };
  if (run.status === 'running') {
    const stale = Date.now() - new Date(run.started_at).getTime() > STALE_RUN_MS;
    return { messages, running: !stale, error: stale ? '這次回覆超過 20 分鐘沒有完成' : null };
  }
  return { messages, running: false, error: run.status === 'failed' ? run.error : null };
}

export async function listMemories(db: Db, userId: string, projectId: string): Promise<MemoryView[]> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db
    .from('memories')
    .select('id, instance_id, content, created_at, agent:agent_instances!memories_instance_id_fkey(name)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(({ agent, ...m }) => ({ ...m, agent_name: (agent as { name: string } | null)?.name ?? null }) as MemoryView);
}

export async function updateMemory(db: Db, userId: string, projectId: string, memoryId: string, content: string): Promise<void> {
  await getOwnProject(db, userId, projectId);
  const { error } = await db
    .from('memories')
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', memoryId)
    .eq('project_id', projectId);
  if (error) throw error;
}

export async function deleteMemory(db: Db, userId: string, projectId: string, memoryId: string): Promise<void> {
  await getOwnProject(db, userId, projectId);
  const { error } = await db.from('memories').delete().eq('id', memoryId).eq('project_id', projectId);
  if (error) throw error;
}
```

建立 `apps/web/lib/services/files.ts`：

```ts
import type { Db } from '@/lib/supabase/admin';
import { getOwnProject } from './projects';

export function storageFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').trim();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot).replace(/[^A-Za-z0-9.]/g, '') : '';
  const cleaned = base.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._()-]/g, '_').replace(/^\.+/, '');
  const stem = dot > 0 ? cleaned.slice(0, cleaned.length - ext.length) : cleaned;
  if (!/[A-Za-z0-9]/.test(stem)) return `file_${Date.now()}${ext}`;
  return cleaned;
}

export async function createFileUploadUrl(
  db: Db,
  userId: string,
  projectId: string,
  filename: string,
): Promise<{ signedUrl: string; name: string }> {
  await getOwnProject(db, userId, projectId);
  const name = storageFileName(filename);
  const { data, error } = await db.storage.from('project-files').createSignedUploadUrl(`${projectId}/${name}`, { upsert: true });
  if (error) throw error;
  return { signedUrl: data.signedUrl, name };
}

export async function listFiles(db: Db, userId: string, projectId: string): Promise<{ name: string; size: number; updated_at: string | null }[]> {
  await getOwnProject(db, userId, projectId);
  const { data, error } = await db.storage.from('project-files').list(projectId, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw error;
  return data
    .filter((o) => o.id !== null)
    .map((o) => ({ name: o.name, size: (o.metadata as { size?: number } | null)?.size ?? 0, updated_at: o.updated_at ?? null }));
}
```

- [ ] **Step 4: 建立 API route**

建立 `apps/web/app/api/projects/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { listProjects } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  return listProjects(adminDb(), user.id);
});
```

建立 `apps/web/app/api/projects/[id]/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getProjectDetail } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return getProjectDetail(adminDb(), user.id, (await params).id);
});
```

建立 `apps/web/app/api/projects/[id]/agents/route.ts`：

```ts
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { hireAgent } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

const Body = z.object({
  template_id: z.uuid('請選擇要加入的 agent'),
  secrets: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const body = await readJson(req, Body);
  const instanceId = await hireAgent(adminDb(), user.id, (await params).id, body.template_id, body.secrets);
  return { id: instanceId };
});
```

建立 `apps/web/app/api/projects/[id]/threads/route.ts`：

```ts
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createThread, listThreads } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return listThreads(adminDb(), user.id, (await params).id);
});

export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { title } = await readJson(req, z.object({ title: z.string().trim().max(60).optional() }));
  return createThread(adminDb(), user.id, (await params).id, title || undefined);
});
```

建立 `apps/web/app/api/projects/[id]/files/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { listFiles } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return listFiles(adminDb(), user.id, (await params).id);
});
```

建立 `apps/web/app/api/projects/[id]/files/upload-url/route.ts`：

```ts
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createFileUploadUrl } from '@/lib/services/files';
import { adminDb } from '@/lib/supabase/admin';

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { filename } = await readJson(req, z.object({ filename: z.string().min(1, '缺少檔名') }));
  return createFileUploadUrl(adminDb(), user.id, (await params).id, filename);
});
```

建立 `apps/web/app/api/projects/[id]/memories/route.ts`：

```ts
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { HttpError, readJson, route } from '@/lib/http';
import { deleteMemory, listMemories, updateMemory } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  return listMemories(adminDb(), user.id, (await params).id);
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const body = await readJson(req, z.object({ id: z.uuid(), content: z.string().trim().min(1, '記憶內容不能空白') }));
  await updateMemory(adminDb(), user.id, (await params).id, body.id, body.content);
  return { ok: true };
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const memoryId = new URL(req.url).searchParams.get('id');
  if (!memoryId) throw new HttpError(400, '缺少記憶 id');
  await deleteMemory(adminDb(), user.id, (await params).id, memoryId);
  return { ok: true };
});
```

建立 `apps/web/app/api/threads/[id]/messages/route.ts`：

```ts
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getThreadMessages } from '@/lib/services/threads';
import { adminDb } from '@/lib/supabase/admin';

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  return getThreadMessages(adminDb(), user.id, (await params).id);
});
```

- [ ] **Step 5: 確認測試通過與 build**

```bash
pnpm -F @agenthub/web test
pnpm -F @agenthub/web typecheck
cd apps/web && node --env-file=../../.env node_modules/next/dist/bin/next build && cd ../..
```

Expected: web 所有測試 PASS（projects 4、threads 4、files 2，加上之前的）；typecheck 無錯誤；build 成功。若 `agent_instances!memories_instance_id_fkey` 的外鍵名稱不同，用 `supabase db query --linked "select conname from pg_constraint where conrelid = 'public.memories'::regclass"` 查到正確名稱再改。

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): 專案、啟用、對話、檔案、記憶的 service 與 API"
```

---

### Task 5: runtime 打包發布、Sprite 部署與對話轉送

**Files:**
- Modify: `packages/runtime/package.json`
- Create: `packages/runtime/scripts/build.mjs`、`packages/runtime/scripts/publish.mjs`
- Create: `apps/web/lib/sprites.ts`、`apps/web/scripts/redeploy-runtime.ts`
- Modify: `apps/web/app/api/projects/route.ts`（加 POST）、`apps/web/app/api/projects/[id]/route.ts`（加 DELETE）
- Create: `apps/web/app/api/projects/[id]/provision/route.ts`、`apps/web/app/api/threads/[id]/chat/route.ts`
- Test: `apps/web/test/sprites.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `env`、`HttpError`、`route`、`readJson`、`requireUser`、`adminDb`；Task 4 的 `createProject`、`getOwnProject`、`deleteOwnProject`、`setSpriteState`、`getOwnThread`、`listProjects`
- Produces:
  - `RUNTIME_OBJECT = 'main.js'`、`spriteName(projectId: string): string`
  - `runtimeEnvFile(vars: Record<string, string>): string`（每行 `KEY="value"`，值用 JSON 字串跳脫）
  - `provisionProject(db: Db, projectId: string): Promise<void>`（不丟錯；失敗寫入 `sprite_status = 'error'`、`sprite_error`）
  - `installRuntime(db: Db, sprite: Sprite, projectId: string): Promise<string>`（回傳安裝目錄）
  - `destroyProjectSprite(name: string): Promise<void>`
  - `forwardChat(spriteUrl: string, body: { thread_id: string; text: string }, opts?: { token?: string; fetchImpl?: typeof fetch; retryDelayMs?: number }): Promise<Response>`
  - API：`POST /api/projects`（建立 + 背景部署）、`DELETE /api/projects/:id`、`POST /api/projects/:id/provision`、`POST /api/threads/:id/chat`
  - 指令：`pnpm -F @agenthub/runtime build`、`pnpm -F @agenthub/runtime publish-runtime`、`pnpm -F @agenthub/web exec tsx scripts/redeploy-runtime.ts`

- [ ] **Step 1: runtime 打包與發布**

`packages/runtime/package.json` 的 `scripts` 加入：

```json
    "build": "node scripts/build.mjs",
    "publish-runtime": "node scripts/publish.mjs"
```

```bash
pnpm -F @agenthub/runtime add -D esbuild
```

建立 `packages/runtime/scripts/build.mjs`：

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
```

建立 `packages/runtime/scripts/publish.mjs`：

```js
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
execSync('node scripts/build.mjs', { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) });

const bundle = await readFile(fileURLToPath(new URL('../dist/main.js', import.meta.url)));
const version = execSync('git rev-parse --short HEAD').toString().trim();
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

for (const path of ['main.js', `main-${version}.js`]) {
  const { error } = await db.storage.from('runtime').upload(path, bundle, { contentType: 'text/javascript', upsert: true });
  if (error) throw error;
  console.log(`已上傳 runtime/${path}（${bundle.length} bytes）`);
}
```

把 `dist/` 加進 `packages/runtime/.gitignore`（新建檔案，內容一行 `dist/`）。

確認打包後的 runtime 能啟動（用一個不存在的專案 id，`/health` 應正常回應）：

```bash
pnpm -F @agenthub/runtime build
cd packages/runtime
PROJECT_ID=00000000-0000-0000-0000-000000000000 PORT=8787 AGENTS_ROOT=/tmp/agenthub/a SHARED_ROOT=/tmp/agenthub/s \
  node --env-file=../../.env dist/main.js &
sleep 2 && curl -s http://localhost:8787/health; kill %1; cd ../..
```

Expected: `{"ok":true,"project_id":"00000000-0000-0000-0000-000000000000"}`。然後：

```bash
pnpm -F @agenthub/runtime publish-runtime
```

Expected: 印出兩行「已上傳 runtime/...」。

- [ ] **Step 2: 寫 sprites 測試**

建立 `apps/web/test/sprites.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import { forwardChat, runtimeEnvFile, spriteName } from '@/lib/sprites';

const body = { thread_id: 't1', text: '你好' };

function fakeFetch(steps: Array<'refuse' | number>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (step === 'refuse') throw new TypeError('fetch failed: ECONNREFUSED');
    return new Response('stream', { status: step });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('spriteName / runtimeEnvFile', () => {
  it('Sprite 名稱帶前綴；env 檔每行 KEY="value"', () => {
    expect(spriteName('abc')).toBe('agenthub-abc');
    expect(runtimeEnvFile({ A: 'x', B: 'has "quote"' })).toBe('A="x"\nB="has \\"quote\\""\n');
  });
});

describe('forwardChat', () => {
  it('送到 /chat，帶 Bearer token 與 JSON body', async () => {
    const { impl, calls } = fakeFetch([200]);
    const res = await forwardChat('https://s.example', body, { token: 'tok', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://s.example/chat');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(calls[0].init.body).toBe(JSON.stringify(body));
  });

  it('連線被拒或 502/503/504 時重試', async () => {
    const { impl, calls } = fakeFetch(['refuse', 503, 200]);
    const res = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('409 等其他狀態碼不重試，原樣回傳', async () => {
    const { impl, calls } = fakeFetch([409]);
    const res = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('三次都失敗：502', async () => {
    const { impl } = fakeFetch(['refuse', 'refuse', 'refuse']);
    const e = await forwardChat('https://s.example', body, { token: 't', fetchImpl: impl, retryDelayMs: 0 }).catch((err) => err);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(502);
    expect(e.message).toContain('agent 環境無法連線');
  });
});
```

- [ ] **Step 3: 確認測試失敗**

```bash
pnpm -F @agenthub/web test test/sprites.test.ts
```

Expected: FAIL，找不到 `@/lib/sprites`。

- [ ] **Step 4: 實作 sprites**

建立 `apps/web/lib/sprites.ts`：

```ts
import { SpritesClient, type Sprite } from '@fly/sprites';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { setSpriteState } from '@/lib/services/projects';
import type { Db } from '@/lib/supabase/admin';

export const RUNTIME_OBJECT = 'main.js';
const SERVICE = 'runtime';
const HEALTH_TIMEOUT_MS = 90_000;
const RETRYABLE = new Set([502, 503, 504]);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function spriteName(projectId: string): string {
  return `agenthub-${projectId}`;
}

export function runtimeEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n';
}

function client() {
  return new SpritesClient(env.spritesToken);
}

async function getOrCreateSprite(name: string): Promise<Sprite> {
  const c = client();
  const existing = await c.getSprite(name).catch(() => null);
  return existing ?? c.createSprite(name, { urlSettings: { auth: 'sprite' } });
}

export async function installRuntime(db: Db, sprite: Sprite, projectId: string): Promise<string> {
  const { stdout } = await sprite.execFile('bash', ['-lc', 'printf %s "$HOME"']);
  const base = `${stdout.trim()}/agenthub`;
  const { data, error } = await db.storage.from('runtime').createSignedUrl(RUNTIME_OBJECT, 600);
  if (error) throw new Error(`找不到 runtime 安裝檔：${error.message}`);
  await sprite.execFile('bash', ['-lc', `mkdir -p '${base}' && curl -fsSL '${data.signedUrl}' -o '${base}/main.js'`]);
  await sprite.filesystem(base).writeFile('.env', runtimeEnvFile({
    PROJECT_ID: projectId,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SECRET_KEY: env.supabaseSecretKey,
    VERTEX_API_EXPRESS_MODE_KEY: env.vertexKey,
    AGENTS_ROOT: `${base}/agents`,
    SHARED_ROOT: `${base}/shared`,
  }));
  const logs = await sprite.createService(SERVICE, {
    cmd: 'node',
    args: [`--env-file=${base}/.env`, `${base}/main.js`],
    httpPort: 8080,
  }, '10s');
  await logs.processAll(() => {});
  return base;
}

async function waitForHealth(url: string, projectId: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${env.spritesToken}` } });
      if (res.ok) {
        const body = (await res.json()) as { project_id?: string };
        if (body.project_id === projectId) return;
        last = `health 回傳的專案不符：${body.project_id}`;
      } else {
        last = `health 回應 ${res.status}`;
      }
    } catch (e) {
      last = errorText(e);
    }
    await sleep(2000);
  }
  throw new Error(`agent 環境啟動逾時（${last}）`);
}

export async function provisionProject(db: Db, projectId: string): Promise<void> {
  const name = spriteName(projectId);
  try {
    await setSpriteState(db, projectId, { sprite_status: 'provisioning', sprite_error: null, sprite_name: name });
    const sprite = await getOrCreateSprite(name);
    await installRuntime(db, sprite, projectId);
    await waitForHealth(sprite.url, projectId);
    await setSpriteState(db, projectId, { sprite_status: 'ready', sprite_url: sprite.url });
  } catch (e) {
    console.error('[provision]', projectId, e);
    await setSpriteState(db, projectId, { sprite_status: 'error', sprite_error: errorText(e) }).catch(() => undefined);
  }
}

export async function destroyProjectSprite(name: string): Promise<void> {
  if (!name.startsWith('agenthub-')) throw new Error(`拒絕刪除非 AgentHub 的 Sprite：${name}`);
  await client().deleteSprite(name).catch((e) => {
    if (!/404|not found/i.test(errorText(e))) throw e;
  });
}

export async function forwardChat(
  spriteUrl: string,
  body: { thread_id: string; text: string },
  opts: { token?: string; fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<Response> {
  const token = opts.token ?? env.spritesToken;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delay = opts.retryDelayMs ?? 1000;
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(`${spriteUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!RETRYABLE.has(res.status)) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = errorText(e);
    }
    if (attempt < 2) await sleep(delay);
  }
  throw new HttpError(502, `agent 環境無法連線，請稍後再試（${last}）`);
}
```

如果 `@fly/sprites` 沒有匯出 `Sprite` 型別，改用 `Awaited<ReturnType<SpritesClient['createSprite']>>`。

- [ ] **Step 5: 建立／刪除專案、重新部署、對話轉送 API**

`apps/web/app/api/projects/route.ts` 整個換成：

```ts
import { after } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { readJson, route } from '@/lib/http';
import { createProject, listProjects } from '@/lib/services/projects';
import { provisionProject } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  return listProjects(adminDb(), user.id);
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { name } = await readJson(req, z.object({ name: z.string().trim().min(1, '請填寫專案名稱').max(60) }));
  const project = await createProject(adminDb(), user.id, name);
  after(() => provisionProject(adminDb(), project.id));
  return project;
});
```

`apps/web/app/api/projects/[id]/route.ts` 加入 DELETE（保留原本的 GET）：

```ts
import { deleteOwnProject } from '@/lib/services/projects';
import { destroyProjectSprite, spriteName } from '@/lib/sprites';

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const project = await deleteOwnProject(adminDb(), user.id, (await params).id);
  await destroyProjectSprite(project.sprite_name ?? spriteName(project.id));
  return { ok: true };
});
```

（import 合併到檔案上方既有的 import。）

建立 `apps/web/app/api/projects/[id]/provision/route.ts`：

```ts
import { after } from 'next/server';
import { requireUser } from '@/lib/auth';
import { route } from '@/lib/http';
import { getOwnProject, setSpriteState } from '@/lib/services/projects';
import { provisionProject } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const project = await getOwnProject(adminDb(), user.id, (await params).id);
  await setSpriteState(adminDb(), project.id, { sprite_status: 'provisioning', sprite_error: null });
  after(() => provisionProject(adminDb(), project.id));
  return { ok: true };
});
```

建立 `apps/web/app/api/threads/[id]/chat/route.ts`：

```ts
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { HttpError, readJson, route } from '@/lib/http';
import { getOwnThread } from '@/lib/services/threads';
import { forwardChat } from '@/lib/sprites';
import { adminDb } from '@/lib/supabase/admin';

export const maxDuration = 300;

const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive', 'content-encoding']);

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const threadId = (await params).id;
  const { project } = await getOwnThread(adminDb(), user.id, threadId);
  if (project.sprite_status !== 'ready' || !project.sprite_url) throw new HttpError(409, 'agent 環境還在準備中，請稍候再送出');
  const { text } = await readJson(req, z.object({ text: z.string().trim().min(1, '請輸入訊息') }));

  const upstream = await forwardChat(project.sprite_url, { thread_id: threadId, text });
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers });
});
```

建立 `apps/web/scripts/redeploy-runtime.ts`（runtime 更新後，把所有 ready 的專案換成新版）：

```ts
import { fileURLToPath } from 'node:url';
import { SpritesClient } from '@fly/sprites';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));

const { adminDb } = await import('@/lib/supabase/admin');
const { installRuntime, spriteName } = await import('@/lib/sprites');

const db = adminDb();
const client = new SpritesClient(process.env.FLY_SPRITES_TOKEN!);
const { data: projects, error } = await db.from('projects').select('id, sprite_name').eq('sprite_status', 'ready');
if (error) throw error;

for (const p of projects) {
  const sprite = client.sprite(p.sprite_name ?? spriteName(p.id));
  await installRuntime(db, sprite, p.id);
  await sprite.restartService('runtime');
  console.log(`已更新 ${p.id}`);
}
```

（若 `tsx` 無法解析 `@/` 路徑，在 `apps/web/tsconfig.json` 的 `paths` 已有 `@/*`，執行時加 `--tsconfig tsconfig.json`；仍不行就把 import 改成相對路徑 `../lib/...`。）

- [ ] **Step 6: 測試、型別、build**

```bash
pnpm -F @agenthub/web test
pnpm -F @agenthub/web typecheck
cd apps/web && node --env-file=../../.env node_modules/next/dist/bin/next build && cd ../..
```

Expected: 全部 PASS；typecheck 無錯誤；build 成功。

- [ ] **Step 7: 用真的 Sprite 驗證部署與對話（會建立並刪除一台 Sprite）**

寫一支一次性腳本 `apps/web/scripts/provision-check.ts`（驗證完刪除，不 commit），內容：

1. 載入 `.env`（同 `redeploy-runtime.ts` 的寫法）。
2. 用 admin API 建一個 `@test.local` 使用者；用 `createTemplate` + `publishTemplate` 建一個已上架範本（system prompt：「你是測試顧問，用一句話回答。」）；`createProject`；`hireAgent`；`createThread`。
3. `await provisionProject(db, project.id)`，再讀專案：`sprite_status` 必須是 `ready`，否則印出 `sprite_error` 並結束。
4. `forwardChat(project.sprite_url, { thread_id, text: '你好，請自我介紹' })`，把串流讀完印出最後 500 字。
5. 輪詢 `runs` 直到不是 `running`，印出狀態與 `messages` 的 final 內容。
6. `finally`：`destroyProjectSprite(spriteName(project.id))`、刪除使用者。

```bash
cd apps/web && node --env-file=../../.env --import tsx scripts/provision-check.ts; cd ../..
```

Expected: 狀態 `ready`；串流含 `text-delta`；run `succeeded`；final 是 Gemini 的真實回覆；Sprite 已刪除（`curl -s -H "Authorization: Bearer $FLY_SPRITES_TOKEN" https://api.sprites.dev/v1/sprites` 不再列出 `agenthub-` 開頭的測試 Sprite，執行前先 `set -a; source .env; set +a`，且不要印出 token）。若失敗，修正後重跑，並在報告記錄遇到的問題與修正（例如 Sprite 的 Node 版本、`$HOME` 權限、服務啟動參數）。完成後刪除 `provision-check.ts`。

- [ ] **Step 8: Commit**

```bash
git add packages/runtime apps/web pnpm-lock.yaml
git commit -m "feat: runtime 打包發布、Sprite 部署與對話轉送"
```

---

### Task 6: 市集、agent 介紹與啟用、創作者頁面

**Files:**
- Create: `apps/web/lib/colors.ts`、`lib/text.ts`、`lib/agent-output.ts`、`components/markdown.tsx`、`components/seal.tsx`、`components/hire-form.tsx`、`components/new-template-button.tsx`、`components/template-editor.tsx`
- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/app/templates/[id]/page.tsx`、`app/creator/page.tsx`、`app/creator/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 1 的 `currentUser`、`api`、`adminDb`；Task 3 的 `listPublishedTemplates`、`getTemplate`、`listMyTemplates`、`TemplateRow`、`PublishedTemplate`；Task 4 的 `listProjects`、`ProjectRow`；Task 2 的 `McpServer`、`SkillMeta`
- Produces:
  - `consultantColor(index: number): string`（Global Constraints 的 6 色循環）
  - `textOf(m: UIMessage | undefined): string`
  - `type DelegationOutput`、`type Speech`、`type DiscussionState`（與 runtime `tools/delegate.ts`、`tools/discuss.ts` 的輸出結構相同）
  - `<Markdown text />`、`<Seal stance="agree" | "reserve" />`

- [ ] **Step 1: 共用元件與型別**

建立 `apps/web/lib/colors.ts`：

```ts
export const CONSULTANT_COLORS = ['#1F4E79', '#2E7D6B', '#8E4C9E', '#B5651D', '#3D6FB6', '#A23B5A'] as const;

export function consultantColor(index: number): string {
  return CONSULTANT_COLORS[((index % CONSULTANT_COLORS.length) + CONSULTANT_COLORS.length) % CONSULTANT_COLORS.length];
}
```

建立 `apps/web/lib/text.ts`：

```ts
import type { UIMessage } from 'ai';

export function textOf(m: UIMessage | undefined): string {
  if (!m) return '';
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}
```

建立 `apps/web/lib/agent-output.ts`：

```ts
import type { UIMessage } from 'ai';

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  message?: UIMessage;
  error?: string;
};

export type Speech = {
  consultant_id: string;
  name: string;
  round: number;
  status: 'speaking' | 'done' | 'failed';
  text: string;
  stance?: 'agree' | 'reserve';
  message?: UIMessage;
  error?: string;
};

export type DiscussionState = { topic: string; round: number; finished: boolean; error?: string; speeches: Speech[] };
```

建立 `apps/web/components/markdown.tsx`：

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none prose-headings:font-display prose-headings:text-ink prose-a:text-brand">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
```

建立 `apps/web/components/seal.tsx`：

```tsx
export function Seal({ stance }: { stance: 'agree' | 'reserve' }) {
  const agree = stance === 'agree';
  return (
    <span
      aria-label={agree ? '立場：同意' : '立場：有保留'}
      className={`inline-block -rotate-6 rounded-sm border-2 px-2 py-0.5 font-display text-sm font-bold tracking-widest ${
        agree ? 'border-seal text-seal' : 'border-ochre text-ochre'
      }`}
    >
      {agree ? '同意' : '保留'}
    </span>
  );
}
```

- [ ] **Step 2: 市集首頁**

`apps/web/app/page.tsx` 整個換成：

```tsx
import Link from 'next/link';
import { listPublishedTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function Marketplace() {
  const templates = await listPublishedTemplates(adminDb());
  return (
    <>
      <section className="py-12">
        <h1 className="max-w-3xl font-display text-[40px] leading-tight">請專業的人，帶著他們的方法來幫你做事</h1>
        <p className="mt-4 max-w-2xl text-muted">
          這裡的每一位顧問，都是律師、會計師、行銷人把自己的 SOP 做成的 agent。把他們加進你的專案，他們會分工、討論，最後給你一份整合過的建議。
        </p>
      </section>

      <section aria-labelledby="roster">
        <h2 id="roster" className="mb-4 font-display text-[28px]">顧問名冊</h2>
        {templates.length === 0 ? (
          <p className="rounded border border-dashed border-line bg-surface p-6 text-muted">
            還沒有人上架顧問。你可以在「我上架的 agent」把自己的專業做成第一位。
          </p>
        ) : (
          <ul className="divide-y divide-line border-y border-line bg-surface">
            {templates.map((t) => (
              <li key={t.id}>
                <Link href={`/templates/${t.id}`} className="grid gap-2 px-4 py-5 hover:bg-brand-soft sm:grid-cols-[1fr_2fr_auto] sm:items-baseline sm:gap-6">
                  <div>
                    <div className="font-display text-xl">{t.name}</div>
                    <div className="text-sm text-muted">{t.category || '未分類'}，由 {t.creator_name || '匿名創作者'} 製作</div>
                  </div>
                  <p className="line-clamp-2 text-muted">{t.description || '（創作者還沒寫介紹）'}</p>
                  <div className="text-sm text-muted sm:text-right">
                    {t.skills.length} 個 skill
                    {t.mcp_servers.length > 0 && <>，{t.mcp_servers.length} 個工具</>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
```

- [ ] **Step 3: agent 介紹與啟用**

建立 `apps/web/components/hire-form.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';
import type { McpServer } from '@/lib/schemas';

type ProjectOption = { id: string; name: string };

export function HireForm({ templateId, mcpServers, projects }: { templateId: string; mcpServers: McpServer[]; projects: ProjectOption[] }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needed = mcpServers.flatMap((s) => (s.required_secrets ?? []).map((r) => ({ server: s.name, ...r })));

  if (projects.length === 0) {
    return (
      <p className="text-muted">
        要先有一個專案才能加入顧問。<Link href="/projects" className="text-brand underline">建立專案</Link>
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify({ template_id: templateId, secrets }) });
      router.push(`/projects/${projectId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="text-sm text-muted">加入哪個專案</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface px-3 py-2">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {needed.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-sm text-muted">這位顧問的工具需要你的金鑰（只會存在你的專案裡）</legend>
          {needed.map((n) => (
            <label key={`${n.server}.${n.key}`} className="block">
              <span className="text-sm">{n.server} 的 {n.key}{n.description ? `：${n.description}` : ''}</span>
              <input
                required
                type="password"
                autoComplete="off"
                value={secrets[n.server]?.[n.key] ?? ''}
                onChange={(e) => setSecrets((s) => ({ ...s, [n.server]: { ...s[n.server], [n.key]: e.target.value } }))}
                className="mt-1 w-full rounded border border-line bg-surface px-3 py-2"
              />
            </label>
          ))}
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-seal">{error}</p>}
      <button disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
        {busy ? '加入中…' : '加入這位顧問'}
      </button>
    </form>
  );
}
```

建立 `apps/web/app/templates/[id]/page.tsx`：

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HireForm } from '@/components/hire-form';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { listProjects } from '@/lib/services/projects';
import { getTemplate } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const template = await getTemplate(adminDb(), id, user?.id ?? null).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
  const projects = user ? await listProjects(adminDb(), user.id) : [];

  return (
    <div className="grid gap-10 py-10 lg:grid-cols-[2fr_1fr]">
      <article>
        <p className="text-sm text-muted">{template.category || '未分類'}，由 {template.creator_name || '匿名創作者'} 製作</p>
        <h1 className="mt-1 font-display text-[40px] leading-tight">{template.name}</h1>
        <p className="mt-4 max-w-2xl whitespace-pre-line">{template.description || '（創作者還沒寫介紹）'}</p>

        <h2 className="mt-10 font-display text-xl">這位顧問會的事</h2>
        {template.skills.length === 0 ? (
          <p className="mt-2 text-muted">沒有額外的 skill，只靠創作者寫的工作方法。</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {template.skills.map((s) => (
              <li key={s.name} className="border-l-2 border-brand pl-3">
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-muted">{s.description}</div>
              </li>
            ))}
          </ul>
        )}

        {template.mcp_servers.length > 0 && (
          <>
            <h2 className="mt-8 font-display text-xl">會用到的工具</h2>
            <ul className="mt-2 list-disc pl-5 text-muted">
              {template.mcp_servers.map((s) => <li key={s.name}>{s.name}</li>)}
            </ul>
          </>
        )}
      </article>

      <aside className="h-fit rounded border border-line bg-surface p-5">
        <h2 className="mb-3 font-display text-xl">加入你的專案</h2>
        {template.status !== 'published' ? (
          <p className="text-muted">這是你的草稿，上架後才能加入專案。<Link href={`/creator/${template.id}`} className="text-brand underline">回去編輯</Link></p>
        ) : user ? (
          <HireForm templateId={template.id} mcpServers={template.mcp_servers} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
        ) : (
          <p className="text-muted"><Link href={`/login?next=/templates/${template.id}`} className="text-brand underline">登入</Link>後就能加入專案。</p>
        )}
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: 創作者頁面**

建立 `apps/web/components/new-template-button.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function NewTemplateButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    try {
      const t = await api<{ id: string }>('/api/templates', { method: 'POST', body: JSON.stringify({ name: '未命名的顧問' }) });
      router.push(`/creator/${t.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div>
      <button onClick={create} disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
        {busy ? '建立中…' : '做一位新顧問'}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-seal">{error}</p>}
    </div>
  );
}
```

建立 `apps/web/app/creator/page.tsx`：

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NewTemplateButton } from '@/components/new-template-button';
import { currentUser } from '@/lib/auth';
import { listMyTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function CreatorPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/creator');
  const templates = await listMyTemplates(adminDb(), user.id);
  return (
    <div className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[28px]">我上架的 agent</h1>
          <p className="text-muted">把你的 SOP、skill 和工具包成一位顧問，上架後別人就能加進他們的專案。</p>
        </div>
        <NewTemplateButton />
      </div>
      {templates.length === 0 ? (
        <p className="mt-8 rounded border border-dashed border-line bg-surface p-6 text-muted">你還沒做任何顧問。按「做一位新顧問」開始。</p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line bg-surface">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-4">
              <div>
                <div className="font-display text-xl">{t.name}</div>
                <div className="text-sm text-muted">{t.status === 'published' ? '已上架' : '草稿'}，{t.skills.length} 個 skill</div>
              </div>
              <Link href={`/creator/${t.id}`} className="rounded border border-line px-3 py-1 hover:border-ink">編輯</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

建立 `apps/web/components/template-editor.tsx`：

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/client-api';
import type { McpServer } from '@/lib/schemas';
import type { TemplateRow } from '@/lib/services/templates';

type McpDraft = {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  headers: string;
  secrets: string;
};

function toDraft(s: McpServer): McpDraft {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    args: (s.args ?? []).join(' '),
    url: s.url ?? '',
    headers: Object.entries(s.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    secrets: (s.required_secrets ?? []).map((r) => r.key).join(', '),
  };
}

function fromDraft(d: McpDraft): McpServer {
  const required_secrets = d.secrets.split(',').map((k) => k.trim()).filter(Boolean).map((key) => ({ key }));
  if (d.transport === 'stdio') {
    return { name: d.name.trim(), transport: 'stdio', command: d.command.trim(), args: d.args.split(/\s+/).filter(Boolean), required_secrets };
  }
  const headers = Object.fromEntries(
    d.headers.split('\n').map((line) => line.split(/:(.*)/s).map((x) => x.trim())).filter(([k, v]) => k && v),
  );
  return { name: d.name.trim(), transport: 'http', url: d.url.trim(), headers, required_secrets };
}

const emptyDraft: McpDraft = { name: '', transport: 'stdio', command: '', args: '', url: '', headers: '', secrets: '' };

export function TemplateEditor({ initial }: { initial: TemplateRow }) {
  const [t, setT] = useState(initial);
  const [mcp, setMcp] = useState<McpDraft[]>(initial.mcp_servers.map(toDraft));
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(label: string, action: () => Promise<TemplateRow>) {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await action();
      setT(updated);
      setMcp(updated.mcp_servers.map(toDraft));
      setMessage({ kind: 'ok', text: label });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run('已儲存', () =>
      api<TemplateRow>(`/api/templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: t.name, description: t.description, category: t.category, system_prompt: t.system_prompt,
          mcp_servers: mcp.map(fromDraft),
        }),
      }),
    );

  async function uploadZip(file: File) {
    await run(`已讀取 skill 檔案`, async () => {
      const { signedUrl } = await api<{ signedUrl: string }>(`/api/templates/${t.id}/upload-url`, { method: 'POST' });
      const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}），請再試一次`);
      return api<TemplateRow>(`/api/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ process_upload: true }) });
    });
  }

  const publish = async () => {
    await save();
    await run('已上架，現在大家都能在市集看到這位顧問', () => api<TemplateRow>(`/api/templates/${t.id}/publish`, { method: 'POST' }));
  };

  const input = 'mt-1 w-full rounded border border-line bg-surface px-3 py-2';

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <label className="block">
          <span className="text-sm text-muted">名稱</span>
          <input className={input} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-muted">分類（例如：法律、財務、行銷）</span>
          <input className={input} value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-muted">介紹（顯示在市集，也會讓主管知道該把什麼工作交給這位顧問）</span>
          <textarea className={input} rows={3} value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-muted">System prompt：你的工作方法與 SOP</span>
          <textarea className={`${input} font-mono text-sm`} rows={12} value={t.system_prompt} onChange={(e) => setT({ ...t, system_prompt: e.target.value })} />
        </label>
      </section>

      <section>
        <h2 className="font-display text-xl">Skill</h2>
        <p className="text-sm text-muted">上傳一個 zip，裡面每個資料夾放一份 SKILL.md（Claude Code 的 .claude/skills 資料夾直接壓縮即可）。</p>
        <input type="file" accept=".zip,application/zip" disabled={busy} className="mt-3 block"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadZip(f); e.target.value = ''; }} />
        {t.skills.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {t.skills.map((s) => <li key={s.name}><span className="font-medium">{s.name}</span>：{s.description}</li>)}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl">工具（MCP）</h2>
        <p className="text-sm text-muted">需要金鑰的工具，租用的人會在加入時填自己的金鑰。</p>
        <div className="mt-3 space-y-4">
          {mcp.map((d, i) => {
            const update = (patch: Partial<McpDraft>) => setMcp(mcp.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <fieldset key={i} className="space-y-3 rounded border border-line bg-surface p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-sm text-muted">名稱（英數字）</span>
                    <input className={input} value={d.name} onChange={(e) => update({ name: e.target.value })} /></label>
                  <label className="block"><span className="text-sm text-muted">連線方式</span>
                    <select className={input} value={d.transport} onChange={(e) => update({ transport: e.target.value as McpDraft['transport'] })}>
                      <option value="stdio">在 agent 電腦上啟動（stdio）</option>
                      <option value="http">連到遠端網址（HTTP）</option>
                    </select></label>
                </div>
                {d.transport === 'stdio' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block"><span className="text-sm text-muted">啟動指令</span>
                      <input className={input} placeholder="npx" value={d.command} onChange={(e) => update({ command: e.target.value })} /></label>
                    <label className="block"><span className="text-sm text-muted">參數（空白分隔）</span>
                      <input className={input} placeholder="-y some-mcp-server" value={d.args} onChange={(e) => update({ args: e.target.value })} /></label>
                  </div>
                ) : (
                  <>
                    <label className="block"><span className="text-sm text-muted">網址</span>
                      <input className={input} placeholder="https://..." value={d.url} onChange={(e) => update({ url: e.target.value })} /></label>
                    <label className="block"><span className="text-sm text-muted">Headers（每行一個，例如 Authorization: Bearer {'${API_KEY}'}）</span>
                      <textarea className={input} rows={2} value={d.headers} onChange={(e) => update({ headers: e.target.value })} /></label>
                  </>
                )}
                <label className="block"><span className="text-sm text-muted">需要的金鑰名稱（逗號分隔，例如 FINMIND_API_KEY）</span>
                  <input className={input} value={d.secrets} onChange={(e) => update({ secrets: e.target.value })} /></label>
                <button type="button" onClick={() => setMcp(mcp.filter((_, j) => j !== i))} className="text-sm text-seal underline">移除這個工具</button>
              </fieldset>
            );
          })}
          <button type="button" onClick={() => setMcp([...mcp, { ...emptyDraft }])} className="rounded border border-line px-3 py-1 hover:border-ink">新增工具</button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <button onClick={save} disabled={busy} className="rounded border border-line px-4 py-2 hover:border-ink disabled:opacity-60">儲存</button>
        <button onClick={publish} disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">
          {t.status === 'published' ? '儲存並更新上架內容' : '儲存並上架'}
        </button>
        {t.status === 'published' && <Link href={`/templates/${t.id}`} className="text-brand underline">看市集上的樣子</Link>}
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={`w-full whitespace-pre-line text-sm ${message.kind === 'error' ? 'text-seal' : 'text-muted'}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
```

建立 `apps/web/app/creator/[id]/page.tsx`：

```tsx
import { notFound, redirect } from 'next/navigation';
import { TemplateEditor } from '@/components/template-editor';
import { currentUser } from '@/lib/auth';
import { listMyTemplates } from '@/lib/services/templates';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/creator/${id}`);
  const template = (await listMyTemplates(adminDb(), user.id)).find((t) => t.id === id);
  if (!template) notFound();
  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="mb-6 font-display text-[28px]">編輯顧問</h1>
      <TemplateEditor initial={template} />
    </div>
  );
}
```

- [ ] **Step 5: 型別、lint、build**

```bash
pnpm -F @agenthub/web typecheck
pnpm -F @agenthub/web lint
cd apps/web && node --env-file=../../.env node_modules/next/dist/bin/next build && cd ../..
```

Expected: 沒有錯誤。lint 若對既有程式報錯，修正到通過（不可關閉規則）。

- [ ] **Step 6: 本機手動走一遍並截圖檢查**

`pnpm -F @agenthub/web dev`，登入後：在「我上架的 agent」做一位新顧問 → 填名稱、分類、介紹、system prompt → 上傳一個含 SKILL.md 的 zip（可用 `zip` 指令現做）→ 新增一個 http 工具並填金鑰名稱 → 儲存並上架 → 首頁名冊看得到 → 點進介紹頁 → 沒有專案時顯示「建立專案」提示。用瀏覽器在手機寬度（390px）看一次首頁與編輯頁，確認沒有水平捲動、焦點外框看得到。把發現與修正寫進報告。

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): 市集、agent 介紹與啟用、創作者頁面"
```

---

### Task 7: 專案列表與工作區（對話、顧問發言、檔案、記憶）

**Files:**
- Create: `apps/web/components/new-project-form.tsx`、`components/workspace/workspace.tsx`、`workspace/agent-roster.tsx`、`workspace/file-panel.tsx`、`workspace/memory-panel.tsx`、`workspace/chat.tsx`、`workspace/message-view.tsx`、`workspace/delegation-card.tsx`、`workspace/discussion-view.tsx`
- Create: `apps/web/app/projects/page.tsx`、`app/projects/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 1 的 `currentUser`、`api`、`adminDb`；Task 4 的 `listProjects`、`getProjectDetail`、`ProjectDetail`、`AgentSummary`、`ThreadMessages`、`MemoryView`；Task 6 的 `consultantColor`、`textOf`、`DelegationOutput`、`DiscussionState`、`Speech`、`Markdown`、`Seal`
- Produces: 專案列表頁與工作區頁；`useChat` 對接 `POST /api/threads/:id/chat`（body `{ text }`）；串流失敗或中斷時輪詢 `GET /api/threads/:id/messages`

- [ ] **Step 1: 專案列表**

建立 `apps/web/components/new-project-form.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-3">
      <label className="min-w-64 flex-1">
        <span className="sr-only">專案名稱</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：第四季新產品上市"
          className="w-full rounded border border-line bg-surface px-3 py-2" />
      </label>
      <button disabled={busy} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-60">{busy ? '建立中…' : '建立專案'}</button>
      {error && <p role="alert" className="w-full text-sm text-seal">{error}</p>}
    </form>
  );
}
```

建立 `apps/web/app/projects/page.tsx`：

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NewProjectForm } from '@/components/new-project-form';
import { currentUser } from '@/lib/auth';
import { listProjects } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const STATUS = { provisioning: '準備中', ready: '可以使用', error: '準備失敗' } as const;

export default async function ProjectsPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/projects');
  const projects = await listProjects(adminDb(), user.id);
  return (
    <div className="py-10">
      <h1 className="font-display text-[28px]">我的專案</h1>
      <p className="mb-6 text-muted">一個專案就是一張工作桌：放資料、請顧問、開對話。</p>
      <NewProjectForm />
      {projects.length === 0 ? (
        <p className="mt-8 text-muted">還沒有專案。取個名字建立第一個，接著到市集挑顧問。</p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line bg-surface">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="flex items-center justify-between px-4 py-4 hover:bg-brand-soft">
                <span className="font-display text-xl">{p.name}</span>
                <span className={`text-sm ${p.sprite_status === 'error' ? 'text-seal' : 'text-muted'}`}>{STATUS[p.sprite_status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 顧問發言元件**

建立 `apps/web/components/workspace/delegation-card.tsx`：

```tsx
import { Markdown } from '@/components/markdown';
import type { DelegationOutput } from '@/lib/agent-output';
import { textOf } from '@/lib/text';

export function DelegationCard({ output, task, color }: { output?: DelegationOutput; task?: string; color: string }) {
  const name = output?.name ?? '顧問';
  return (
    <div className="my-3 border-l-4 bg-surface py-3 pl-4 pr-3" style={{ borderColor: color }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-lg" style={{ color }}>{name}</span>
        <span className="text-xs text-muted">
          {!output || output.status === 'working' ? '處理中…' : output.status === 'done' ? '完成' : '失敗'}
        </span>
      </div>
      {task && <p className="mt-1 text-sm text-muted">主管交辦：{task}</p>}
      {output?.status === 'failed' && <p className="mt-2 text-sm text-seal">{output.error}</p>}
      {output?.message && <div className="mt-2"><Markdown text={textOf(output.message)} /></div>}
    </div>
  );
}
```

建立 `apps/web/components/workspace/discussion-view.tsx`：

```tsx
import { Markdown } from '@/components/markdown';
import { Seal } from '@/components/seal';
import type { DiscussionState, Speech } from '@/lib/agent-output';

const STANCE_LINE = /\n?\s*立場\s*[:：]\s*(同意|有保留)\s*$/;

function SpeechBlock({ speech, color }: { speech: Speech; color: string }) {
  const body = speech.text.replace(STANCE_LINE, '');
  return (
    <div className="border-l-4 bg-surface py-3 pl-4 pr-3" style={{ borderColor: color }}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-lg" style={{ color }}>{speech.name}</span>
        {speech.status === 'speaking' && <span className="text-xs text-muted">發言中…</span>}
        {speech.status === 'done' && speech.stance && <Seal stance={speech.stance} />}
      </div>
      {speech.status === 'failed' ? (
        <p className="mt-2 text-sm text-muted">未發言：{speech.error}</p>
      ) : (
        body && <div className="mt-2"><Markdown text={body} /></div>
      )}
    </div>
  );
}

export function DiscussionView({ state, colorOf }: { state?: DiscussionState; colorOf: (consultantId: string) => string }) {
  if (!state) return <p className="my-3 text-sm text-muted">主管正在召集顧問…</p>;
  const rounds = [...new Set(state.speeches.map((s) => s.round))].sort((a, b) => a - b);
  return (
    <section className="my-4 rounded border border-line bg-paper p-4" aria-label="顧問討論">
      <h3 className="font-display text-lg">顧問討論：{state.topic}</h3>
      {rounds.map((round) => (
        <div key={round} className="mt-4">
          <h4 className="mb-2 text-sm font-medium text-muted">
            {round === 1 ? '第 1 輪：各自提出意見' : `第 ${round} 輪：互相回應`}
          </h4>
          <div className="space-y-3">
            {state.speeches.filter((s) => s.round === round).map((s) => (
              <SpeechBlock key={`${s.consultant_id}-${s.round}`} speech={s} color={colorOf(s.consultant_id)} />
            ))}
          </div>
        </div>
      ))}
      {state.finished && (
        <p className="mt-4 text-sm text-muted">{state.error ? `討論提前結束：${state.error}` : `討論結束，共進行 ${state.round} 輪。`}</p>
      )}
    </section>
  );
}
```

建立 `apps/web/components/workspace/message-view.tsx`：

```tsx
import type { UIMessage } from 'ai';
import { Markdown } from '@/components/markdown';
import type { DelegationOutput, DiscussionState } from '@/lib/agent-output';
import { DelegationCard } from './delegation-card';
import { DiscussionView } from './discussion-view';

type ToolPart = { type: string; toolName?: string; state: string; input?: Record<string, unknown>; output?: unknown };

const TOOL_LABELS: Record<string, string> = {
  bash: '執行指令', read_file: '讀取檔案', write_file: '寫入檔案', remember: '記下重點', recall: '查詢記憶',
};

export function MessageView({ message, speaker, colorOf }: { message: UIMessage; speaker: string; colorOf: (id: string) => string }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded bg-brand px-4 py-2 text-white">
          {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 font-display text-sm text-muted">{speaker}</div>
      {message.parts.map((part, i) => {
        if (part.type === 'text') return <Markdown key={i} text={part.text} />;
        if (part.type === 'data-warning') {
          return <p key={i} role="status" className="my-1 text-xs text-ochre">{(part as { data: { text: string } }).data.text}</p>;
        }
        if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return null;
        const tool = part as ToolPart;
        const name = tool.type === 'dynamic-tool' ? tool.toolName ?? '工具' : tool.type.slice('tool-'.length);
        if (name === 'assign_task') {
          const output = tool.output as DelegationOutput | undefined;
          const consultantId = output?.consultant_id ?? (tool.input?.consultant_id as string | undefined) ?? '';
          return <DelegationCard key={i} output={output} task={tool.input?.task as string | undefined} color={colorOf(consultantId)} />;
        }
        if (name === 'convene_discussion') {
          return <DiscussionView key={i} state={tool.output as DiscussionState | undefined} colorOf={colorOf} />;
        }
        const done = tool.state === 'output-available';
        const failed = tool.state === 'output-error';
        return (
          <p key={i} className="my-1 text-xs text-muted">
            {failed ? '工具失敗' : done ? '用了工具' : '正在使用工具'}：{TOOL_LABELS[name] ?? name}
          </p>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: 對話元件**

建立 `apps/web/components/workspace/chat.tsx`：

```tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { textOf } from '@/lib/text';
import { MessageView } from './message-view';

type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null };

export function Chat({ threadId, ready, speaker, colorOf }: {
  threadId: string;
  ready: boolean;
  speaker: string;
  colorOf: (id: string) => string;
}) {
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const polling = useRef(false);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: `/api/threads/${threadId}/chat`,
      prepareSendMessagesRequest: ({ messages }) => ({ body: { text: textOf(messages.at(-1)) } }),
    }),
    [threadId],
  );

  const { messages, sendMessage, setMessages, status } = useChat({ id: threadId, transport });

  const pollUntilDone = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setWaiting(true);
    try {
      for (;;) {
        const data = await api<ThreadMessages>(`/api/threads/${threadId}/messages`);
        if (!data.running) {
          setMessages(data.messages);
          setNotice(data.error ? `這次回覆沒有完成：${data.error}` : null);
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      polling.current = false;
      setWaiting(false);
    }
  }, [threadId, setMessages]);

  useEffect(() => {
    let cancelled = false;
    api<ThreadMessages>(`/api/threads/${threadId}/messages`)
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages);
        if (data.running) void pollUntilDone();
        else if (data.error) setNotice(`上一次回覆沒有完成：${data.error}`);
      })
      .catch((e) => setNotice((e as Error).message));
    return () => { cancelled = true; };
  }, [threadId, setMessages, pollUntilDone]);

  useEffect(() => {
    if (status === 'error') void pollUntilDone();
  }, [status, pollUntilDone]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming' || waiting;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !ready) return;
    setNotice(null);
    setInput('');
    void sendMessage({ text });
  }

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex-1 space-y-6 pb-4">
        {messages.length === 0 && (
          <p className="text-muted">說明你想完成的事，顧問們會分工處理。需要跨專業權衡時，主管會召集大家討論。</p>
        )}
        {messages.map((m) => <MessageView key={m.id} message={m} speaker={speaker} colorOf={colorOf} />)}
        {busy && <p className="text-sm text-muted">{waiting ? '回覆還在進行中，完成後會自動顯示…' : '顧問正在處理…'}</p>}
        {notice && <p role="alert" className="text-sm text-seal">{notice}</p>}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit} className="sticky bottom-0 flex gap-2 border-t border-line bg-paper py-3">
        <label className="flex-1">
          <span className="sr-only">訊息</span>
          <textarea
            rows={2}
            value={input}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}
            placeholder={ready ? '輸入訊息，Enter 送出，Shift+Enter 換行' : 'agent 環境準備好之後才能送出'}
            className="w-full resize-none rounded border border-line bg-surface px-3 py-2"
          />
        </label>
        <button disabled={busy || !ready || !input.trim()} className="self-end rounded bg-brand px-4 py-2 text-white disabled:opacity-60">送出</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: 側欄元件**

建立 `apps/web/components/workspace/agent-roster.tsx`：

```tsx
import Link from 'next/link';
import type { AgentSummary } from '@/lib/services/projects';

export function AgentRoster({ agents, colorOf }: { agents: AgentSummary[]; colorOf: (id: string) => string }) {
  const consultants = agents.filter((a) => a.role === 'consultant');
  const manager = agents.find((a) => a.role === 'manager');
  return (
    <section aria-labelledby="roster-title">
      <h2 id="roster-title" className="font-display text-lg">顧問</h2>
      {consultants.length === 0 ? (
        <p className="mt-2 text-sm text-muted">還沒有顧問。<Link href="/" className="text-brand underline">到市集挑選</Link></p>
      ) : (
        <ul className="mt-2 space-y-2">
          {consultants.map((a) => (
            <li key={a.id} className="flex items-start gap-2">
              <span aria-hidden className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(a.id) }} />
              <div>
                <div className="font-medium">{a.name}</div>
                {a.description && <div className="text-xs text-muted">{a.description}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {manager && <p className="mt-3 text-xs text-muted">有兩位以上顧問，所以由主管負責分工與整合。</p>}
      {consultants.length > 0 && <Link href="/" className="mt-3 inline-block text-sm text-brand underline">再加一位顧問</Link>}
    </section>
  );
}
```

建立 `apps/web/components/workspace/file-panel.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

type FileItem = { name: string; size: number; updated_at: string | null };

export function FilePanel({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<FileItem[]>(`/api/projects/${projectId}/files`).then(setFiles).catch((e) => setError(e.message)), [projectId]);
  useEffect(() => { void load(); }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { signedUrl } = await api<{ signedUrl: string }>(`/api/projects/${projectId}/files/upload-url`, {
        method: 'POST', body: JSON.stringify({ filename: file.name }),
      });
      const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'true' } });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="files-title">
      <h2 id="files-title" className="font-display text-lg">專案資料</h2>
      <p className="text-xs text-muted">上傳後，所有顧問下一次回覆時都讀得到。</p>
      <input type="file" disabled={busy} className="mt-2 block w-full text-sm"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      {error && <p role="alert" className="mt-1 text-xs text-seal">{error}</p>}
      <ul className="mt-2 space-y-1 text-sm">
        {files.map((f) => <li key={f.name} className="truncate">{f.name}</li>)}
        {files.length === 0 && <li className="text-xs text-muted">還沒有資料。</li>}
      </ul>
    </section>
  );
}
```

建立 `apps/web/components/workspace/memory-panel.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

type Memory = { id: string; instance_id: string | null; agent_name: string | null; content: string; created_at: string };

export function MemoryPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Memory[]>(`/api/projects/${projectId}/memories`).then(setMemories).catch((e) => setError(e.message)), [projectId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function save() {
    if (!editing) return;
    try {
      await api(`/api/projects/${projectId}/memories`, { method: 'PATCH', body: JSON.stringify(editing) });
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/projects/${projectId}/memories?id=${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="memory-title">
      <h2 id="memory-title" className="font-display text-lg">記憶</h2>
      <p className="text-xs text-muted">顧問記下你說過的事實與偏好，你可以修改或刪除。</p>
      {error && <p role="alert" className="mt-1 text-xs text-seal">{error}</p>}
      <ul className="mt-2 space-y-2 text-sm">
        {memories.length === 0 && <li className="text-xs text-muted">還沒有記憶。</li>}
        {memories.map((m) => (
          <li key={m.id} className="border-l-2 border-line pl-2">
            <div className="text-xs text-muted">{m.agent_name ? `${m.agent_name}（私有）` : '整個專案共用'}</div>
            {editing?.id === m.id ? (
              <div className="mt-1 space-y-1">
                <textarea className="w-full rounded border border-line bg-surface px-2 py-1" rows={2} value={editing.content}
                  onChange={(e) => setEditing({ id: m.id, content: e.target.value })} />
                <div className="flex gap-2 text-xs">
                  <button onClick={save} className="text-brand underline">儲存</button>
                  <button onClick={() => setEditing(null)} className="text-muted underline">取消</button>
                </div>
              </div>
            ) : (
              <>
                <p>{m.content}</p>
                <div className="flex gap-2 text-xs">
                  <button onClick={() => setEditing({ id: m.id, content: m.content })} className="text-brand underline">修改</button>
                  <button onClick={() => remove(m.id)} className="text-seal underline">刪除</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: 工作區與頁面**

建立 `apps/web/components/workspace/workspace.tsx`：

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { consultantColor } from '@/lib/colors';
import type { ProjectDetail } from '@/lib/services/projects';
import { AgentRoster } from './agent-roster';
import { Chat } from './chat';
import { FilePanel } from './file-panel';
import { MemoryPanel } from './memory-panel';

export function Workspace({ initial }: { initial: ProjectDetail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [threadId, setThreadId] = useState<string | null>(initial.threads[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const { project, agents, threads } = detail;

  const reload = useCallback(async () => setDetail(await api<ProjectDetail>(`/api/projects/${project.id}`)), [project.id]);

  useEffect(() => {
    if (project.sprite_status !== 'provisioning') return;
    const timer = setInterval(() => { void reload(); }, 3000);
    return () => clearInterval(timer);
  }, [project.sprite_status, reload]);

  const consultants = agents.filter((a) => a.role === 'consultant');
  const colorOf = (id: string) => consultantColor(Math.max(0, consultants.findIndex((a) => a.id === id)));
  const speaker = consultants.length > 1 ? '主管' : consultants[0]?.name ?? '顧問';

  async function newThread() {
    try {
      const t = await api<{ id: string }>(`/api/projects/${project.id}/threads`, { method: 'POST', body: JSON.stringify({}) });
      await reload();
      setThreadId(t.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function retry() {
    await api(`/api/projects/${project.id}/provision`, { method: 'POST' });
    await reload();
  }

  async function remove() {
    if (!window.confirm(`確定要刪除「${project.name}」？對話、記憶和資料都會一起刪除。`)) return;
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    router.push('/projects');
  }

  return (
    <div className="grid gap-8 py-8 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-8">
        <div>
          <h1 className="font-display text-[28px] leading-tight">{project.name}</h1>
          {project.sprite_status === 'provisioning' && <p className="mt-1 text-sm text-muted">正在準備 agent 的工作電腦，約需一分鐘…</p>}
          {project.sprite_status === 'error' && (
            <div className="mt-2 text-sm">
              <p className="text-seal">準備失敗：{project.sprite_error}</p>
              <button onClick={retry} className="mt-1 text-brand underline">重新準備</button>
            </div>
          )}
        </div>
        <AgentRoster agents={agents} colorOf={colorOf} />
        <FilePanel projectId={project.id} />
        <MemoryPanel projectId={project.id} refreshKey={threadId ? threads.length : 0} />
        <button onClick={remove} className="text-sm text-seal underline">刪除專案</button>
      </aside>

      <section aria-label="對話">
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-3">
          {threads.map((t, i) => (
            <button key={t.id} onClick={() => setThreadId(t.id)}
              className={`rounded px-3 py-1 text-sm ${t.id === threadId ? 'bg-brand text-white' : 'border border-line hover:border-ink'}`}>
              {t.title === '新對話' ? `對話 ${threads.length - i}` : t.title}
            </button>
          ))}
          <button onClick={newThread} className="rounded border border-dashed border-line px-3 py-1 text-sm hover:border-ink">開新對話</button>
          {error && <p role="alert" className="w-full text-sm text-seal">{error}</p>}
        </div>
        {consultants.length === 0 ? (
          <p className="text-muted">先到市集加入至少一位顧問，才能開始對話。</p>
        ) : threadId ? (
          <Chat key={threadId} threadId={threadId} ready={project.sprite_status === 'ready'} speaker={speaker} colorOf={colorOf} />
        ) : (
          <button onClick={newThread} className="rounded bg-brand px-4 py-2 text-white">開始第一個對話</button>
        )}
      </section>
    </div>
  );
}
```

建立 `apps/web/app/projects/[id]/page.tsx`：

```tsx
import { notFound, redirect } from 'next/navigation';
import { Workspace } from '@/components/workspace/workspace';
import { currentUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import { getProjectDetail } from '@/lib/services/projects';
import { adminDb } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/projects/${id}`);
  const detail = await getProjectDetail(adminDb(), user.id, id).catch((e) => {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  });
  return <Workspace initial={detail} />;
}
```

- [ ] **Step 6: 型別、lint、build**

```bash
pnpm -F @agenthub/web typecheck
pnpm -F @agenthub/web lint
cd apps/web && node --env-file=../../.env node_modules/next/dist/bin/next build && cd ../..
```

Expected: 沒有錯誤。

- [ ] **Step 7: 本機走完整流程（會建立一台真的 Sprite）**

先確認 runtime 已發布（Task 5 Step 1 的 `publish-runtime`；若 runtime 程式之後有改，重新發布）。`pnpm -F @agenthub/web dev`，然後：

1. 登入 → 建立專案 → 看到「正在準備…」→ 約 1 分鐘後狀態消失、可以輸入。
2. 到市集加入 Task 6 建立的顧問（或新建兩位：「法務顧問」「財務顧問」，各寫一段 system prompt 並上架）→ 回到專案，名冊顯示顧問與識別色。
3. 上傳一個文字檔到專案資料。
4. 開新對話，單一顧問時問一個問題 → 看到串流回覆。
5. 加第二位顧問後問「請法務和財務一起討論：我們想把客戶資料拿去訓練模型，可行嗎？」→ 看到討論區塊、第 1 輪兩位顧問同時發言、之後輪流、立場印章、最後主管的三段總結。
6. 重新整理頁面 → 歷史訊息（含討論）仍在。
7. 刪除專案 → 回到列表；確認對應 Sprite 已刪除。

用瀏覽器截圖檢查工作區在桌機與手機寬度的樣子，依 Global Constraints 的設計 token 檢查一次並修正。把每一步的結果與修正寫進報告。

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): 專案列表與工作區"
```

---

### Task 8: 部署到 Vercel production 與 API 冒煙測試

**Files:**
- Create: `apps/web/vercel.json`、`apps/web/scripts/smoke.ts`

**Interfaces:**
- Consumes: 全部已完成的功能
- Produces: production 網址上可用的 AgentHub；`apps/web/scripts/smoke.ts`（用 Bearer token 走完整條 API 流程，參數 `BASE_URL`）

- [ ] **Step 1: Vercel 設定檔**

建立 `apps/web/vercel.json`：

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["sin1"]
}
```

- [ ] **Step 2: 設定 Vercel 專案（Root Directory、框架、Node 版本）**

用 Vercel CLI 已登入的 token 呼叫 REST API（不要印出 token）：

```bash
cd /Users/eric/Desktop/AgentHub
TOKEN=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/Library/Application Support/com.vercel.cli/auth.json")))["token"])')
TEAM=$(vercel teams ls 2>/dev/null | awk '/rayzilabs-2056/{print $1; exit}')
curl -s -X PATCH "https://api.vercel.com/v9/projects/agenthub?slug=rayzilabs-2056" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"framework":"nextjs","rootDirectory":"apps/web","sourceFilesOutsideRootDirectory":true,"nodeVersion":"24.x"}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ("name","framework","rootDirectory","nodeVersion","error")})'
```

Expected: `framework: 'nextjs'`、`rootDirectory: 'apps/web'`、`nodeVersion: '24.x'`。若 `slug=` 參數不被接受，改用 `teamId=`（從 `vercel teams ls` 或 `GET https://api.vercel.com/v2/teams?slug=rayzilabs-2056` 取得 id）。

- [ ] **Step 3: 設定環境變數**

```bash
cd /Users/eric/Desktop/AgentHub
vercel link --yes --project agenthub --scope rayzilabs-2056
set -a; source .env; set +a
# repo 用 pnpm 12（root package.json 的 packageManager），Vercel 需要開 corepack 才會用同一版 pnpm 安裝
for ENV in production preview; do
  printf %s "1" | vercel env add ENABLE_EXPERIMENTAL_COREPACK "$ENV" --force --scope rayzilabs-2056 >/dev/null && echo "set ENABLE_EXPERIMENTAL_COREPACK ($ENV)"
done
for NAME in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY FLY_SPRITES_TOKEN VERTEX_API_EXPRESS_MODE_KEY; do
  for ENV in production preview; do
    printf %s "${!NAME}" | vercel env add "$NAME" "$ENV" --force --scope rayzilabs-2056 >/dev/null && echo "set $NAME ($ENV)"
  done
done
vercel env ls --scope rayzilabs-2056
```

Expected: 五個變數加上 `ENABLE_EXPERIMENTAL_COREPACK` 在 production、preview 都存在（只看名稱，不印值）。`vercel link` 產生的 `.vercel/` 加進根目錄 `.gitignore`。

- [ ] **Step 4: 冒煙測試腳本**

建立 `apps/web/scripts/smoke.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { strToU8, zipSync } from 'fflate';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

const email = `smoke-${randomUUID()}@test.local`;
const password = 'smoke-password-123';
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;
const userId = created.user.id;

const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
if (signInError) throw signInError;
const auth = { authorization: `Bearer ${session.session!.access_token}`, 'content-type': 'application/json' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

let projectId: string | undefined;
try {
  console.log('1. 建立並上架兩位顧問');
  const templateIds: string[] = [];
  for (const [name, prompt] of [['法務顧問', '你是台灣執業律師，回答要指出法律風險，簡短。'], ['財務顧問', '你是會計師，回答要指出財務影響，簡短。']]) {
    const t = await call<{ id: string }>('/api/templates', { method: 'POST', body: JSON.stringify({ name, description: `${name}（冒煙測試）`, system_prompt: prompt }) });
    const { signedUrl } = await call<{ signedUrl: string }>(`/api/templates/${t.id}/upload-url`, { method: 'POST' });
    const zip = zipSync({ 'check/SKILL.md': strToU8(`---\nname: check\ndescription: ${name}的檢查清單\n---\n\n1. 先確認事實\n`) });
    const put = await fetch(signedUrl, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
    if (!put.ok) throw new Error(`上傳 skill 失敗 ${put.status}`);
    await call(`/api/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ process_upload: true }) });
    await call(`/api/templates/${t.id}/publish`, { method: 'POST' });
    templateIds.push(t.id);
  }

  console.log('2. 建立專案並等待 agent 環境');
  const project = await call<{ id: string }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: '冒煙測試' }) });
  projectId = project.id;
  for (let i = 0; ; i++) {
    const d = await call<{ project: { sprite_status: string; sprite_error: string | null } }>(`/api/projects/${project.id}`);
    if (d.project.sprite_status === 'ready') break;
    if (d.project.sprite_status === 'error') throw new Error(`環境準備失敗：${d.project.sprite_error}`);
    if (i > 60) throw new Error('環境準備逾時');
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log('3. 加入兩位顧問、開對話');
  for (const id of templateIds) await call(`/api/projects/${project.id}/agents`, { method: 'POST', body: JSON.stringify({ template_id: id }) });
  const thread = await call<{ id: string }>(`/api/projects/${project.id}/threads`, { method: 'POST', body: JSON.stringify({}) });

  console.log('4. 送出需要討論的問題（串流）');
  const res = await fetch(`${BASE}/api/threads/${thread.id}/chat`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: '請法務和財務一起討論：把客戶交易資料拿去訓練內部模型可行嗎？最後給我總結。' }),
  });
  if (!res.ok) throw new Error(`chat → ${res.status} ${await res.text()}`);
  const streamText = await res.text();
  console.log(`   串流 ${streamText.length} 字元，含討論：${streamText.includes('convene_discussion')}`);

  console.log('5. 等待完成並檢查結果');
  for (let i = 0; ; i++) {
    const m = await call<{ messages: { role: string; parts: { type: string; text?: string }[] }[]; running: boolean; error: string | null }>(`/api/threads/${thread.id}/messages`);
    if (!m.running) {
      if (m.error) throw new Error(`回覆失敗：${m.error}`);
      const final = m.messages.at(-1)!;
      const text = final.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      console.log(`   最終回覆前 300 字：\n${text.slice(0, 300)}`);
      for (const h of ['各面向建議', '共識方案', '仍有分歧']) if (!text.includes(h)) console.warn(`   ⚠ 總結缺少「${h}」`);
      break;
    }
    if (i > 200) throw new Error('等待回覆逾時');
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('冒煙測試通過');
} finally {
  if (projectId) await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
  await admin.auth.admin.deleteUser(userId);
}
```

- [ ] **Step 5: 本機先跑一次冒煙測試**

```bash
pnpm -F @agenthub/web dev &
sleep 8
cd apps/web && BASE_URL=http://localhost:3000 node --env-file=../../.env --import tsx scripts/smoke.ts; cd ../..
kill %1
```

Expected: 印出「冒煙測試通過」，總結含三段標題（缺少時只是警告，但要檢查主管 prompt 並修正後重跑）。

- [ ] **Step 6: 合併到 main 並 push（觸發 production 部署）**

```bash
cd /Users/eric/Desktop/AgentHub
pnpm -r test && pnpm -r typecheck
git add apps/web/vercel.json apps/web/scripts/smoke.ts .gitignore
git commit -m "chore(web): Vercel 設定與冒煙測試"
git checkout main
git merge --no-ff feat/mvp -m "Merge feat/mvp: AgentHub MVP

Claude-Session: https://claude.ai/code/session_019gWKBjFHT2VamSLeQeXEqj"
git push origin main
git checkout feat/mvp
```

等待部署完成：

```bash
vercel ls agenthub --scope rayzilabs-2056 | head -5
```

直到最新一筆是 `● Ready`（`● Error` 時用 `vercel inspect <url> --logs --scope rayzilabs-2056` 看錯誤、修正、commit、再合併 push）。

- [ ] **Step 7: 對 production 跑冒煙測試**

```bash
cd apps/web && BASE_URL=https://agenthub-kappa-pink.vercel.app node --env-file=../../.env --import tsx scripts/smoke.ts; cd ../..
```

（網址以 `vercel ls` 顯示的 production 網址為準。）

Expected: 「冒煙測試通過」。失敗時看 `vercel logs` 修正後重新部署再跑，直到通過。把 production 網址與冒煙測試輸出寫進報告。

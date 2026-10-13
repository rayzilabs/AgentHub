# 平台金鑰隔離 A：同一台 Sprite 分開帳號 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 代為執行的一切（`bash`、`read_file`、`write_file`、stdio MCP）都改用沒有 sudo 的 `agent` 帳號、在清空的環境變數下執行，拿不到 runtime 的平台金鑰；同時完成 C 的三項實作前驗證。

**Architecture:** 新增 `packages/runtime/src/sandbox.ts`，把「以哪個帳號、帶哪些環境變數執行」集中成一個 `Sandbox` 介面；工具與 MCP 都透過它啟動子行程。佈建時以一段可重複執行的腳本建立 `agent` 帳號與 `/workspace`，`.env` 只有 runtime 讀得到。上線前用一台暫時的 Sprite 逐項驗收。

**Tech Stack:** Node `child_process`、`sudo`（Sprite 內 `sprite` 帳號免密碼 sudo）、`@fly/sprites`、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md`（本計畫只涵蓋 A 與第 6 節的驗證；C 的實作計畫待驗證結果出來後另寫）。長期參考：`docs/security-model.md`。

## Global Constraints

- 沙盒帳號名稱 `agent`，沒有 sudo；「以哪個帳號執行」是參數（子專案 2 會改成每位顧問一個帳號）。
- 以沙盒執行時，環境變數只保留 `PATH`、`LANG`、`TZ` 與 `HOME`（Windows 本機另保留 `SYSTEMROOT`、`COMSPEC`、`PATHEXT`、`TEMP`、`TMP`、`USERPROFILE`），加上呼叫端明確給的 `extraEnv`。
- 傳給沙盒的祕密（stdio MCP 的金鑰）一律走環境變數，不放進指令參數（`/proc/<pid>/cmdline` 所有帳號都讀得到）。
- 工作區：`/workspace/agents`、`/workspace/shared`，擁有者 `sprite:workspace`，權限 `2770`；`agent` 屬於 `workspace` 群組；runtime 與沙盒的 umask 都是 `002`。
- runtime 目錄 `~/agenthub` 權限 `700`，`.env` 權限 `600`、擁有者是 runtime 帳號。
- `SANDBOX_USER` 未設定（本機開發）時以目前帳號執行，但環境變數照樣清空。
- 工具的輸入輸出形狀不變，prompt 不改。
- 這台 Windows 電腦用 `corepack pnpm`；測試直接打雲端 Supabase（正式站），teardown 會刪 `@test.local` 帳號。
- Windows 上既有的 6 個失敗（路徑分隔符、Unix socket）是基準；新增的檔案工具測試若只在 Windows 因 `bash`／唯讀屬性失敗，比照列入基準並記在 ledger。
- 依使用者全域規則：commit 前先取得使用者同意（或使用者先行授權本分支自動 commit）；`git add` 只列具體檔案；訊息 `<type>(<scope>): <功能描述>`。
- 對外動作（建立／刪除 Sprite、`publish-runtime`、push `main`、`redeploy-runtime`）執行前都要使用者明確同意；`redeploy-runtime` 會重啟展覽 Demo。

## Review Focus

1. **`sudo` 把指令放進另一個程序群組**：逾時時以負的 pgid 送 SIGKILL 可能殺不到 agent 的程序，bash 會一直跑。→ Task 8 在真的 Sprite 上驗證逾時終止。
2. **agent 在 `/shared` 建了與上傳檔案同名的檔案**：runtime 同步時寫不進 agent 擁有的檔案（`EACCES`），整個 run 失敗。→ Task 7 同步改成先刪再寫，並有測試。
3. **Sprites 檔案 API 寫 `.env` 的擁有者不是 runtime 帳號**：改成 `600` 後 runtime 讀不到，服務起不來。→ Task 7 佈建腳本先 `chown` 再 `chmod`；Task 8 檢查 `/health`。
4. **既有專案重新佈建**：舊目錄 `~/agenthub/{agents,shared}` 裡顧問寫出的檔案必須搬到 `/workspace` 而不遺失。→ Task 8 先建立舊目錄與檔案，再佈建，確認檔案還在。
5. **本機開發（未設定 `SANDBOX_USER`）**：bash、檔案工具、stdio MCP 照常運作，只是環境變數變少。→ Task 3–5 的既有測試全部在本機模式下通過。

---

## 檔案結構

```text
packages/runtime/src/
  sandbox.ts         新增：Sandbox 介面、createSandbox、sandboxEnv、sudoArgv、killArgv、runInSandbox、checkSandboxUser
  tools/bash.ts      runBash／bashTool 改用 Sandbox
  tools/files.ts     read_file／write_file 改以沙盒帳號執行
  mcp.ts             stdio MCP 改以沙盒帳號執行
  config.ts          SANDBOX_USER
  agents/build.ts    依 config 建立 Sandbox 並傳給工具與 MCP
  consultant.ts      config 型別加 SANDBOX_USER
  sync.ts            同步專案檔案時先刪再寫
  main.ts            umask 002；SANDBOX_USER 不可用時拒絕啟動
packages/runtime/scripts/publish.mjs   --versioned-only：只上傳 main-<sha>.js
apps/web/lib/sprites.ts                sandboxSetupScript、installRuntime 新流程、可指定 runtime 物件
apps/web/scripts/probe-sandbox.ts      新增：建立暫時 Sprite 逐項驗收後刪除
docs/security-model.md、docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md、CLAUDE.md
```

---

## Task 0：基準線

- [ ] **Step 1：確認分支與工作區**

```bash
cd D:/AgentHub/eric-agenthub
git switch feat/sandbox-isolation
git status --short   # 應為乾淨
```

- [ ] **Step 2：跑既有測試記錄基準**

```bash
corepack pnpm -F @agenthub/runtime test
corepack pnpm -F @agenthub/web test
corepack pnpm typecheck
```

Expected：runtime 6 個 Windows 基準失敗，其餘通過；web 全部通過；typecheck 通過。

## Task 1：C 的驗證一——Supabase 能否自行簽發 JWT（請 Eric 確認，不阻擋 A）

**Files:** Modify `docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md`（第 6 節記錄結果）

已知：專案的公開 JWKS（`https://xrcyllzqionkwareukif.supabase.co/auth/v1/.well-known/jwks.json`）只有一把 ES256 公鑰，私鑰由 Supabase 保管。

- [ ] **Step 1：請 Eric 在 Supabase Dashboard → Project Settings → JWT Keys 確認並回覆**
  1. 舊制 JWT secret（HS256）是否仍啟用、可以讀到？
  2. 是否願意匯入我們自己的 ES256 私鑰作為簽章金鑰並輪換？（會讓所有使用者需要重新登入）
- [ ] **Step 2：把結果與 C 的走向寫進 spec 第 6 節**
  - 1 或 2 可行 → C 走「自簽通行證＋RLS」。
  - 兩者都不行 → C 走「runtime 呼叫 Vercel 專用 API」，權限表不變。
- [ ] **Step 3：Commit（先取得使用者同意）**

```bash
git add docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md
git commit -m "docs: 記錄 Supabase 自簽通行證的驗證結果"
```

## Task 2：Sandbox 介面

**Files:**
- Create: `packages/runtime/src/sandbox.ts`
- Test: `packages/runtime/test/sandbox.test.ts`

**Interfaces:**
- Produces:
  - `type Sandbox = { spawn(argv: string[], opts: { cwd: string; extraEnv?: Record<string, string> }): ChildProcess; kill(child: ChildProcess): void; command(argv: string[], extraEnv?: Record<string, string>): { command: string; args: string[]; env: Record<string, string> } }`
  - `createSandbox(user?: string): Sandbox`
  - `sandboxEnv(user: string | undefined, extraEnv?: Record<string, string>): Record<string, string>`
  - `sudoArgv(user: string, argv: string[]): string[]`
  - `killArgv(user: string, pgid: number): string[]`
  - `runInSandbox(sandbox: Sandbox, argv: string[], opts: { cwd: string; input?: string }): Promise<{ code: number | null; stdout: string; stderr: string }>`
  - `checkSandboxUser(user: string): Promise<{ ok: true } | { ok: false; error: string }>`

- [ ] **Step 1：寫失敗的測試**

建立 `packages/runtime/test/sandbox.test.ts`：

```ts
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxUser, createSandbox, killArgv, runInSandbox, sandboxEnv, sudoArgv } from '../src/sandbox';

afterEach(() => {
  delete process.env.AGENTHUB_FAKE_SECRET;
});

describe('sandboxEnv', () => {
  it('只保留白名單與 extraEnv，平台金鑰之類的變數不會帶進去', () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    const env = sandboxEnv('agent', { MCP_KEY: 'k' });
    expect(env.AGENTHUB_FAKE_SECRET).toBeUndefined();
    expect(env.MCP_KEY).toBe('k');
    expect(env.HOME).toBe('/home/agent');
    expect(env.PATH).toBeTruthy();
  });
});

describe('sudoArgv / killArgv', () => {
  it('以指定帳號執行：保留呼叫端給的環境變數、umask 002，祕密不放進指令參數', () => {
    expect(sudoArgv('agent', ['bash', '-c', 'ls'])).toEqual([
      'sudo', '-n', '-E', '-u', 'agent', '--', 'sh', '-c', 'umask 002; exec "$@"', 'sandbox', 'bash', '-c', 'ls',
    ]);
  });

  it('以沙盒帳號終止整個程序群組', () => {
    expect(killArgv('agent', 1234)).toEqual(['sudo', '-n', '-u', 'agent', '--', 'kill', '-KILL', '--', '-1234']);
  });
});

describe('createSandbox（本機模式）', () => {
  it('執行的指令看不到 runtime 的環境變數', async () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    const r = await runInSandbox(createSandbox(), ['bash', '-c', 'echo "[$AGENTHUB_FAKE_SECRET]"'], { cwd: os.tmpdir() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('[]');
  });

  it('stdin 會傳進去', async () => {
    const r = await runInSandbox(createSandbox(), ['bash', '-c', 'cat'], { cwd: os.tmpdir(), input: '你好' });
    expect(r.stdout).toBe('你好');
  });

  it('command：本機模式不改寫指令，環境變數一樣清空', () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    const c = createSandbox().command(['node', 'server.js'], { MCP_KEY: 'k' });
    expect(c.command).toBe('node');
    expect(c.args).toEqual(['server.js']);
    expect(c.env.MCP_KEY).toBe('k');
    expect(c.env.AGENTHUB_FAKE_SECRET).toBeUndefined();
  });

  it('command：指定帳號時改寫成 sudo', () => {
    const c = createSandbox('agent').command(['node', 'server.js']);
    expect(c.command).toBe('sudo');
    expect(c.args).toEqual(['-n', '-E', '-u', 'agent', '--', 'sh', '-c', 'umask 002; exec "$@"', 'sandbox', 'node', 'server.js']);
  });
});

describe('checkSandboxUser', () => {
  it('帳號不存在或 sudo 不能用時回報錯誤，不丟例外', async () => {
    const r = await checkSandboxUser('agenthub-no-such-user');
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/sandbox.test.ts`
Expected: FAIL（找不到 `../src/sandbox`）

- [ ] **Step 3：實作**

建立 `packages/runtime/src/sandbox.ts`：

```ts
import { spawn, type ChildProcess } from 'node:child_process';

/** 以沙盒執行時保留的環境變數；其他（含平台金鑰）一律不帶 */
const ENV_ALLOWLIST = ['PATH', 'LANG', 'TZ'];
/** Windows 本機開發時，少了這些 bash 等程式會起不來 */
const WINDOWS_ENV = ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE'];

export type Sandbox = {
  /** 以沙盒帳號執行；子行程是新的程序群組領頭（pid 即 pgid） */
  spawn(argv: string[], opts: { cwd: string; extraEnv?: Record<string, string> }): ChildProcess;
  /** 終止 spawn 產生的整個程序群組 */
  kill(child: ChildProcess): void;
  /** 給 stdio MCP 用：把指令改寫成以沙盒帳號執行 */
  command(argv: string[], extraEnv?: Record<string, string>): { command: string; args: string[]; env: Record<string, string> };
};

export function sandboxEnv(user: string | undefined, extraEnv: Record<string, string> = {}): Record<string, string> {
  const keys = process.platform === 'win32' ? [...ENV_ALLOWLIST, ...WINDOWS_ENV] : ENV_ALLOWLIST;
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = user ? `/home/${user}` : process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return { ...env, ...extraEnv };
}

/**
 * 以 user 執行 argv。環境變數由 spawn 的 env 決定（-E 原樣帶過去），祕密不會出現在指令參數；
 * umask 002 讓 runtime 也能整理 agent 建立的檔案。
 */
export function sudoArgv(user: string, argv: string[]): string[] {
  return ['sudo', '-n', '-E', '-u', user, '--', 'sh', '-c', 'umask 002; exec "$@"', 'sandbox', ...argv];
}

/** runtime 與沙盒是不同帳號，不能直接對沙盒的程序送訊號；改以沙盒帳號送出 */
export function killArgv(user: string, pgid: number): string[] {
  return ['sudo', '-n', '-u', user, '--', 'kill', '-KILL', '--', `-${pgid}`];
}

export function createSandbox(user?: string): Sandbox {
  const wrap = (argv: string[]) => (user ? sudoArgv(user, argv) : argv);
  return {
    spawn(argv, { cwd, extraEnv }) {
      const [cmd, ...args] = wrap(argv);
      // detached：成為獨立的程序群組，逾時或中止時能連同子行程一起終止
      return spawn(cmd, args, { cwd, env: sandboxEnv(user, extraEnv), detached: true });
    },
    kill(child) {
      if (child.pid === undefined) return;
      if (!user) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        return;
      }
      const [cmd, ...args] = killArgv(user, child.pid);
      spawn(cmd, args, { stdio: 'ignore', env: sandboxEnv(user) }).on('error', () => undefined);
    },
    command(argv, extraEnv = {}) {
      const [command, ...args] = wrap(argv);
      return { command, args, env: sandboxEnv(user, extraEnv) };
    },
  };
}

/** 執行到結束並收集輸出；給檔案工具這類短指令用（bash 工具有自己的逾時與截斷） */
export function runInSandbox(
  sandbox: Sandbox,
  argv: string[],
  opts: { cwd: string; input?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = sandbox.spawn(argv, { cwd: opts.cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => resolve({ code: null, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/** 啟動時確認沙盒帳號真的能用，避免在沒有隔離的狀態下以為已隔離 */
export async function checkSandboxUser(user: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runInSandbox(createSandbox(user), ['true'], { cwd: '/' });
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || `結束碼 ${r.code}` };
}
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/sandbox.test.ts`
Expected: PASS

- [ ] **Step 5：Commit**

```bash
git add packages/runtime/src/sandbox.ts packages/runtime/test/sandbox.test.ts
git commit -m "feat(runtime): 以指定帳號與乾淨環境變數執行沙盒指令"
```

## Task 3：bash 工具改用 Sandbox

**Files:**
- Modify: `packages/runtime/src/tools/bash.ts`
- Test: `packages/runtime/test/tools.test.ts`

**Interfaces:**
- Consumes: `Sandbox`、`createSandbox`（Task 2）
- Produces: `runBash(sandbox: Sandbox, command: string, cwd: string, timeoutMs?: number, abortSignal?: AbortSignal)`、`bashTool(cwd: string, sandbox: Sandbox)`

- [ ] **Step 1：寫失敗的測試並更新既有呼叫**

`packages/runtime/test/tools.test.ts`：

- import 加 `import { createSandbox } from '../src/sandbox';`，檔案上方加 `const local = createSandbox();`
- `describe('runBash')` 裡所有 `runBash(` 改成 `runBash(local, `（例如 `runBash(local, 'echo hi > out.txt', cwd)`）
- 「工具的 description 欄位」測試裡 `bashTool(dir)` 改成 `bashTool(dir, local)`
- 在 `describe('runBash')` 內新增：

```ts
  it('看不到 runtime 的環境變數（平台金鑰不會帶進 bash）', async () => {
    process.env.AGENTHUB_FAKE_SECRET = 'leak';
    try {
      const r = await runBash(local, 'echo "[$AGENTHUB_FAKE_SECRET]"', await workDir());
      expect(r.output.trim()).toBe('[]');
    } finally {
      delete process.env.AGENTHUB_FAKE_SECRET;
    }
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tools.test.ts`
Expected: FAIL（型別錯誤或新測試輸出 `[leak]`）

- [ ] **Step 3：實作**

`packages/runtime/src/tools/bash.ts`：

- 移除 `import { spawn } from 'node:child_process';`，加 `import type { Sandbox } from '../sandbox';`
- `runBash` 簽名改成 `export function runBash(sandbox: Sandbox, command: string, cwd: string, timeoutMs = BASH_TIMEOUT_MS, abortSignal?: AbortSignal)`
- `const child = spawn('bash', ['-c', command], { cwd, env: process.env, detached: true });` 改成：

```ts
    // 以沙盒帳號執行，環境變數只剩白名單；逾時或中止時以同一個帳號終止整個程序群組
    const child = sandbox.spawn(['bash', '-c', command], { cwd });
```

- `killGroup` 換成：

```ts
    const killGroup = () => sandbox.kill(child);
```

- `bashTool` 改成：

```ts
export function bashTool(cwd: string, sandbox: Sandbox) {
  return tool({
    description: '在你的工作目錄執行 bash 指令。單次最長 120 秒，輸出超過 20000 字元會被截斷。',
    inputSchema: z.object({ command: z.string().describe('要執行的 bash 指令'), description: DESCRIPTION_FIELD }),
    execute: async ({ command }, { abortSignal }) => runBash(sandbox, command, cwd, BASH_TIMEOUT_MS, abortSignal),
  });
}
```

`packages/runtime/src/agents/build.ts`：`bash: bashTool(workDir),` 暫時改成 `bash: bashTool(workDir, createSandbox()),` 並 import `createSandbox`（Task 6 改成依 config）。

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tools.test.ts test/build.test.ts` 與 `corepack pnpm -F @agenthub/runtime typecheck`
Expected: PASS（基準失敗除外）

- [ ] **Step 5：Commit**

```bash
git add packages/runtime/src/tools/bash.ts packages/runtime/src/agents/build.ts packages/runtime/test/tools.test.ts
git commit -m "feat(runtime): bash 改由沙盒帳號執行，不再繼承平台金鑰"
```

## Task 4：檔案工具改以沙盒帳號執行

**Files:**
- Modify: `packages/runtime/src/tools/files.ts`、`packages/runtime/src/agents/build.ts`
- Test: `packages/runtime/test/tools.test.ts`

**Interfaces:**
- Consumes: `runInSandbox`、`Sandbox`（Task 2）
- Produces: `readFileTool(cwd: string, sandbox: Sandbox)`、`writeFileTool(cwd: string, sandbox: Sandbox)`

- [ ] **Step 1：更新既有測試呼叫並新增測試**

`packages/runtime/test/tools.test.ts` 的 `describe('read_file / write_file')`：所有 `readFileTool(x)`、`writeFileTool(x)` 改成 `readFileTool(x, local)`、`writeFileTool(x, local)`；「工具的 description 欄位」裡的 `writeFileTool(dir)` 同樣改。新增：

```ts
  it('寫入的內容原樣保存（多位元組、換行、引號）', async () => {
    const cwd = await workDir();
    const content = '第一行\n"引號" $變數 `反引號`\n';
    await writeFileTool(cwd, local).execute!({ path: 'q.md', content }, opts);
    expect(await readFile(path.join(cwd, 'q.md'), 'utf8')).toBe(content);
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tools.test.ts`
Expected: FAIL（`readFileTool` 只接受一個參數的型別錯誤）

- [ ] **Step 3：實作**

`packages/runtime/src/tools/files.ts` 整個換成：

```ts
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { runInSandbox, type Sandbox } from '../sandbox';
import { DESCRIPTION_FIELD, MAX_OUTPUT, truncate } from './bash';

/** 多讀一些位元組再截斷，確保 20000 字元內不會切到多位元組字 */
const READ_LIMIT_BYTES = MAX_OUTPUT * 4;

/** 以沙盒帳號讀寫：權限與 bash 相同，讀不到的檔案（含 symlink 指向的）一樣讀不到 */
export function readFileTool(cwd: string, sandbox: Sandbox) {
  return tool({
    description: '讀取檔案。相對路徑以你的工作目錄為基準，也可以用絕對路徑讀專案共用檔案。超過 20000 字元會被截斷。',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path: p }) => {
      const target = path.resolve(cwd, p);
      const r = await runInSandbox(sandbox, ['bash', '-c', 'head -c "$1" -- "$2"', 'read_file', String(READ_LIMIT_BYTES), target], { cwd });
      if (r.code !== 0) return { error: r.stderr.trim() || `無法讀取 ${target}` };
      return { content: truncate(r.stdout) };
    },
  });
}

export function writeFileTool(cwd: string, sandbox: Sandbox) {
  return tool({
    description: '寫入檔案（覆蓋），需要的資料夾會自動建立。相對路徑以你的工作目錄為基準。',
    inputSchema: z.object({ path: z.string(), content: z.string(), description: DESCRIPTION_FIELD }),
    execute: async ({ path: p, content }) => {
      const target = path.resolve(cwd, p);
      // 內容從 stdin 傳入，不放進指令參數
      const r = await runInSandbox(
        sandbox,
        ['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write_file', target],
        { cwd, input: content },
      );
      if (r.code !== 0) return { error: r.stderr.trim() || `無法寫入 ${target}` };
      return { ok: true, path: target };
    },
  });
}
```

`packages/runtime/src/agents/build.ts`：`read_file: readFileTool(workDir),`、`write_file: writeFileTool(workDir),` 改成傳入同一個 `createSandbox()`（在 `buildConsultant` 開頭 `const sandbox = createSandbox();`，`bash` 也用它）；`buildManager` 的 `read_file: readFileTool(ctx.config.SHARED_ROOT),` 改成 `readFileTool(ctx.config.SHARED_ROOT, createSandbox())`。

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tools.test.ts test/build.test.ts test/server.test.ts` 與 `corepack pnpm -F @agenthub/runtime typecheck`
Expected: PASS（基準失敗除外；若檔案工具測試只在 Windows 失敗，記 ledger 並列入基準）

- [ ] **Step 5：Commit**

```bash
git add packages/runtime/src/tools/files.ts packages/runtime/src/agents/build.ts packages/runtime/test/tools.test.ts
git commit -m "feat(runtime): read_file 與 write_file 改由沙盒帳號執行"
```

## Task 5：stdio MCP 改以沙盒帳號執行

**Files:**
- Modify: `packages/runtime/src/mcp.ts`、`packages/runtime/src/agents/build.ts`
- Test: `packages/runtime/test/mcp.test.ts`

**Interfaces:**
- Consumes: `Sandbox.command`（Task 2）
- Produces: `connectMcpServers(servers, secretsByServer, cwd, sandbox: Sandbox, connect?, timeoutMs?)`

- [ ] **Step 1：更新測試**

`packages/runtime/test/mcp.test.ts`：import `createSandbox`，所有 `connectMcpServers(servers, secrets, cwd, ...)` 在第 4 個位置插入 `createSandbox()`（原本的 `fakeConnect`、逾時參數往後移一格）。新增：

```ts
  it('stdio：指定沙盒帳號時以 sudo 啟動，金鑰放在環境變數而不是指令參數', async () => {
    const seen: unknown[] = [];
    const fakeConnect = (async (config: { transport: unknown }) => {
      seen.push(config.transport);
      return { tools: async () => ({}), close: async () => {} };
    }) as unknown as typeof createMCPClient;
    await connectMcpServers(
      [{ name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] }],
      { local: { API_KEY: 'secret-1' } },
      '/tmp',
      createSandbox('agent'),
      fakeConnect,
    );
    const params = (seen[0] as { serverParams: { command: string; args: string[]; env: Record<string, string> } }).serverParams;
    expect(params.command).toBe('sudo');
    expect(params.args.slice(-2)).toEqual(['node', 'server.js']);
    expect(params.args.join(' ')).not.toContain('secret-1');
    expect(params.env.API_KEY).toBe('secret-1');
  });
```

（若 `Experimental_StdioMCPTransport` 的設定欄位名稱不是 `serverParams`，先 `console.log(Object.keys(seen[0]))` 找到實際欄位後改測試，並記 ledger。）

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/mcp.test.ts`
Expected: FAIL

- [ ] **Step 3：實作**

`packages/runtime/src/mcp.ts`：

- 加 `import type { Sandbox } from './sandbox';`
- `transportFor` 簽名改成 `transportFor(server: McpServerConfig, secrets: Record<string, string>, cwd: string, sandbox: Sandbox)`，stdio 分支換成：

```ts
  if (!server.command) throw new Error('缺少 command');
  // 以沙盒帳號啟動：創作者的 MCP 程式讀不到 runtime 的檔案與平台金鑰
  const { command, args, env } = sandbox.command([server.command, ...(server.args ?? [])], secrets);
  return new Experimental_StdioMCPTransport({ command, args, env, cwd });
```

- `connectMcpServers` 參數改成 `(servers, secretsByServer, cwd, sandbox: Sandbox, connect = createMCPClient, timeoutMs = MCP_CONNECT_TIMEOUT_MS)`，呼叫 `transportFor(server, secretsByServer[server.name] ?? {}, cwd, sandbox)`

`packages/runtime/src/agents/build.ts`：`connectMcpServers(ctx.instance.mcp_servers, ctx.secrets, workDir)` 改成 `connectMcpServers(ctx.instance.mcp_servers, ctx.secrets, workDir, sandbox)`（`sandbox` 移到 `buildConsultant` 最前面建立）。

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/mcp.test.ts test/build.test.ts` 與 typecheck
Expected: PASS

- [ ] **Step 5：Commit**

```bash
git add packages/runtime/src/mcp.ts packages/runtime/src/agents/build.ts packages/runtime/test/mcp.test.ts
git commit -m "feat(runtime): stdio MCP 改由沙盒帳號啟動"
```

## Task 6：依設定建立 Sandbox、啟動檢查

**Files:**
- Modify: `packages/runtime/src/config.ts`、`packages/runtime/src/agents/build.ts`、`packages/runtime/src/consultant.ts`、`packages/runtime/src/main.ts`
- Test: `packages/runtime/test/build.test.ts`

**Interfaces:**
- Consumes: `createSandbox`、`checkSandboxUser`（Task 2）
- Produces: `Config.SANDBOX_USER?: string`；`ConsultantContext.config`、`ManagerContext.config`、`ConsultantRunnerDeps.config` 的 Pick 加上 `'SANDBOX_USER'`

- [ ] **Step 1：寫失敗的測試**

`packages/runtime/test/build.test.ts` 的 `describe('buildConsultant')` 新增：

```ts
  it('依 config 的 SANDBOX_USER 建立沙盒：bash 以該帳號執行', async () => {
    const projectId = await seedProject(db, await seedUser(db));
    const id = await seedConsultant(db, projectId);
    const roots = await tmpRoots();
    const model = mockModel(toolTurn('bash', { command: 'echo hi' }), textTurn('好'));
    const built = await buildConsultant({
      db, model,
      config: { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot, SANDBOX_USER: 'agenthub-no-such-user' },
      instance: instance({ id, project_id: projectId }), sharedFiles: [], secrets: {},
    });
    let last;
    try {
      for await (const m of readUIMessageStream({ stream: await built.streamUI({ messages: [{ role: 'user', content: '跑一下' }] }) })) last = m;
    } finally {
      await built.close();
    }
    // 帳號不存在 → sudo 失敗；證明 bash 真的透過指定帳號執行，而不是直接以 runtime 帳號跑
    const bash = last!.parts.find((p) => p.type === 'tool-bash') as { output?: { output: string; exitCode: number | null } };
    expect(bash.output?.exitCode).not.toBe(0);
    expect(bash.output?.output).not.toContain('hi');
  });
```

（import 補上 `toolTurn`。）

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/build.test.ts -t "SANDBOX_USER"`
Expected: FAIL（型別錯誤：config 沒有 `SANDBOX_USER`；或輸出含 `hi`）

- [ ] **Step 3：實作**

`packages/runtime/src/config.ts` 的 `EnvSchema` 加：

```ts
  /** 沙盒帳號；Sprite 上一律是 agent，本機開發不設定 */
  SANDBOX_USER: z.string().min(1).optional(),
```

`packages/runtime/src/agents/build.ts`：

- `ConsultantContext.config` 改成 `Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT' | 'SANDBOX_USER'>`
- `ManagerContext.config` 改成 `Pick<Config, 'PROJECT_ID' | 'SHARED_ROOT' | 'SANDBOX_USER'>`
- `buildConsultant` 的 `const sandbox = createSandbox();` 改成 `const sandbox = createSandbox(ctx.config.SANDBOX_USER);`
- `buildManager` 的 `readFileTool(ctx.config.SHARED_ROOT, createSandbox())` 改成 `readFileTool(ctx.config.SHARED_ROOT, createSandbox(ctx.config.SANDBOX_USER))`

`packages/runtime/src/consultant.ts`：`config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>;` 改成加上 `| 'SANDBOX_USER'`。

`packages/runtime/src/main.ts`：在 `const config = loadConfig();` 之後加：

```ts
// 沙盒帳號與 runtime 共用工作區，新檔案要讓同群組可寫
process.umask(0o002);

if (config.SANDBOX_USER) {
  const check = await checkSandboxUser(config.SANDBOX_USER);
  if (!check.ok) {
    // 寧可起不來，也不要在沒有隔離的狀態下替 agent 執行指令
    console.error(`[startup] 沙盒帳號 ${config.SANDBOX_USER} 無法使用：${check.error}`);
    process.exit(1);
  }
}
```

並 import `checkSandboxUser`。

- [ ] **Step 4：跑 runtime 全部測試與型別檢查**

Run: `corepack pnpm -F @agenthub/runtime test`、`corepack pnpm -F @agenthub/runtime typecheck`
Expected: 通過（基準失敗除外）

- [ ] **Step 5：Commit**

```bash
git add packages/runtime/src/config.ts packages/runtime/src/agents/build.ts packages/runtime/src/consultant.ts packages/runtime/src/main.ts packages/runtime/test/build.test.ts
git commit -m "feat(runtime): 依 SANDBOX_USER 建立沙盒，帳號不可用時拒絕啟動"
```

## Task 7：佈建流程

**Files:**
- Modify: `apps/web/lib/sprites.ts`、`packages/runtime/src/sync.ts`、`packages/runtime/scripts/publish.mjs`
- Test: `apps/web/test/sprites.test.ts`、`packages/runtime/test/sync.test.ts`

**Interfaces:**
- Produces: `WORKSPACE = '/workspace'`、`SANDBOX_USER = 'agent'`、`sandboxSetupScript(base: string): string`、`installRuntime(db, sprite, projectId, runtimeObject = RUNTIME_OBJECT)`；`publish-runtime -- --versioned-only`

- [ ] **Step 1：寫失敗的測試**

`apps/web/test/sprites.test.ts`：import 加 `sandboxSetupScript`。`installRuntime` 測試裡 `execFile` 的分類改成：

```ts
      execFile: async (_cmd: string, args: string[]) => {
        calls.push(args[1].startsWith('printf') ? 'home' : args[1].startsWith('set -euo pipefail') ? 'setup' : 'download');
        return { stdout: '/home/sprite\n' };
      },
```

`filesystem` 的 `writeFile` 改成記錄內容：

```ts
      filesystem: () => ({ writeFile: async (name: string, content: string) => { calls.push(`write:${name}`); written[name] = content; } }),
```

（測試開頭加 `const written: Record<string, string> = {};`）期望值改成：

```ts
    expect(calls).toEqual([
      'home', 'download', 'write:.env', 'setup',
      'create:runtime:10s', 'create:drained',
      'restart:runtime:10s', 'restart:drained',
    ]);
    expect(written['.env']).toContain('AGENTS_ROOT="/workspace/agents"');
    expect(written['.env']).toContain('SHARED_ROOT="/workspace/shared"');
    expect(written['.env']).toContain('SANDBOX_USER="agent"');
```

新增：

```ts
describe('sandboxSetupScript', () => {
  it('建立沒有 sudo 的 agent 帳號與工作區，收緊 runtime 目錄，搬移舊工作區', () => {
    const s = sandboxSetupScript('/home/sprite/agenthub');
    expect(s.startsWith('set -euo pipefail')).toBe(true);
    expect(s).toContain('useradd --create-home --shell /bin/bash agent');
    expect(s).not.toMatch(/usermod -aG sudo/);
    expect(s).toContain("cp -a '/home/sprite/agenthub/agents/.' /workspace/agents/");
    expect(s).toContain('chown -R "$(id -un)":workspace /workspace');
    expect(s).toContain('chmod 2770 /workspace/agents /workspace/shared');
    expect(s).toContain("chmod 700 '/home/sprite/agenthub'");
    expect(s).toContain("chmod 600 '/home/sprite/agenthub/.env'");
  });
});
```

`packages/runtime/test/sync.test.ts` 新增（Review Focus 2）：

```ts
it('專案檔案同步時，目標檔若是唯讀（agent 建立的同名檔）也能覆蓋', async () => {
  const { sharedRoot } = await tmpRoots();
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(path.join(sharedRoot, 'a.txt'), 'old');
  await chmod(path.join(sharedRoot, 'a.txt'), 0o444);
  const fakeDb = {
    storage: {
      from: () => ({
        list: async () => ({ data: [{ id: '1', name: 'a.txt', updated_at: 't2' }], error: null }),
        download: async () => ({ data: new Blob(['new']), error: null }),
      }),
    },
  } as unknown as Db;
  await syncSharedFiles(fakeDb, 'p1', sharedRoot);
  expect(await readFile(path.join(sharedRoot, 'a.txt'), 'utf8')).toBe('new');
});
```

（import 補上 `chmod`、`mkdir`、`readFile`、`writeFile`、`path`、`tmpRoots`、`Db`、`syncSharedFiles` 中缺少的。）

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/web exec vitest run test/sprites.test.ts` 與 `corepack pnpm -F @agenthub/runtime exec vitest run test/sync.test.ts`
Expected: FAIL

- [ ] **Step 3：實作**

`apps/web/lib/sprites.ts`：

在 `RUNTIME_OBJECT` 下面加：

```ts
export const WORKSPACE = '/workspace';
export const SANDBOX_USER = 'agent';

/**
 * 建立沙盒帳號與工作區（可重複執行），以 runtime 帳號透過 sudo 執行。
 * 工作區由 runtime 帳號擁有、workspace 群組可寫；agent 只靠群組權限進入，沒有 sudo，進不了 runtime 目錄。
 */
export function sandboxSetupScript(base: string): string {
  const q = (p: string) => `'${p}'`;
  return [
    'set -euo pipefail',
    `id -u ${SANDBOX_USER} >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash ${SANDBOX_USER}`,
    'getent group workspace >/dev/null || sudo groupadd workspace',
    `sudo usermod -aG workspace ${SANDBOX_USER}`,
    `sudo mkdir -p ${WORKSPACE}/agents ${WORKSPACE}/shared`,
    // 舊版的工作區在 runtime 目錄底下；搬過來，顧問寫出的檔案不會遺失
    `if [ -d ${q(`${base}/agents`)} ]; then sudo cp -a ${q(`${base}/agents/.`)} ${WORKSPACE}/agents/ && sudo rm -rf ${q(`${base}/agents`)}; fi`,
    `if [ -d ${q(`${base}/shared`)} ]; then sudo cp -a ${q(`${base}/shared/.`)} ${WORKSPACE}/shared/ && sudo rm -rf ${q(`${base}/shared`)}; fi`,
    `sudo chown -R "$(id -un)":workspace ${WORKSPACE}`,
    `sudo chmod -R g+rwX,o-rwx ${WORKSPACE}/agents ${WORKSPACE}/shared`,
    `sudo find ${WORKSPACE}/agents ${WORKSPACE}/shared -type d -exec chmod g+s {} +`,
    `sudo chmod 2770 ${WORKSPACE}/agents ${WORKSPACE}/shared`,
    `sudo chmod 755 ${WORKSPACE}`,
    // .env 可能由檔案 API 以別的帳號寫入，先改回 runtime 帳號再收緊
    `sudo chown "$(id -un)" ${q(`${base}/.env`)}`,
    `chmod 600 ${q(`${base}/.env`)}`,
    `chmod 700 ${q(base)}`,
  ].join('\n');
}
```

`installRuntime` 改成：

```ts
export async function installRuntime(db: Db, sprite: Sprite, projectId: string, runtimeObject = RUNTIME_OBJECT): Promise<string> {
  const { stdout } = await sprite.execFile('bash', ['-lc', 'printf %s "$HOME"']);
  const base = `${String(stdout).trim()}/agenthub`;
  const { data, error } = await db.storage.from('runtime').createSignedUrl(runtimeObject, 600);
  if (error) throw new Error(`找不到 runtime 安裝檔：${error.message}`);
  await sprite.execFile('bash', ['-lc', `mkdir -p '${base}' && curl -fsSL '${data.signedUrl}' -o '${base}/main.js'`]);
  await sprite.filesystem(base).writeFile('.env', runtimeEnvFile({
    PROJECT_ID: projectId,
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SECRET_KEY: env.supabaseSecretKey,
    VERTEX_API_EXPRESS_MODE_KEY: env.vertexKey,
    AGENTS_ROOT: `${WORKSPACE}/agents`,
    SHARED_ROOT: `${WORKSPACE}/shared`,
    SANDBOX_USER,
  }));
  await sprite.execFile('bash', ['-lc', sandboxSetupScript(base)]);
  // 以下（createService、restartService）不變
```

`packages/runtime/src/sync.ts` 的 `syncSharedFiles`，`await writeFile(path.join(sharedRoot, o.name), ...)` 前加：

```ts
      const target = path.join(sharedRoot, o.name);
      // agent 可能建立了同名檔案（擁有者是 agent，runtime 不能改寫但可以刪），先刪再寫
      await rm(target, { force: true });
      await writeFile(target, Buffer.from(await blob.arrayBuffer()));
```

（取代原本那行 `writeFile`。）

`packages/runtime/scripts/publish.mjs`：

```js
// --versioned-only：只上傳 main-<sha>.js，不動新專案預設使用的 main.js（給上線前驗收用）
const versionedOnly = process.argv.includes('--versioned-only');
for (const path of versionedOnly ? [`main-${version}.js`] : ['main.js', `main-${version}.js`]) {
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/web exec vitest run test/sprites.test.ts`、`corepack pnpm -F @agenthub/runtime exec vitest run test/sync.test.ts`、`corepack pnpm typecheck`
Expected: PASS（sync 的唯讀測試若只在 Windows 失敗，記 ledger 列入基準）

- [ ] **Step 5：Commit**

```bash
git add apps/web/lib/sprites.ts apps/web/test/sprites.test.ts packages/runtime/src/sync.ts packages/runtime/test/sync.test.ts packages/runtime/scripts/publish.mjs
git commit -m "feat(web): 佈建時建立沙盒帳號與工作區，收緊 runtime 目錄權限"
```

## Task 8：在暫時的 Sprite 上驗收（含驗證二、三）

**Files:**
- Create: `apps/web/scripts/probe-sandbox.ts`

**Interfaces:**
- Consumes: `installRuntime(db, sprite, projectId, runtimeObject)`、`spriteName`、`destroyProjectSprite`、`WORKSPACE`（Task 7）

- [ ] **Step 1：寫驗收腳本**

建立 `apps/web/scripts/probe-sandbox.ts`：

```ts
// 用法：cd apps/web && corepack pnpm exec tsx scripts/probe-sandbox.ts main-<sha>.js
// 建一台暫時的 Sprite，照正式流程佈建（含舊版工作區搬移），以 agent 帳號逐項嘗試拿平台金鑰；
// 全部擋下且功能正常才算通過。結束時一定刪除這台 Sprite。
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SpritesClient } from '@fly/sprites';

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const { adminDb } = await import('@/lib/supabase/admin');
const { destroyProjectSprite, installRuntime, WORKSPACE } = await import('@/lib/sprites');

const runtimeObject = process.argv[2];
if (!runtimeObject) throw new Error('請指定 runtime 物件名稱，例如 main-abc1234.js');

const projectId = randomUUID();
const name = `agenthub-probe-${projectId.slice(0, 8)}`;
const client = new SpritesClient(process.env.FLY_SPRITES_TOKEN!);
const results: { check: string; pass: boolean; detail: string }[] = [];

const sh = async (sprite: Awaited<ReturnType<SpritesClient['createSprite']>>, cmd: string) => {
  try {
    const r = await sprite.execFile('bash', ['-lc', cmd]);
    return { code: 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch (e) {
    const err = e as { exitCode?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return { code: err.exitCode ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim() };
  }
};
const asAgent = (cmd: string) => `sudo -n -u agent -- bash -c ${JSON.stringify(cmd)}`;

try {
  const sprite = await client.createSprite(name, { urlSettings: { auth: 'sprite' } });
  const home = (await sh(sprite, 'printf %s "$HOME"')).out;
  const base = `${home}/agenthub`;

  // 模擬舊版佈建留下的工作區（Review Focus 4）
  await sh(sprite, `mkdir -p '${base}/agents/legacy' '${base}/shared' && echo kept > '${base}/agents/legacy/report.md'`);
  await installRuntime(adminDb(), sprite, projectId, runtimeObject);

  const record = (check: string, pass: boolean, detail: string) => results.push({ check, pass, detail: detail.slice(0, 200) });
  const mustFail = async (check: string, cmd: string, leak = /SUPABASE|VERTEX|sb_secret/) => {
    const r = await sh(sprite, asAgent(cmd));
    record(check, r.code !== 0 || !leak.test(r.out), r.out);
  };

  await mustFail('env 看不到平台金鑰', 'env');
  await mustFail('讀不到 .env', `cat '${base}/.env'`);
  await mustFail('symlink 指向 .env 也讀不到', `ln -sf '${base}/.env' ${WORKSPACE}/shared/link && cat ${WORKSPACE}/shared/link`);
  await mustFail('讀不到 runtime 的 /proc environ', 'for p in $(pgrep -u "$(stat -c %U /proc/1)" node; pgrep node); do cat /proc/$p/environ 2>/dev/null | tr "\\0" "\\n"; done');
  const sudo = await sh(sprite, asAgent('sudo -n true'));
  record('agent 不能 sudo', sudo.code !== 0, sudo.out);
  const sock = await sh(sprite, asAgent('curl -s --max-time 3 --unix-socket /.sprite/api.sock http://sprite/v1/tasks'));
  record('碰不到 /.sprite/api.sock（驗證二）', sock.code !== 0, sock.out);

  const legacy = await sh(sprite, asAgent(`cat ${WORKSPACE}/agents/legacy/report.md`));
  record('舊工作區的檔案搬到 /workspace 且 agent 讀得到', legacy.out === 'kept', legacy.out);
  const write = await sh(sprite, `echo r > ${WORKSPACE}/shared/from-runtime && ${asAgent(`echo a >> ${WORKSPACE}/shared/from-runtime && echo b > ${WORKSPACE}/shared/from-agent`)} && rm ${WORKSPACE}/shared/from-agent`);
  record('runtime 與 agent 都能讀寫工作區', write.code === 0, write.out);

  const kill = await sh(sprite, [
    `setsid sudo -n -E -u agent -- sh -c 'umask 002; exec "$@"' sandbox bash -c 'sleep 300 & sleep 300' &`,
    'pid=$!; sleep 1',
    'sudo -n -u agent -- kill -KILL -- -$pid; sleep 1',
    'pgrep -u agent sleep && echo still-running || echo all-killed',
  ].join('\n'));
  record('以 agent 帳號送 SIGKILL 能終止整個程序群組（Review Focus 1）', kill.out.endsWith('all-killed'), kill.out);

  const health = await fetch(`${sprite.url}/health`, { headers: { authorization: `Bearer ${process.env.FLY_SPRITES_TOKEN}` } })
    .then(async (r) => `${r.status} ${await r.text()}`).catch((e: Error) => e.message);
  record('runtime 服務起得來（驗證三、Review Focus 3）', health.includes(projectId), health);
} finally {
  await destroyProjectSprite(name).catch((e: Error) => console.error('刪除暫時 Sprite 失敗，請手動刪除', name, e.message));
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}${r.pass ? '' : `\n      ${r.detail}`}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
```

（`/health` 若服務還在啟動，先等 10 秒再查；若 `execFile` 失敗時的錯誤物件欄位不同，依實際欄位調整 `sh` 並記 ledger。）

- [ ] **Step 2：上傳驗收用 runtime（對外動作，先取得使用者同意）**

```bash
git log --oneline -1   # 確認 Task 7 已 commit，sha 會用在物件名稱
corepack pnpm -F @agenthub/runtime publish-runtime -- --versioned-only
```

Expected：只出現「已上傳 runtime/main-<sha>.js」，沒有上傳 `main.js`。

- [ ] **Step 3：執行驗收（對外動作：會在 Eric 的 Fly 帳號建立並刪除一台暫時 Sprite，先取得使用者同意）**

```bash
cd apps/web && corepack pnpm exec tsx scripts/probe-sandbox.ts main-<sha>.js
```

Expected：每一項都是 `PASS`，結束碼 0，暫時 Sprite 已刪除。

- [ ] **Step 4：處理失敗項目**
  - `/.sprite/api.sock` 可被 agent 存取 → 在 `sandboxSetupScript` 加 `sudo chmod o-rwx /.sprite/api.sock`（或改群組），重跑 Task 7 測試與本 Task；若收緊後 runtime 的 keepalive 失效，記 ledger 並回報使用者決定。
  - 程序群組終止失敗 → 改用 `pkill -KILL -u agent -s <sid>` 或在 `sudoArgv` 前加 `setsid`，更新 Task 2 的 `killArgv` 與測試，記 ledger。
  - 其他項目失敗 → 用 systematic-debugging 找原因再修。

- [ ] **Step 5：把驗證二、三的結果寫進 spec 第 6 節，Commit**

```bash
git add apps/web/scripts/probe-sandbox.ts docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md
git commit -m "test(web): 以暫時 Sprite 驗收沙盒隔離"
```

## Task 9：文件

**Files:**
- Modify: `docs/security-model.md`、`docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md`、`CLAUDE.md`

- [ ] **Step 1：更新**
  - spec 第 0 節第 4 列改為：「stdio MCP 以 runtime 同一個帳號執行（環境變數只帶 HOME、PATH 等與它自己的金鑰），可讀 `.env` 與 runtime 的 `/proc/<pid>/environ`」。
  - `docs/security-model.md`：第 3 節「沙盒拿不到平台金鑰」改為 🚧（上線後改 ✅）；第 6 節子專案 1 狀態改為「A 實作完成，C 待驗證結果」。
  - `CLAUDE.md`「架構」加一條：「agent 代為執行的一切（bash、read_file／write_file、stdio MCP）都透過 `packages/runtime/src/sandbox.ts` 以 `SANDBOX_USER`（Sprite 上是 `agent`）執行，環境變數只剩白名單；工作區在 `/workspace`。權限規則見 `docs/security-model.md`。」
- [ ] **Step 2：Commit**

```bash
git add docs/security-model.md docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md CLAUDE.md
git commit -m "docs: 記錄沙盒隔離的實作與狀態"
```

## Task 10：上線 A

- [ ] **Step 1：完整驗證**：`corepack pnpm test`、`corepack pnpm typecheck`、`corepack pnpm -F @agenthub/web lint`
- [ ] **Step 2：合併與發布（對外動作，先取得使用者同意）**：依使用者規則呼叫 `superpowers:finishing-a-development-branch`；合併到 `main` 並 push（web 自動部署，新專案從此用新的佈建流程），再 `corepack pnpm -F @agenthub/runtime publish-runtime`。
- [ ] **Step 3：新專案驗證**：請使用者新開一個專案，跑一次派工、上傳檔案、記憶；確認功能正常。必要時對該 Sprite 以 agent 身分重跑 Task 8 的檢查項目。
- [ ] **Step 4：既有專案（對外動作，與使用者、Eric 確認時間）**：`cd apps/web && corepack pnpm exec tsx scripts/redeploy-runtime.ts`。這會重啟所有 Sprite，含展覽 Demo；之後抽查展覽 Demo 專案一次。
- [ ] **Step 5：更新 `docs/security-model.md`**：「沙盒拿不到平台金鑰」改為 ✅ 並註明日期；commit 並 push（同樣先取得同意）。

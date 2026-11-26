# 執行環境改用 E2B（保留切回 Sprite）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 專案 runtime 與平台代管 MCP 可以跑在 Sprite 或 E2B，每個專案／代管版本記住自己在哪一家；新的一律開在 E2B，既有的用腳本全部搬到 E2B。

**Architecture：** 新增 `apps/web/lib/hosts/`：一個 `RuntimeHost` 介面、Sprite 與 E2B 兩份實作。資料列以 `host`／`sprite_name`／`sprite_url`／`host_token` 描述一台機器（`Machine`），所有開機、執行、服務、延長、轉送標頭都經 `hostFor(machine.host)`。runtime 依 `.env` 的 `RUNTIME_HOST` 決定防休眠要找 Sprite Tasks API 還是平台的 `/api/runtime/keepalive`。

**Tech Stack：** Next.js 16、Supabase、Vitest、`@fly/sprites`、`e2b@2.64.0`（新增、鎖定版本）、runtime（Hono＋AI SDK v7，esbuild `node22`）。

**Spec：** `docs/superpowers/specs/2026-11-25-e2b-runtime-host-design.md`（使用者已核可；額度提醒不做）。

## Global Constraints

- 每個 task 依 repo `CLAUDE.md`：繁體中文的訊息與註解、`route()` 包裝 API、先查文件再寫 `@fly/sprites`／E2B／AI SDK／Next 16。
- **commit、push 都要先問使用者**（全域規則：不自動 commit）；push 到 `main` 就上 production，push 前 `pnpm test`、`pnpm typecheck` 都要過。Stage 指定檔案，不用 `git add .`。
- `e2b` 鎖 `2.64.0`（實測版本），只裝在 `apps/web`。runtime 不新增依賴。
- runtime 與沙盒不得拿到 `E2B_API_KEY`、`FLY_SPRITES_TOKEN`；`host_token` 不得出現在任何送給瀏覽器的回應。
- 常數：E2B 範本 `agenthub-runtime`（2 vCPU、8192 MB）、`agenthub-mcp`（1 vCPU、2048 MB）；專案沙盒逾時 5 分鐘、代管沙盒建立時 15 分鐘；`lifecycle: { onTimeout: 'pause', autoResume: true }`、`network: { allowPublicTraffic: false }`；E2B 邊緣標頭 `e2b-traffic-access-token`；keepalive 每 2 分鐘、每次延長 5 分鐘。
- E2B 範本工具清單＝`probe-sandbox.ts` 的語言清單：Node 22 LTS、npm、python3、pip、numpy、pandas、go、java、ruby、git、curl。代管範本：Node 22 LTS、python3、pip。
- `DEFAULT_RUNTIME_HOST` 環境變數，值 `sprite`／`e2b`，未設定時 `e2b`。
- 測試打雲端 Supabase；runtime 測試從 Git Bash 跑。
- 改 runtime 資料庫權限或資料表前先改 `docs/security-model.md`。

## Review Focus

1. **暫停中的沙盒被當成不見**：對暫停中的 E2B 沙盒 `setTimeout` 會丟 `SandboxNotFoundError`，必須再 `getInfo` 確認，`paused` 不能把專案標成錯誤 → Task 3 測試。
2. **`host_token` 外洩到瀏覽器**：`listVersions` 現在回傳整列 `hosted_mcp_versions`，`PROJECT_COLUMNS` 被很多 API 用 → Task 1、Task 6 測試。
3. **E2B `destroy` 刪到別人的沙盒**：帳號裡還有測試沙盒與將來其他用途的沙盒，沒有 `metadata.app === 'agenthub'` 與相符前綴的不能刪 → Task 3 測試。
4. **沙盒冷開機後程序全沒了**：網址連得到機器、但 runtime 沒在跑，轉送要重啟服務一次再試，不能直接回「無法連線」→ Task 4 測試。
5. **搬遷途中有人開始對話**：檢查沒有 running run 之後、狀態改成 `provisioning` 之前的空檔 → Task 9 測試（先改狀態再檢查）。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `supabase/migrations/20261126000001_runtime_host.sql` | 新增 | `host`、`host_token` 兩欄（兩張表） |
| `apps/web/lib/hosts/types.ts` | 新增 | `HostName`、`Machine`、`ServiceSpec`、`Liveness`、`RuntimeHost` |
| `apps/web/lib/hosts/sprite.ts` | 新增 | Sprite 實作；從 `lib/sprites.ts` 移入 `errorText`、`retryTransient`、`isNotFound`、`getOrCreateSprite`、`deleteSpriteIfExists`、`findService` |
| `apps/web/lib/hosts/e2b.ts` | 新增 | E2B 實作與 `E2B_SERVICE_SCRIPT` |
| `apps/web/lib/hosts/index.ts` | 新增 | `hostFor`、`defaultHost`、`projectMachine`、`versionMachine` |
| `apps/web/lib/sprites.ts` → `apps/web/lib/project-runtime.ts` | 改名＋改寫 | 沙盒腳本、`installRuntime`、`provisionProject`、`forwardChat`、`waitForHealth`，全部經 `RuntimeHost` |
| `apps/web/lib/hosted-sprite.ts` → `apps/web/lib/hosted-runtime.ts` | 改名＋改寫 | 代管 MCP 的腳本與 `createHostedOps` |
| `apps/web/app/api/runtime/keepalive/route.ts` | 新增 | runtime 要求延長 |
| `packages/runtime/src/keepalive.ts`、`config.ts`、`run.ts` | 修改 | 依 `RUNTIME_HOST` 防休眠 |
| `apps/web/lib/services/move-host.ts`、`apps/web/scripts/move-host.ts` | 新增 | 搬遷邏輯與 CLI |
| `apps/web/scripts/e2b-templates.ts` | 新增 | 建兩個 E2B 範本 |
| 其餘呼叫端 | 修改 | 見各 task |

---

### Task 1：資料庫欄位與型別

**Files:**
- Create: `supabase/migrations/20261126000001_runtime_host.sql`
- Modify: `docs/security-model.md`（第 4 節 `projects`、`hosted_mcp_versions` 兩列說明新欄位）、`supabase/tests/runtime_access.sql`、`apps/web/lib/services/projects.ts`（`ProjectRow`、`PROJECT_COLUMNS`、`createProject`）、`apps/web/lib/services/hosted-mcp.ts`（`HostedVersion`、`createVersion`）
- Test: `apps/web/test/projects.test.ts`

**Interfaces:**
- Produces: `projects.host`／`hosted_mcp_versions.host`：`text not null default 'sprite' check (host in ('sprite','e2b'))`；兩表 `host_token text`。`ProjectRow.host: HostName`（不含 `host_token`）；`HostedVersion.host: HostName; host_token: string | null`。

- [ ] **Step 1：寫失敗的測試** `projects.test.ts`：`it('新專案記錄 DEFAULT_RUNTIME_HOST；專案資料不含 host_token')`：設 `process.env.DEFAULT_RUNTIME_HOST='e2b'` → `createProject` 回傳的列 `host === 'e2b'`，`'host_token' in row === false`；未設定時也是 `'e2b'`。
- [ ] **Step 2：跑** `pnpm -F @agenthub/web test test/projects.test.ts`，預期 FAIL（欄位不存在）。
- [ ] **Step 3：寫 migration**，與 `runtime_access.sql` 一條斷言：runtime 角色 `select host_token from projects` 失敗（沿用檔內既有斷言寫法）。先更新 `security-model.md` 第 4 節。
- [ ] **Step 4：請使用者在 Supabase Dashboard 套用 migration**（不能用 CLI，見記憶），貼上檔案內容給使用者。
- [ ] **Step 5：實作**：`PROJECT_COLUMNS` 加 `host`；`createProject` 與 `createVersion` 的 insert 帶 `host: defaultHost()`（`defaultHost` 在 Task 2 定義，這一步先在 `lib/hosts/index.ts` 只放 `defaultHost(): HostName`）。
- [ ] **Step 6：跑測試**，預期 PASS。
- [ ] **Step 7：commit**（使用者同意後）`feat: 專案與代管版本記錄執行環境`

### Task 2：`RuntimeHost` 介面與 Sprite 實作（行為不變的重構）

**Files:**
- Create: `apps/web/lib/hosts/types.ts`、`apps/web/lib/hosts/sprite.ts`、`apps/web/lib/hosts/index.ts`（補齊）
- Modify: `apps/web/lib/env.ts`（`spritesToken` 維持 `required`，只在 Sprite 實作裡取用；新增 `get e2bApiKey() { return required('E2B_API_KEY') }`、`get defaultRuntimeHost()`）
- Test: `apps/web/test/hosts-sprite.test.ts`（把 `sprites.test.ts` 的 `isNotFound`、`errorText`、`retryTransient` 三組搬過來）

**Interfaces:**
- Produces（`lib/hosts/types.ts`）：
```ts
export type HostName = 'sprite' | 'e2b';
export type MachineKind = 'project' | 'mcp';
export type Machine = { host: HostName; name: string; url: string; token: string | null };
export type ServiceSpec = { name: string; cmd: string; args: string[]; httpPort?: number };
export type Liveness = 'running' | 'paused' | 'gone';
export interface RuntimeHost {
  readonly name: HostName;
  /** claim：固定名稱（spriteName／hostedSpriteName）。Sprite 用它當名稱；E2B 寫進 metadata.claim */
  create(claim: string, kind: MachineKind): Promise<Machine>;
  /** name 可以是機器名稱或 claim；已不在算成功；只刪本平台、前綴相符的 */
  destroy(name: string, prefix: 'agenthub-' | 'agenthub-mcp-'): Promise<void>;
  /** 以 runtime 帳號（Sprite: sprite；E2B: user）跑 bash -lc，回傳 stdout；非 0 結束丟錯 */
  exec(m: Machine, script: string): Promise<string>;
  writeFile(m: Machine, path: string, content: string): Promise<void>;
  /** 建立或取代並（重新）啟動 */
  startService(m: Machine, spec: ServiceSpec): Promise<void>;
  hasService(m: Machine, name: string): Promise<boolean>;
  restartService(m: Machine, name: string): Promise<void>;
  serviceLog(m: Machine, name: string, lines: number): Promise<string>;
  /** 延長存活；Sprite 不需要，回 'running' */
  extend(m: Machine, ms: number): Promise<Liveness>;
  status(m: Machine): Promise<Liveness>;
  edgeHeaders(m: Machine): Record<string, string>;
}
```
- Produces（`lib/hosts/index.ts`）：`hostFor(name: HostName): RuntimeHost`、`defaultHost(): HostName`、`projectMachine(p: { host; sprite_name; sprite_url; host_token }): Machine | null`（缺名稱或網址回 null）、`versionMachine(v: HostedVersion): Machine | null`、`loadProjectMachine(db, projectId): Promise<Machine | null>`（明確 select 這四欄）。

- [ ] **Step 1：寫失敗的測試** `hosts-sprite.test.ts`：搬來的三組，加 `it('edgeHeaders 帶 Fly token；extend 回 running 不呼叫 API')`、`it('startService 設定不同時先刪再建，再重啟；兩個 log 串流都讀完')`（由 `sprites.test.ts` 的 `startRuntimeService` 兩個 case 改寫成對 `startService` 斷言）、`it('destroy 拒絕前綴不符的名稱')`。
- [ ] **Step 2：跑**，預期 FAIL（模組不存在）。
- [ ] **Step 3：實作 `lib/hosts/sprite.ts`**：`createSpriteHost(client?: Pick<SpritesClient,...>)`，邏輯從 `lib/sprites.ts`、`lib/hosted-sprite.ts` 移入，不改行為；`status` 用 `getSprite`，404 → `gone`。
- [ ] **Step 4：跑** `pnpm -F @agenthub/web test test/hosts-sprite.test.ts`，預期 PASS；`pnpm typecheck` 通過。
- [ ] **Step 5：commit**（使用者同意後）`refactor: 抽出執行環境介面與 Sprite 實作`

### Task 3：E2B 實作

**Files:**
- Create: `apps/web/lib/hosts/e2b.ts`
- Modify: `apps/web/package.json`（`"e2b": "2.64.0"`）
- Test: `apps/web/test/hosts-e2b.test.ts`（以 `vi.mock('e2b')` 假造 `Sandbox`）

**Interfaces:**
- Consumes: Task 2 的 `RuntimeHost`、`Machine`。
- Produces: `createE2bHost(sdk?: Pick<typeof Sandbox, 'create'|'connect'|'kill'|'setTimeout'|'getInfo'|'list'>): RuntimeHost`；`E2B_TEMPLATES = { project: 'agenthub-runtime', mcp: 'agenthub-mcp' }`；`E2B_TIMEOUT_MS = { project: 300_000, mcp: 900_000 }`；`E2B_SERVICE_SCRIPT`（安裝在 `/usr/local/bin/agenthub-svc`，root 擁有、755）。

服務的做法：`agenthub-svc <名稱> <指令> [參數…]` 以迴圈執行指令，結束後等 2 秒再啟動，輸出附加到 `/var/log/agenthub/<名稱>.log`（每次重啟時只留最後 1000 行），自己的 pid 寫 `/run/agenthub/<名稱>.pid`，參數寫 `/var/lib/agenthub/svc/<名稱>.args`（供重啟）。`startService` 先停掉同名服務（對 pid 檔的程序群組送 TERM），再以 `commands.run('sudo -n setsid agenthub-svc …', { background: true, timeoutMs: 0 })` 啟動；`httpPort` 在 E2B 不用處理（網址固定 8080）。

- [ ] **Step 1：寫失敗的測試**，每個一個 `it`：
  - `create`：以 `E2B_TEMPLATES[kind]` 建立，選項含 `timeoutMs: E2B_TIMEOUT_MS[kind]`、`lifecycle: { onTimeout: 'pause', autoResume: true }`、`network: { allowPublicTraffic: false }`、`metadata: { app: 'agenthub', kind, claim }`；回傳 `{ host: 'e2b', name: sandboxId, url: 'https://' + getHost(8080), token: trafficAccessToken }`。
  - `destroy`：名稱是 sandboxId 且 `metadata.app === 'agenthub'`、`metadata.claim` 以 prefix 開頭 → `kill`；名稱是 claim → `list({ query: { metadata: { app: 'agenthub', claim } } })` 找到的全部 `kill`；**metadata 不符的不 kill**；`getInfo` 丟 NotFound 算成功。
  - `extend`：`setTimeout` 成功 → `'running'`；丟 `SandboxNotFoundError` 且 `getInfo().state === 'paused'` → `'paused'`；`getInfo` 也 NotFound → `'gone'`。
  - `status`：`getInfo` 的 `running`／`paused`／NotFound 對應三種。
  - `edgeHeaders` → `{ 'e2b-traffic-access-token': m.token }`；`token` 為 null 時丟錯。
  - `exec`：`connect(name)` 後 `commands.run(script)` 回 stdout；非 0 結束時錯誤訊息含 stderr。
  - `startService`：先安裝 `agenthub-svc`（只在不存在時），停掉舊的，再以背景、`timeoutMs: 0` 啟動；`serviceLog` 讀 `tail -n <lines>`。
- [ ] **Step 2：跑** `pnpm -F @agenthub/web test test/hosts-e2b.test.ts`，預期 FAIL。
- [ ] **Step 3：實作 `lib/hosts/e2b.ts`**，在 `hostFor('e2b')` 接上。
- [ ] **Step 4：跑測試**，預期 PASS。
- [ ] **Step 5：commit**（使用者同意後）`feat: E2B 執行環境實作`

### Task 4：專案 runtime 經 `RuntimeHost` 佈建與轉送

**Files:**
- Rename: `apps/web/lib/sprites.ts` → `apps/web/lib/project-runtime.ts`；`apps/web/test/sprites.test.ts` → `apps/web/test/project-runtime.test.ts`
- Modify: `apps/web/lib/run-liveness.ts`、`apps/web/lib/services/run-control.ts`、`apps/web/lib/services/threads.ts`、`apps/web/app/api/threads/[id]/chat/route.ts`、`apps/web/app/api/runtime/threads/[id]/continue/route.ts`、`apps/web/app/api/projects/route.ts`、`apps/web/app/api/projects/[id]/route.ts`、`apps/web/app/api/projects/[id]/provision/route.ts`
- Test: `project-runtime.test.ts`、`run-liveness.test.ts`、`run-control.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `hostFor`、`loadProjectMachine`、`Machine`。
- Produces:
  - `sandboxSetupScript(base: string, host: HostName): string`
  - `installRuntime(db: Db, host: RuntimeHost, m: Machine, projectId: string, runtimeObject?: string): Promise<string>`（`.env` 多 `RUNTIME_HOST=<m.host>`）
  - `startRuntimeService(host: RuntimeHost, m: Machine, base: string): Promise<void>`
  - `provisionProject(db: Db, projectId: string, hosts?: (n: HostName) => RuntimeHost): Promise<void>`
  - `destroyProjectMachine(m: Machine | null, projectId: string): Promise<void>`（m 為 null 時用 `spriteName(projectId)` 當 claim）
  - `forwardChat(m: Machine, body, opts)`；`askRuntime(m: Machine, runId, dbToken, fetchImpl?)`；`askStop(m: Machine, …)`
  - `RUNTIME_GONE = 'agent 環境已不存在，請重新建立'`

- [ ] **Step 1：改寫並新增失敗的測試**：
  - `project-runtime.test.ts`：`it('sandboxSetupScript：Sprite 補 languages_env／languages_paths 並以 pyenv 裝 numpy、pandas；E2B 兩者都沒有')`；`it('installRuntime 的 .env 帶 RUNTIME_HOST')`；`it('forwardChat 用 machine 的邊緣標頭：E2B 帶 e2b-traffic-access-token、不帶 Fly token')`；`it('provisionProject：E2B 專案的舊沙盒 gone 時建立新的，並寫回 sprite_name、sprite_url、host_token')`；`it('provisionProject：建立後立刻寫回名稱，之後的步驟失敗時清理找得到')`。
  - `run-control.test.ts`：`it('轉送連不上且沙盒 gone：專案標成 error（RUNTIME_GONE），回 410')`；`it('轉送連不上但沙盒 running：重啟 runtime 服務一次再轉送')`（Review Focus 4）；`it('E2B 專案轉送前先 extend 5 分鐘')`。
  - `run-liveness.test.ts`：既有 case 改傳 `Machine`，加 `it('E2B 專案帶通行證標頭')`。
- [ ] **Step 2：跑**這三個檔，預期 FAIL。
- [ ] **Step 3：實作**。`forwardToRuntime` 改成內部 `loadProjectMachine`，呼叫端只傳 `project.id`；`continue` 路由、`threads.ts` 的 `checkRun`、`stopThreadRun` 改用 `loadProjectMachine`。刪除專案改用 `destroyProjectMachine`。`waitForHealth` 用邊緣標頭。
- [ ] **Step 4：跑** `pnpm -F @agenthub/web test`（全部），預期 PASS；`pnpm typecheck` 通過。
- [ ] **Step 5：commit**（使用者同意後）`feat: 專案 runtime 依執行環境佈建與轉送`

### Task 5：對話中防休眠

**Files:**
- Create: `apps/web/app/api/runtime/keepalive/route.ts`
- Modify: `packages/runtime/src/config.ts`（`RUNTIME_HOST: z.enum(['sprite','e2b']).default('sprite')`）、`packages/runtime/src/keepalive.ts`、`packages/runtime/src/run.ts:232`
- Test: `packages/runtime/test/keepalive.test.ts`、`packages/runtime/test/config.test.ts`、`apps/web/test/run-control.test.ts`（路由）

**Interfaces:**
- Consumes: Task 2 `loadProjectMachine`、`hostFor`；`requireProjectToken`、`bearerToken`（`lib/platform-tokens.ts`）。
- Produces: `startKeepAlive(opts: { host: 'sprite' | 'e2b'; taskName: string; socketPath: string; platformUrl: string; platformToken: string; intervalMs?: number; requestTimeoutMs?: number; fetchImpl?: typeof fetch }): Promise<{ stop(): Promise<void> }>`；`POST /api/runtime/keepalive`（`authorization: Bearer <專案通行證>`）→ E2B 專案 `extend(m, 300_000)`，回 `{ ok: true, state }`；Sprite 專案回 `{ ok: true }` 不做事。

- [ ] **Step 1：寫失敗的測試**：`keepalive.test.ts` 加 `it('e2b：立刻與每 interval 送 POST /api/runtime/keepalive，帶 Bearer 專案通行證；stop 只停計時、不送請求')`、`it('e2b：請求失敗只警告')`；既有 Sprite case 改用新簽章。`config.test.ts`：`RUNTIME_HOST` 預設 `sprite`、拒絕其他值。web 端：`it('keepalive 路由：通行證錯 401；E2B 專案呼叫 extend 5 分鐘；Sprite 專案不呼叫')`。
- [ ] **Step 2：跑**，預期 FAIL。
- [ ] **Step 3：實作**；`run.ts` 以 `config.RUNTIME_HOST`、`config.PLATFORM_URL`、`req.platformToken` 呼叫。
- [ ] **Step 4：跑**（runtime 從 Git Bash：`pnpm -F @agenthub/runtime test`；web：`pnpm -F @agenthub/web test test/run-control.test.ts`），預期 PASS。
- [ ] **Step 5：commit**（使用者同意後）`feat: E2B 上對話中由平台延長沙盒時間`

### Task 6：代管 MCP 經 `RuntimeHost`

**Files:**
- Rename: `apps/web/lib/hosted-sprite.ts` → `apps/web/lib/hosted-runtime.ts`；`apps/web/test/hosted-sprite.test.ts` → `apps/web/test/hosted-runtime.test.ts`
- Modify: `apps/web/lib/services/hosted-mcp.ts`、`apps/web/lib/services/remote-mcp.ts`、`apps/web/app/api/mcp/[instanceId]/[name]/route.ts`、`apps/web/app/api/cron/hosted-cleanup/route.ts`、`apps/web/app/api/templates/[id]/hosted/[mcp]/**/route.ts`、`apps/web/test/helpers.ts`（`fakeSprites` → `fakeHostedOps`）
- Test: `hosted-runtime.test.ts`、`hosted-mcp.test.ts`、`remote-mcp.test.ts`、`hosted-mcp-routes.test.ts`、`hosted-cron.test.ts`

**Interfaces:**
- Consumes: Task 2、3。
- Produces:
```ts
export type HostedOps = {
  provision(version: HostedVersion, env: Record<string, string>, bundleUrl: string): Promise<Machine>;
  readState(m: Machine): Promise<DeployState>;
  startService(m: Machine, start: string): Promise<void>;
  listTools(m: Machine, creatorToken: string): Promise<{ name: string; description?: string }[]>;
  serviceLog(m: Machine): Promise<string>;
  applyEnv(m: Machine, env: Record<string, string>): Promise<void>;
  extend(m: Machine, ms: number): Promise<Liveness>;
  destroy(host: HostName, name: string): Promise<void>;
};
export function createHostedOps(deps?: { hosts?: (n: HostName) => RuntimeHost; fetchImpl?: typeof fetch }): HostedOps;
```
  `RemoteTarget` 的 `edgeToken?: string` 換成 `edge?: Machine`；`forwardToCreator` 的 `opts.edgeToken` 換成 `opts.edgeHeaders?: Record<string, string>`：有 `edgeHeaders` 時不設 `authorization`、改設這些標頭；沒有時維持 `authorization: Bearer <創作者通行證>`。

- [ ] **Step 1：改寫並新增失敗的測試**：
  - `hosted-mcp.test.ts`：`it('第一次同步：以 hostedSpriteName 認領，建立後把 sprite_name 改成機器名稱並存 host_token')`；既有「同時兩次同步只建立一次」「建立失敗保留 sprite_name 供清理」照舊通過；`it('listVersions 不回傳 host_token')`（Review Focus 2）。
  - `hosted-mcp.test.ts` 另加：`it('部署中每次同步對 E2B 版本 extend 15 分鐘')`。
  - `remote-mcp.test.ts`：`it('E2B 代管版本：轉送帶 e2b-traffic-access-token、x-agenthub-token，不帶 authorization')`；`it('閘道轉送前對 E2B 版本 extend 5 分鐘；extend 丟錯仍轉送')`；`it('extend 回 gone：回 503「這個工具服務暫時無法使用」並 console.error 版本 id')`；Sprite 版本既有 case 不變。
  - `hosted-runtime.test.ts`：`it('provision 在 E2B 上：建立時逾時 15 分鐘、以 agenthub-svc 啟動 deploy 服務')`；其餘既有 case 改傳 `Machine`。
- [ ] **Step 2：跑**這五個檔，預期 FAIL。
- [ ] **Step 3：實作**。`syncVersion`、`retireVersion`、`setSecrets`、`cleanupFailed` 改用 `versionMachine`／`ops.destroy(version.host, sprite_name)`；`listVersions` 的回傳去掉 `host_token`。
- [ ] **Step 4：跑** `pnpm -F @agenthub/web test`，預期 PASS；`pnpm typecheck` 通過。
- [ ] **Step 5：commit**（使用者同意後）`feat: 代管 MCP 依執行環境部署與轉送`

### Task 7：E2B 範本

**Files:**
- Create: `apps/web/scripts/e2b-templates.ts`

**Interfaces:**
- Consumes: Task 3 的 `E2B_TEMPLATES`。
- Produces: E2B 帳號裡的範本 `agenthub-runtime`、`agenthub-mcp`。

- [ ] **Step 1：寫腳本**：`Template().fromBaseImage()` 加建置步驟（安裝方式依 E2B 2.64.0 文件），以 `Template.build(t, name, { cpuCount, memoryMB })` 建立；建好後各開一台沙盒，以一般帳號跑工具清單檢查，再刪掉。
- [ ] **Step 2：跑** `cd apps/web && pnpm exec tsx scripts/e2b-templates.ts`，預期輸出兩個範本的檢查全部通過：`node -v` 以 `v22.` 開頭、`python3 -c "import numpy, pandas"` 成功、`go version`、`java -version`、`ruby --version`、`git --version`、`curl --version` 都成功（代管範本只檢查 node 22、python3、pip）。
- [ ] **Step 3：commit**（使用者同意後）`feat: 建立 E2B 執行環境範本的腳本`

### Task 8：驗收、重新部署與營運腳本

**Files:**
- Modify: `apps/web/scripts/probe-sandbox.ts`、`apps/web/scripts/probe-hosted-mcp.ts`、`apps/web/scripts/redeploy-runtime.ts`、`apps/web/scripts/hosted-mcp.ts`、`apps/web/scripts/smoke.ts`、`apps/web/scripts/seed-demo.ts`、`apps/web/scripts/e2e-cloud-folder.ts`、`apps/web/scripts/e2e-orgs.ts`

**Interfaces:**
- Consumes: Task 2–6。
- Produces: `probe-sandbox.ts --host sprite|e2b`、`probe-hosted-mcp.ts --host sprite|e2b`（預設 `e2b`）。

- [ ] **Step 1：改寫兩支 probe**，以 `hostFor(host).create(...)`、`exec` 執行既有檢查項目。E2B 模式另加：`it` 風格的紀錄項目「顧問帳號呼叫 envd 啟動程序被拒（401）」、「顧問帳號無法經 sshd 登入其他帳號（`ssh -o BatchMode=yes` 失敗）」；代管 probe 依 spec §7 改斷言：程式看不到 Fly token、看不到別台通行證。
- [ ] **Step 2：跑** `pnpm exec tsx scripts/probe-sandbox.ts --host e2b` 與 `--host sprite`，預期全部項目 PASS；`probe-hosted-mcp.ts` 兩種也全部 PASS。
- [ ] **Step 3：改寫 `redeploy-runtime.ts`、`hosted-mcp.ts`、`smoke.ts`、`seed-demo.ts`、兩支 e2e** 中寫死 Sprite 的地方，改用 `loadProjectMachine`／`hostFor`；`smoke.ts` 的「刪專案後機器也不在」改用 `status === 'gone'`。
- [ ] **Step 4：跑** `pnpm typecheck` 通過。
- [ ] **Step 5：commit**（使用者同意後）`feat: 驗收與營運腳本支援 E2B`

### Task 9：搬遷

**Files:**
- Create: `apps/web/lib/services/move-host.ts`、`apps/web/scripts/move-host.ts`
- Test: `apps/web/test/move-host.test.ts`

**Interfaces:**
- Consumes: Task 4 `provisionProject` 的步驟（拆出 `bringUpProject(db, host, projectId): Promise<Machine>` 供兩者共用）、Task 6 `createHostedOps`。
- Produces: `moveProject(db: Db, projectId: string, to: HostName, deps?): Promise<'moved' | 'skipped-running' | 'already-there'>`；`moveHostedVersion(db, versionId, to, deps?): Promise<'moved' | 'skipped' | 'already-there'>`；CLI `move-host.ts --to <host> (--project <id> | --version <id> | --all)`。

- [ ] **Step 1：寫失敗的測試**（假的 host）：
  - `it('先把專案標成 provisioning 再檢查 running run；有 running 就改回 ready 並跳過')`（Review Focus 5）
  - `it('新機器健康檢查通過才一次更新 host、sprite_name、sprite_url、host_token 並刪舊機器')`
  - `it('新機器失敗：刪新機器、保留舊機器與原資料列、狀態改回 ready')`
  - `it('代管版本只搬 published、ready；listTools 成功才換列')`
  - `it('已在目標 host：already-there，不動任何東西')`
- [ ] **Step 2：跑**，預期 FAIL。
- [ ] **Step 3：實作**；CLI 逐台執行、印每台結果，最後列出跳過與失敗的，有失敗時 exit 1。`--all` 一次一台（Hobby 同時 10 台）。
- [ ] **Step 4：跑** `pnpm -F @agenthub/web test test/move-host.test.ts`，預期 PASS。
- [ ] **Step 5：commit**（使用者同意後）`feat: 專案與代管 MCP 在執行環境之間搬遷`

### Task 10：文件

**Files:**
- Modify: repo `CLAUDE.md`（架構圖、沙盒段落、部署表、環境變數、「不要碰」補 E2B 測試範本）、`docs/security-model.md`（第 5b 節依 spec §7 改寫；E2B envd／sshd 實測；通行證存放）、`README.md`、`docs/creator/hosted-mcp.md`（若提到 Sprite）

- [ ] **Step 1：更新文件**，內容以 spec §6–§7 為準。
- [ ] **Step 2：檢查** `grep -rn "Sprite" CLAUDE.md docs/security-model.md docs/creator README.md`，剩下的都是在講 Sprite 這一家本身。
- [ ] **Step 3：commit**（使用者同意後）`docs: 執行環境支援 E2B`

### Task 11：上線與搬遷（操作，依 spec §9）

- [ ] **Step 1：** 確認使用者已套用 Task 1 migration。
- [ ] **Step 2：** 請使用者在 Vercel 設 `E2B_API_KEY`（使用者自己貼）與 `DEFAULT_RUNTIME_HOST=sprite`。
- [ ] **Step 3：** 經使用者同意 push `main`，等 Vercel 部署完成；`pnpm -F @agenthub/runtime publish-runtime`；`cd apps/web && pnpm exec tsx scripts/redeploy-runtime.ts`，預期全部專案更新成功。
- [ ] **Step 4：** `pnpm exec tsx scripts/e2b-templates.ts`；兩支 probe `--host e2b` 全部 PASS。
- [ ] **Step 5：** 開一個測試專案、`move-host.ts --to e2b --project <id>`、`BASE_URL=https://agenthub-kappa-pink.vercel.app pnpm exec tsx scripts/smoke.ts` 通過。
- [ ] **Step 6：** `move-host.ts --to e2b --all`，預期每台 `moved`；有跳過（正在對話）的稍後單獨重跑。
- [ ] **Step 7：** 在 Demo 專案「金融科技展 Demo」問一題，三位顧問都回答。
- [ ] **Step 8：** 請使用者把 Vercel `DEFAULT_RUNTIME_HOST` 改 `e2b`（或刪掉，預設即 e2b）並 Redeploy。
- [ ] **Step 9：** 列出 Fly 上 `agenthub-` 開頭的 Sprite，預期 0 台（不碰 `qm-*`）；刪除 E2B 測試範本 `agenthub-eval-8192m`。
- [ ] **Step 10：** 更新記憶 `sprite-replacement-eval.md` 與 `sprite-runtime-facts.md` 的相關段落。

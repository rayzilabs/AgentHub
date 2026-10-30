# 顧問讀圖片、沙盒記憶體上限、run 存活確認 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顧問能直接看共用資料夾裡的圖片（請求只帶簽名網址）；沙盒指令總記憶體上限 6 GB；runtime 掛掉時，前端輪詢在十幾秒內顯示「執行環境中斷」。

**Architecture:** runtime 新增每個 run 一份的 `ImageRegistry`：`read_file` 讀到圖片時向它確認與 Storage 版本相同並取得簽名網址，工具以 `toModelOutput` 把圖片交給模型；`createVertex({ fetch })` 包一層，在請求送往 Vercel 前把 `functionResponse.parts` 裡認得的 inlineData 換成 `fileData`。沙盒包裝腳本在降權前確保 cgroup `agenthub-sandbox`（memory.max 6 GB）並把自己移入。runtime 記錄在跑的 run、新增 `GET /runs/:id`（以資料庫通行證查 runs 驗證身分）；web 的 `getThreadMessages` 對 running 的 run 每 15 秒最多問一次 Sprite。

**Tech Stack:** TypeScript strict、Hono（runtime）、Next.js（web）、Vercel AI SDK 7（`ai`、`@ai-sdk/google-vertex`）、Supabase（Postgres、Storage）、Vitest、Fly Sprites。

**Spec:** `docs/superpowers/specs/2026-10-30-images-memory-liveness-design.md`

## Global Constraints

- 不新增 npm 依賴；雜湊用 `node:crypto` 的 sha256。
- 圖片的位元組與簽名網址不得寫進 messages（ui_message、tool_events）或 log；存進資料庫的只有 `execute` 的輸出（文字說明）。
- 簽名網址時效 3600 秒；只在共用資料夾（`config.SHARED_ROOT`）的圖片、且內容與 Storage `project-files/<專案 id>/<檔名>` 逐位元組相同時才簽。
- 支援的圖片格式以檔頭判斷：png、jpeg、webp、gif；單張上限 20 MB（超過回文字說明、不夾帶）。
- 沙盒 cgroup 名稱 `agenthub-sandbox`，`memory.max` = `6442450944`（6 GiB）；cgroup 設定失敗時沙盒拒絕執行（與既有「蓋不掉 api.sock 就失敗」一致）。
- 存活詢問：每個 run 每 15 秒最多一次、逾時 5 秒；只有 Sprite 明確回 `{ active: false }` 才標中斷，錯誤訊息固定為「執行環境中斷」。
- runtime 測試從 Git Bash 跑（`pnpm -F @agenthub/runtime test`）；web 測試 `pnpm -F @agenthub/web test`；兩者都會連真的 Supabase。
- 直接在 main 開發；runtime 上線要 `publish-runtime` 再 `redeploy-runtime`（會重啟所有 Sprite，執行前確認沒有 running 的 run，並先徵得使用者同意）。

## Review Focus

- 顧問在共用資料夾放一個同名但內容不同的圖片 → `read_file` 不簽網址、回「無法檢視」。（Task 4）
- 超過 20 MB 或不在共用資料夾的圖片 → 回文字說明、不夾帶，請求不會變大。（Task 4）
- 請求裡有認不得的 inlineData（例如未來其他工具回傳圖片）→ 原樣保留，不改寫也不失敗。（Task 5）
- runtime 在被標成中斷之後才收尾 → runtime 寫入的結果蓋過中斷標記；中斷標記只改仍是 running 的列。（Task 2）
- Sprite 連不上、逾時或回非 200 → 視為無法判斷，不標記。（Task 2）

---

### Task 1: runtime 記錄在跑的 run，新增 `GET /runs/:id`

**Files:**
- Create: `packages/runtime/src/active-runs.ts`
- Modify: `packages/runtime/src/run.ts`（`createRun` 之後加入；`finish` 內 `finishRun` 之後移除）
- Modify: `packages/runtime/src/server.ts`（新增路由）
- Test: `packages/runtime/test/server.test.ts`

**Interfaces:**
- Produces: `activeRuns: Set<string>`（模組層，一個程序一份）；`GET /runs/:id`，header `x-agenthub-db-token` → 200 `{ active: boolean }`；沒有通行證、通行證無效或查不到這個 run（RLS 擋掉）→ 401 `{ error }`。驗證方式：`openDb(token).from('runs').select('id').eq('id', id).maybeSingle()` 有資料才回答。

- [ ] **Step 1: 寫失敗測試**（沿用 server.test.ts 的 `seedEnv`、`app`、`post` 與 `hangingModel`）

```ts
it('GET /runs/:id：在跑時 active=true，結束後 active=false', async () => {
  const env = await seedEnv();
  const a = app(env, hangingModel(), 1_000);
  const res = await post(a, { thread_id: env.threadId, text: '問題' });
  const run = await waitFor(async () => (await db.from('runs').select('id').eq('thread_id', env.threadId).maybeSingle()).data);
  const ask = () => a.request(`/runs/${run.id}`, { headers: { 'x-agenthub-db-token': 'db-token' } });
  expect(await (await ask()).json()).toEqual({ active: true });
  await res.text();
  await waitForRunDone(db, env.threadId);
  expect(await (await ask()).json()).toEqual({ active: false });
});

it('GET /runs/:id：沒有通行證或查不到這個 run 回 401', async () => {
  const env = await seedEnv();
  expect((await app(env, mockModel(textTurn('好'))).request(`/runs/${randomUUID()}`)).status).toBe(401);
  expect((await app(env, mockModel(textTurn('好'))).request(`/runs/${randomUUID()}`, { headers: { 'x-agenthub-db-token': 't' } })).status).toBe(401);
});
```

- [ ] **Step 2: 從 Git Bash 跑 `pnpm -F @agenthub/runtime exec vitest run test/server.test.ts -t "runs/:id"`，預期 404／斷言失敗。**
- [ ] **Step 3: 實作 `active-runs.ts`、run.ts 的加入／移除（移除必須在 `finishRun` 寫完之後）、server.ts 路由。**
- [ ] **Step 4: 跑 runtime 全部測試，預期全過。**
- [ ] **Step 5: Commit** — `git add packages/runtime/src/active-runs.ts packages/runtime/src/run.ts packages/runtime/src/server.ts packages/runtime/test/server.test.ts`；`git commit -m "feat(runtime): 記錄在跑的 run，新增 GET /runs/:id 供平台確認存活"`

### Task 2: web 輪詢時問 Sprite，確定死掉就標中斷

**Files:**
- Create: `apps/web/lib/run-liveness.ts`
- Modify: `apps/web/lib/services/threads.ts`（`getThreadMessages` 的 running 分支）
- Test: `apps/web/test/run-liveness.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GET /runs/:id`；既有 `runtimeAccessToken(db, projectId)`（`lib/runtime-session.ts`）。
- Produces:
  - `askRuntime(spriteUrl: string, runId: string, dbToken: string, fetchImpl?: typeof fetch): Promise<'active' | 'gone' | 'unknown'>`：逾時 5 秒；200 `{active:true}`→active、200 `{active:false}`→gone，其他（逾時、連線錯誤、非 200、格式不對）→unknown。
  - `markRunInterrupted(db: Db, runId: string): Promise<boolean>`：`update runs set status='failed', error='執行環境中斷', finished_at=now() where id=? and status='running'`，回傳是否有改到。
  - `shouldAsk(runId: string, now?: number): boolean`：同一個 run 15 秒內只回 true 一次（模組層 Map；Vercel 多個實例各自節流可接受）。
  - `getThreadMessages`：running 且 `shouldAsk` 時呼叫 `askRuntime`；`gone` → `markRunInterrupted` 後回 `{ running: false, error: '執行環境中斷' }`；其他照舊。

- [ ] **Step 1: 寫失敗測試**（假的 Sprite 用 `node:http`，同 model-proxy.test.ts 寫法）

```ts
it('askRuntime：依 Sprite 回答分成 active / gone / unknown', async () => {
  // 假伺服器：/runs/a → {active:true}；/runs/g → {active:false}；/runs/e → 500；/runs/slow → 6 秒才回
  expect(await askRuntime(base, 'a', 't')).toBe('active');
  expect(await askRuntime(base, 'g', 't')).toBe('gone');
  expect(await askRuntime(base, 'e', 't')).toBe('unknown');
  expect(await askRuntime(base, 'slow', 't')).toBe('unknown');
  expect(await askRuntime('http://127.0.0.1:1', 'a', 't')).toBe('unknown');
  expect(seen.at(0)?.headers['x-agenthub-db-token']).toBe('t');
});

it('markRunInterrupted 只改仍是 running 的 run', async () => {
  // seed 一個 running run 與一個 succeeded run（真的 Supabase，同既有 web 測試的 seed 方式）
  expect(await markRunInterrupted(db, runningId)).toBe(true);
  expect(await markRunInterrupted(db, succeededId)).toBe(false);
  // runningId 現在 status=failed、error='執行環境中斷'；succeededId 不變
});

it('shouldAsk：同一個 run 15 秒內只問一次', () => {
  expect(shouldAsk('r', 0)).toBe(true);
  expect(shouldAsk('r', 14_999)).toBe(false);
  expect(shouldAsk('r', 15_000)).toBe(true);
});
```

- [ ] **Step 2: `pnpm -F @agenthub/web exec vitest run test/run-liveness.test.ts`，預期 import 失敗。**
- [ ] **Step 3: 實作 `run-liveness.ts` 並接進 `getThreadMessages`（專案的 `sprite_url` 由 `getOwnThread` 取得；沒有 `sprite_url` 時不問）。**
- [ ] **Step 4: web 全部測試＋`pnpm typecheck`，預期全過。**
- [ ] **Step 5: Commit** — `git add apps/web/lib/run-liveness.ts apps/web/lib/services/threads.ts apps/web/test/run-liveness.test.ts`；`git commit -m "feat(web): 輪詢時直接問 runtime，run 確定中斷就標成失敗"`

### Task 3: 沙盒 cgroup 記憶體上限與 OOM 訊息

**Files:**
- Modify: `apps/web/lib/sprites.ts`（`SANDBOX_WRAPPER_SCRIPT`：`exec setpriv` 之前）
- Modify: `packages/runtime/src/sandbox.ts`（`runInSandbox` 回傳加 `signal`）
- Modify: `packages/runtime/src/tools/bash.ts`（被 SIGKILL 時的訊息）
- Modify: `apps/web/scripts/probe-sandbox.ts`（新增記憶體項目）
- Test: `apps/web/test/sprites.test.ts`（或既有測試 SANDBOX 腳本的檔案）、`packages/runtime/test/tools.test.ts`

**Interfaces:**
- Produces: 包裝腳本以 root 依序執行（失敗即 `exit`）：
  ```sh
  cg=/sys/fs/cgroup/agenthub-sandbox
  /usr/bin/mkdir -p "$cg"
  /usr/bin/grep -qw memory /sys/fs/cgroup/cgroup.subtree_control || echo +memory > /sys/fs/cgroup/cgroup.subtree_control
  [ "$(cat "$cg/memory.max")" = 6442450944 ] || echo 6442450944 > "$cg/memory.max"
  echo $$ > "$cg/cgroup.procs"
  ```
  `runInSandbox` 回傳 `{ code, signal, stdout, stderr }`（`signal: NodeJS.Signals | null`）。bash 工具在 `signal === 'SIGKILL'` 時輸出附加「指令被終止：可能是沙盒記憶體超過 6 GB 上限。請改用較省記憶體的做法（例如不要安裝或載入大型模型）。」

- [ ] **Step 1: 寫失敗測試** — web：`SANDBOX_WRAPPER_SCRIPT` 含 `agenthub-sandbox`、`6442450944`、`cgroup.procs`，且這幾行在 `exec /usr/bin/setpriv` 之前；runtime：假 sandbox 的 child 以 `close(null, 'SIGKILL')` 結束時，bash 工具輸出含「記憶體超過 6 GB 上限」，一般非 0 結束不含。
- [ ] **Step 2: 兩邊測試確認失敗。**
- [ ] **Step 3: 實作三處修改。**
- [ ] **Step 4: 兩邊全部測試＋typecheck 全過。**
- [ ] **Step 5: `probe-sandbox.ts` 新增兩項**：沙盒內 `cat /proc/self/cgroup` 為 `0::/agenthub-sandbox`；沙盒內執行配置 7 GB 的 Python（`python3 -c "b=bytearray(7*1024**3)"`）被 SIGKILL，且之後 runtime `/health` 仍回 200。
- [ ] **Step 6: Commit** — `git add apps/web/lib/sprites.ts apps/web/test/sprites.test.ts apps/web/scripts/probe-sandbox.ts packages/runtime/src/sandbox.ts packages/runtime/src/tools/bash.ts packages/runtime/test/tools.test.ts`；`git commit -m "feat: 沙盒指令總記憶體上限 6 GB，超過時告訴顧問原因"`

### Task 4: `read_file` 讀圖片與 `ImageRegistry`

**Files:**
- Create: `packages/runtime/src/images.ts`
- Modify: `packages/runtime/src/tools/files.ts`（`readFileTool` 多一個可選參數）
- Test: `packages/runtime/test/images.test.ts`

**Interfaces:**
- Produces:
  - `detectImage(head: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null`（檔頭判斷）
  - `type ImageRegistry = { resolve(name: string, bytes: Uint8Array): Promise<string | null>; urlFor(sha256: string): string | undefined; take(toolCallId: string): { mediaType: string; bytes: Uint8Array } | undefined; keep(toolCallId: string, image: { mediaType: string; bytes: Uint8Array }): void }`
  - `createImageRegistry(db: Db, projectId: string): ImageRegistry`：`resolve` 下載 `project-files/<projectId>/<name>`，sha256 相同才 `createSignedUrl(…, 3600)`，記下 sha256→網址並回傳；不同或下載失敗回 null。
  - `readFileTool(cwd: string, sandbox: Sandbox, images?: ImageRegistry)`：檔頭是圖片時——不在 `SHARED_ROOT` 下、超過 20 MB、`images` 未提供、或 `resolve` 回 null → 回 `{ content: '這張圖不在共用資料夾（或與上傳的版本不同），無法檢視：<檔名>' }`；否則 `keep` 位元組、回 `{ content: '圖片：<檔名>（<格式>，<位元組數> bytes）' }`，並以 `toModelOutput` 回傳 `[{ type:'text', text }, { type:'file', mediaType, data:{ type:'data', data: bytes } }]`（位元組由 `take(toolCallId)` 取得）。非圖片維持原行為。讀位元組經沙盒、以 `base64 -w0` 取出。文字說明用位元組數而非 spec 寫的「尺寸」：解析 JPEG 尺寸要另寫解析器，模型看圖時本來就看得到尺寸。（計畫的決定，偏離 spec 一個細節）

- [ ] **Step 1: 寫失敗測試**

```ts
it('detectImage 依檔頭判斷格式', () => {
  expect(detectImage(PNG_HEAD)).toBe('image/png');
  expect(detectImage(JPEG_HEAD)).toBe('image/jpeg');
  expect(detectImage(new TextEncoder().encode('hello'))).toBeNull();
});
it('resolve：與 Storage 相同才回簽名網址，內容不同回 null', async () => {
  // 上傳 a.png 到 project-files/<專案>/a.png（測試 Supabase），同內容 → 網址含 /object/sign/project-files/；改一個位元組 → null
});
it('read_file 讀到共用資料夾的圖片：execute 輸出只有文字，toModelOutput 含圖片', async () => {
  // execute 結果不含任何位元組或網址；toModelOutput 的 file part mediaType 為 image/png
});
it('同名但內容被換掉的圖片：回無法檢視', async () => {});
it('工作目錄裡的圖片（不在共用資料夾）：回無法檢視', async () => {});
it('超過 20 MB 的圖片：回無法檢視，不讀進記憶體', async () => {});
```

- [ ] **Step 2: Git Bash 跑 `vitest run test/images.test.ts`，預期失敗。**
- [ ] **Step 3: 實作 `images.ts` 與 `readFileTool` 修改。**
- [ ] **Step 4: runtime 全部測試＋typecheck 全過（既有不帶 `images` 的呼叫行為不變）。**
- [ ] **Step 5: Commit** — `git add packages/runtime/src/images.ts packages/runtime/src/tools/files.ts packages/runtime/test/images.test.ts`；`git commit -m "feat(runtime): read_file 讀共用資料夾的圖片交給模型，與上傳版本相同才簽網址"`

### Task 5: 請求改寫與串接

**Files:**
- Create: `packages/runtime/src/image-rewrite.ts`
- Modify: `packages/runtime/src/main.ts`（`modelFor` 傳入 `fetch`）
- Modify: `packages/runtime/src/run.ts`、`src/agents/build.ts`、`src/consultant.ts`（每個 run 建一份 registry，傳給模型與各顧問／主管的 `readFileTool`）
- Modify: `docs/security-model.md`（runtime 會為共用資料夾的圖片產生 1 小時簽名網址，只送往 Vertex）
- Test: `packages/runtime/test/image-rewrite.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ImageRegistry.urlFor`。
- Produces:
  - `rewriteImageParts(body: string, urlFor: (sha256: string) => string | undefined): string`：只動 `contents[].parts[].functionResponse.parts[].inlineData`；base64 解碼後算 sha256，有網址就換成 `{ fileData: { mimeType, fileUri } }`，沒有就原樣；不是 JSON 原樣回傳。
  - `imageFetch(urlFor, base?: typeof fetch): typeof fetch`：POST 且 body 為字串時先 `rewriteImageParts`。
  - `RunDeps.modelFor` 改為 `(platformToken: string | undefined, images?: ImageRegistry) => LanguageModel`；`main.ts` 以 `createVertex({ apiKey, baseURL, fetch: images ? imageFetch(images.urlFor) : undefined })`。

- [ ] **Step 1: 寫失敗測試**

```ts
it('認得的 inlineData 換成 fileData，其餘原樣', () => {
  const body = JSON.stringify({ contents: [
    { role: 'user', parts: [{ text: '問題' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: {}, parts: [
      { inlineData: { mimeType: 'image/png', data: KNOWN_B64 } },
      { inlineData: { mimeType: 'image/png', data: OTHER_B64 } },
    ] } }] },
  ] });
  const out = JSON.parse(rewriteImageParts(body, (h) => (h === sha256(KNOWN_B64) ? 'https://s/x' : undefined)));
  const parts = out.contents[1].parts[0].functionResponse.parts;
  expect(parts[0]).toEqual({ fileData: { mimeType: 'image/png', fileUri: 'https://s/x' } });
  expect(parts[1].inlineData.data).toBe(OTHER_B64);
  expect(out.contents[0].parts[0].text).toBe('問題');
});
it('不是 JSON 原樣回傳', () => expect(rewriteImageParts('xx', () => 'u')).toBe('xx'));
it('串接：顧問 read_file 讀圖後，送出的請求體裡是 fileData 網址、沒有 base64', async () => {
  // 用 mockModel＋toolTurn('read_file', {path: '<SHARED_ROOT>/a.png'})，攔截 imageFetch 收到的 body
});
```

- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 實作並串接；更新 security-model.md。**
- [ ] **Step 4: runtime 全部測試＋typecheck 全過。**
- [ ] **Step 5: Commit** — `git add packages/runtime/src/image-rewrite.ts packages/runtime/src/main.ts packages/runtime/src/run.ts packages/runtime/src/agents/build.ts packages/runtime/src/consultant.ts packages/runtime/test/image-rewrite.test.ts docs/security-model.md`；`git commit -m "feat(runtime): 模型請求送出前把共用資料夾的圖片換成簽名網址"`

### Task 6: 上線與真實 Sprite 驗收

**Files:** 無新增程式（驗收腳本放 scratchpad，不進 repo）。

- [ ] **Step 1: push main**（web 自動部署；push 前跑 web＋runtime 全部測試，測試與 push 分成兩個指令）。
- [ ] **Step 2: 徵得使用者同意後** `pnpm -F @agenthub/runtime publish-runtime`，確認沒有 running 的 run，再 `cd apps/web && pnpm exec tsx scripts/redeploy-runtime.ts`（同時套用新的包裝腳本）。
- [ ] **Step 3: `pnpm exec tsx scripts/probe-sandbox.ts` 全過**（含 Task 3 的兩個記憶體項目）。
- [ ] **Step 4: 圖片端到端**（臨時帳號開專案、上傳 ≥2 MB 的手機截圖、租用 ETF 或投組顧問、請它描述截圖內容）：回答正確；`messages` 的 ui_message 與 tool_events 搜不到 base64 與 `/object/sign/`；若 Vertex 抓不到 Supabase 簽名網址，停下來回報。
- [ ] **Step 5: 存活端到端**：執行中用 Sprites API 砍掉 runtime 程序，30 秒內輪詢 API 回 `error: '執行環境中斷'`；另一個正常跑超過 10 分鐘的 run（例如讓顧問 `sleep` 分段執行）不被標中斷。
- [ ] **Step 6: 清理臨時帳號、專案與 Sprite，把實測結果寫進本計畫結尾。**

## 實測

（Task 6 完成後填寫。）

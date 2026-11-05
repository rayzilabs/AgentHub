# 執行中停止與訊息排隊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者可以中斷執行中的 run 並由下一則訊息接手，也可以在執行中排隊訊息，由 agent 在下一步讀到。

**Architecture:** 停止走「平台 → runtime 新路由 → run 內的 AbortController」，排隊訊息存在 `queued_messages`，由根 agent 的 `prepareStep` 取走。這輪正常結束後還有排隊訊息時，runtime 請平台重新簽發通行證、開下一輪。

**Tech Stack:** TypeScript、Next.js、Hono、Vercel AI SDK 7.0.126、Supabase、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-05-run-stop-and-queue-design.md`

## Global Constraints

- 測試連 `.env` 裡真的 Supabase，所以 Task 1 的 migration 要先由使用者貼到 SQL Editor，後面的測試才跑得起來。
- runtime 測試從 Git Bash 跑（PowerShell 的 `bash` 會解析到 WSL）。
- 改 `packages/runtime` 用 `cd packages/runtime && pnpm exec vitest run <檔案>`，改 `apps/web` 用 `cd apps/web && pnpm exec vitest run <檔案>`。
- 工作目錄已有不相關的未提交變更（`README.md`、`file-browser.tsx`、`file-tree.ts`、`file-tree.test.ts`），不要動。
- stage 一律指定路徑，不用 `git add .`。commit 格式 `<type>: <功能描述>`，不加 attribution。push 前要過 `superpowers:finishing-a-development-branch`。
- 固定值：寬限 `STOP_GRACE_MS = 10_000`；輪詢等下一輪 `QUEUE_WAIT_MS = 30_000`；排隊訊息以 `\n\n` 合併。
- 固定文案：`已由你中斷`、`已中斷`、`停止中…`、`再傳一則訊息，會排隊`、`這則訊息已被讀取`、`暫時無法停止，請再試一次`。

## Review Focus

1. 連按兩次停止，或另一個分頁同時停止：第二次不報錯，也不會影響下一輪（Task 3、Task 6）。
2. 停止和取走排隊訊息同時發生：訊息只會落在「已讀」或「回到輸入框」其中一邊（Task 2、Task 7）。
3. run 還在準備階段（同步檔案、裝套件）就按停止：不開始串流，畫面有「已由你中斷」（Task 3）。
4. 排隊或停止途中重新整理頁面：排隊區和中斷標記都從伺服器讀回來（Task 3、Task 6）。
5. 排隊內容只有空白：回 400，不寫入（Task 6）。

---

### Task 1: Migration 與型別

**Files:**
- Create: `supabase/migrations/20261105000001_run_stop_and_queue.sql`
- Modify: `packages/runtime/src/types.ts`
- Test: `packages/runtime/test/runtime-access.test.ts`

**Interfaces:**
- Produces: `MessageKind` 包含 `'interjection'`；表 `queued_messages(id, thread_id, text, created_at)`；`runs.status` 可為 `'cancelled'`；runtime 帳號可讀 `messages.speaker_instance_id`。

- [ ] **Step 1: 寫 migration**

內容：放寬 `runs_status_check`、`messages_kind_check`（先查實際 constraint 名稱）；`grant select (speaker_instance_id) on public.messages to authenticated`；建 `queued_messages`，`thread_id` references `threads` on delete cascade，索引 `(thread_id, created_at)`，開 RLS；`grant select (id, thread_id, text, created_at), delete` 給 `authenticated`，政策比照 `20261014000002_runtime_scoped_access.sql` 用 `runtime_project()` 限定專案。`create` 要能重跑（`if not exists`）。

- [ ] **Step 2: 請使用者貼到 Supabase SQL Editor 套用，等回覆後才繼續**

- [ ] **Step 3: 在 `runtime-access.test.ts` 寫測試**

```ts
it('runtime 帳號只能讀取和刪除自己專案的排隊訊息', async () => {
  // 兩個專案各插一列（service role）
  // 用 A 專案的 runtimeDb：select 只看到 A 的；delete B 的影響 0 列；insert 被拒
});
```

- [ ] **Step 4: 跑 `pnpm exec vitest run test/runtime-access.test.ts`，預期 PASS**

- [ ] **Step 5: `MessageKind` 加 `'interjection'`，commit**

```bash
git add supabase/migrations/20261105000001_run_stop_and_queue.sql packages/runtime/src/types.ts packages/runtime/test/runtime-access.test.ts
git commit -m "feat: 新增 run 中斷狀態與訊息排隊資料表"
```

### Task 2: 排隊存取與下一輪歷史

**Files:**
- Modify: `packages/runtime/src/run-store.ts`
- Test: `packages/runtime/test/run-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的表與欄位。
- Produces:
  - `type QueuedMessage = { id: string; text: string }`
  - `takeQueued(db: Db, threadId: string): Promise<QueuedMessage[]>`：`delete().select()`，依 `created_at` 由舊到新。
  - `hasQueued(db: Db, threadId: string): Promise<boolean>`
  - `RunResult` 加 `{ status: 'cancelled' }`，`finishRun` 的 error 寫 null。
  - `INTERRUPTED_HEADER = '（這一輪被使用者中斷，以下是中斷當時的進度）'`
  - `loadHistory` 簽名不變。

- [ ] **Step 1: 寫失敗測試**

```ts
it('takeQueued 依時間回傳，第二次取不到', ...);          // ['a','b'] → []
it('同時取走時每則只給一方', ...);                      // Promise.all 兩次，合計 2 則不重複
it('interjection 排在同 run 的 final 之前', ...);        // user, interjection, assistant
it('一般完成的 run 不帶 delegation', ...);              // 內容不含報告
it('cancelled 的 run 帶入報告並標明顧問', ...);          // assistant 含 INTERRUPTED_HEADER、【顧問名】、報告文字
it('cancelled 的 run 沒有 final 文字也帶入報告', ...);
it('報告列不佔 50 則的歷史上限', ...);
```

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

`loadHistory` 流程：查 `user`、`final`、`interjection`（維持 limit）；取出 run_id 查 `runs.status`；對 `cancelled` 的 run 另查 `delegation`、`discussion`（不受 limit 影響）和 `agent_instances.name`。同一 run 內的 `interjection` 移到 `final` 前。`cancelled` 的 `final` 改寫成：`INTERRUPTED_HEADER`、`final` 文字、每位顧問 `【名稱】\n內容`，以 `\n\n` 連接。沒有 `final` 列時在該輪最後補一則。

- [ ] **Step 4: 跑測試確認通過，commit**

```bash
git add packages/runtime/src/run-store.ts packages/runtime/test/run-store.test.ts
git commit -m "feat: 下一輪上下文帶入插話與中斷前的顧問報告"
```

### Task 3: runtime 停止

**Files:**
- Modify: `packages/runtime/src/active-runs.ts`、`packages/runtime/src/run.ts`、`packages/runtime/src/server.ts`、`packages/runtime/src/errors.ts`、`packages/runtime/src/ui-stream.ts`
- Test: `packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `RunResult`。
- Produces:
  - `activeRuns: Map<string, () => void>`，值是這輪的停止函式。
  - `USER_STOP = 'user-stop'`、`isUserStop(signal?: AbortSignal): boolean`（`errors.ts`）。
  - `interruptedMessage(m: UIMessage | undefined): UIMessage`（`ui-stream.ts`）：補上 `{ type: 'data-interrupted', data: {} }`，沒有訊息就新建 assistant 訊息。
  - `POST /runs/:id/stop` 回 `{ stopped: boolean }`，驗證與 `GET /runs/:id` 相同（抽共用函式）。
  - `RunDeps` 加 `stopGraceMs?: number`，預設 `STOP_GRACE_MS`。

- [ ] **Step 1: 寫失敗測試（`describe('POST /runs/:id/stop')`）**

```ts
it('停止執行中的 run：status=cancelled、error 為 null、保留已產生文字、有 data-interrupted', ...);
it('沒有任何內容時也留下 final 與中斷標記', ...);
it('模型不理會中止：寬限時間後強制收尾', ...);   // hangingModel + stopGraceMs: 50
it('重複停止或 run 已結束：回 stopped=false，不報錯', ...);
it('準備階段就停止：不呼叫模型，run 為 cancelled，有中斷標記', ...);
it('逾時仍是 failed，錯誤訊息不變', ...);        // 現有測試維持通過
it('沒有通行證回 401', ...);
```

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

- `startRun` 加 `stopped` 旗標，註冊 `activeRuns.set(runId, requestStop)`；`requestStop` 設旗標、`abort.abort(USER_STOP)`，並 resolve 寬限計時。
- `settle` 用 `latest` 記最後快照，race 加入寬限 promise。`stopped` 為真時一律 `stop()`、`saveFinal(interruptedMessage(final ?? latest))`、回 `{ status: 'cancelled' }`，不走 `dropFinal`。`timedOut` 改看計時器旗標。
- `prepareRootAgent` 之後檢查 `stopped`：插入帶中斷標記的 `final`，`finish`，回空串流的 `createUIMessageStreamResponse`。`closeAgent` 要先設好。

- [ ] **Step 4: 跑 `pnpm exec vitest run test/server.test.ts`，確認通過，commit**

```bash
git add packages/runtime/src/active-runs.ts packages/runtime/src/run.ts packages/runtime/src/server.ts packages/runtime/src/errors.ts packages/runtime/src/ui-stream.ts packages/runtime/test/server.test.ts
git commit -m "feat: runtime 支援使用者中斷 run"
```

### Task 4: 顧問中斷紀錄

**Files:**
- Modify: `packages/runtime/src/tools/delegate.ts`、`packages/runtime/src/tools/discuss.ts`、`packages/runtime/src/consultant.ts`、`packages/runtime/src/run.ts`
- Test: `packages/runtime/test/delegate.test.ts`、`packages/runtime/test/discuss.test.ts`、`packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: `isUserStop`。
- Produces:
  - `partialSummary(name: string, tools: ToolEvent[], text: string, reason: string): string`；`stoppedSummary` 用它，`reason = '逾時'`。中斷用 `reason = '被使用者中斷'`。
  - `RecordSpeech` 加第四參數 `summary?: string`，`record` 寫 `content: summary ?? textOf(message)`。
  - `cutoff` 加 `'interrupted'`。中斷時 `DelegationOutput` 為 `status: 'failed', cutoff: 'interrupted'`，不帶 `error`；`Speech` 相同。

- [ ] **Step 1: 寫失敗測試**

```ts
// delegate.test.ts
it('使用者中斷：cutoff=interrupted、沒有 error，record 收到含已完成步驟的摘要', ...);
it('逾時中止不算中斷：沿用現有結果', ...);  // abort reason 不是 USER_STOP
// discuss.test.ts
it('使用者中斷：發言標 interrupted，摘要寫進紀錄', ...);
// server.test.ts
it('多顧問：主管等顧問時停止，delegation 列留下進度，下一輪 prompt 看得到', ...);
```

最後一個測試要用真的 `startRun`，證明中止時 `save()` 有跑（spec 第 9 節的風險）。

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

`catch` 內先判斷 `isUserStop(abortSignal)`。如果 Step 1 的 server 測試顯示 generator 沒走到 `catch`，改在 `abortSignal` 的 `abort` 事件呼叫一次 `save()`，並用旗標避免重複寫入。

- [ ] **Step 4: 跑三個測試檔確認通過，commit**

```bash
git add packages/runtime/src/tools/delegate.ts packages/runtime/src/tools/discuss.ts packages/runtime/src/consultant.ts packages/runtime/src/run.ts packages/runtime/test/delegate.test.ts packages/runtime/test/discuss.test.ts packages/runtime/test/server.test.ts
git commit -m "feat: 使用者中斷時保留顧問進度摘要"
```

### Task 5: 把排隊訊息送進步驟

**Files:**
- Create: `packages/runtime/src/inbox.ts`
- Modify: `packages/runtime/src/agents/build.ts`、`packages/runtime/src/run.ts`
- Test: `packages/runtime/test/inbox.test.ts`、`packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: `takeQueued`、`insertMessage`。
- Produces:

```ts
export type Inbox = {
  /** 取走排隊訊息、寫 interjection 列，回傳要放進下一步的訊息。失敗只記 log，回 [] */
  take(): Promise<ModelMessage[]>;
  /** 把取走的訊息以 data-interjection 插在下一個 start-step 之前 */
  pipe(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk>;
};
export function createInbox(opts: { db: Db; threadId: string; runId: string }): Inbox;
```

`ConsultantContext`、`ManagerContext` 加 `inbox?: Inbox`。只有 `prepareRootAgent` 傳入，`createConsultantRunner` 不傳。模型看到的內容是 `使用者在你工作途中補充：\n<文字>`，`interjection` 列存原文。chunk 是 `{ type: 'data-interjection', id, data: { id, text } }`。

- [ ] **Step 1: 寫失敗測試**

```ts
// inbox.test.ts
it('take 寫入 interjection 列並回傳 user 訊息', ...);
it('take 失敗時回 [] 不丟錯', ...);
it('pipe 把訊息插在下一個 start-step 之前', ...);
// server.test.ts
it('第二步之前排隊的訊息，出現在第二步與第三步的 prompt', ...);  // toolTurn、toolTurn、textTurn；promptText(model, 1/2)
it('收尾階段仍讀得到排隊訊息', ...);
it('多顧問：顧問看不到排隊訊息，主管下一步才看到', ...);
it('final 的 ui_message 有 data-interjection，位置在第一步工具之後', ...);
```

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

新增 `withInbox(prepare, inbox)`，包住 `wrapUpStep`：`const extra = await inbox.take()`，有訊息就回 `{ ...base, messages: [...opts.messages, ...extra] }`。覆寫會延續到後續步驟，不要重放。`wrapAgent` 收 `inbox`，在 `withToolTimes` 外層 `inbox.pipe`。

- [ ] **Step 4: 跑測試確認通過，commit**

```bash
git add packages/runtime/src/inbox.ts packages/runtime/src/agents/build.ts packages/runtime/src/run.ts packages/runtime/test/inbox.test.ts packages/runtime/test/server.test.ts
git commit -m "feat: agent 在每一步之間讀取排隊訊息"
```

### Task 6: 平台 API

**Files:**
- Create: `apps/web/lib/services/run-control.ts`、`apps/web/app/api/threads/[id]/stop/route.ts`、`apps/web/app/api/threads/[id]/queue/route.ts`、`apps/web/app/api/threads/[id]/queue/[queuedId]/route.ts`、`apps/web/app/api/runtime/threads/[id]/continue/route.ts`
- Modify: `apps/web/lib/run-liveness.ts`、`apps/web/lib/services/threads.ts`、`apps/web/lib/sprites.ts`、`apps/web/lib/agent-output.ts`
- Test: `apps/web/test/run-control.test.ts`、`apps/web/test/threads.test.ts`

**Interfaces:**
- Consumes: runtime 的 `POST /runs/:id/stop`、Task 7 的無 `text` `/chat`（這裡先以假 `forward` 測試）。
- Produces:
  - `askStop(spriteUrl, runId, dbToken, fetchImpl?): Promise<'stopped' | 'gone' | 'unknown'>`，`stopped: true` → `stopped`，`false` → `gone`，其他 → `unknown`。
  - `QueuedView = { id: string; text: string }`、`RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'`，都從 `lib/services/threads.ts` 匯出，`lib/queue.ts` 只用 `import type`。
  - `stopThreadRun(db, userId, threadId, ask = askStop): Promise<void>`：沒有 running run 就直接回；`gone` 走 `markRunInterrupted`；`unknown` 丟 `HttpError(502, '暫時無法停止，請再試一次')`。
  - `addQueued(db, userId, threadId, text, forward?): Promise<QueuedView>`：寫入後再呼叫 `startQueuedRun`。
  - `editQueued(db, userId, threadId, id, text)`、`deleteQueued(db, userId, threadId, id)`：影響 0 列丟 `HttpError(409, '這則訊息已被讀取')`。
  - `startQueuedRun(db, project, threadId, forward = forwardChat): Promise<void>`：沒有 running run 且有排隊才簽通行證、呼叫 `forward`，回 409 或 204 都視為正常，有 body 就 cancel。
  - `ThreadMessages` 加 `queued: QueuedView[]` 與 `runStatus: RunStatus | null`。
  - `forwardChat` 的 body 改 `{ thread_id: string; text?: string }`。
  - `Cutoff` 加 `'interrupted'`。
  - 路由：`POST /api/threads/:id/stop`、`POST /api/threads/:id/queue`（`{ text }`，zod `trim().min(1, '請輸入訊息')`）、`PATCH`／`DELETE /api/threads/:id/queue/:queuedId`、`POST /api/runtime/threads/:id/continue`（Bearer 專案通行證，對話不屬於該專案回 404）。

- [ ] **Step 1: 寫失敗測試**

```ts
it('askStop：依回答分成 stopped / gone / unknown，帶資料庫通行證與 Fly 驗證', ...);
it('stopThreadRun：沒有 running run 時不呼叫 runtime', ...);
it('stopThreadRun：runtime 回 gone 時標成中斷', ...);
it('stopThreadRun：連不上時回 502，run 維持 running', ...);
it('addQueued：沒有 running run 時觸發 forward，不帶 text', ...);
it('addQueued：有 running run 時不觸發 forward', ...);
it('空白內容回 400，不寫入', ...);
it('editQueued、deleteQueued：已被取走回 409', ...);
it('別人的對話回 404', ...);
it('continue：通行證的專案與對話不符回 404', ...);
it('startQueuedRun：forward 回 409 時不丟錯，排隊列保留', ...);
it('getThreadMessages 回傳 queued 與 runStatus，cancelled 不帶 error', ...);
```

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

路由比照 `chat/route.ts` 和 `mcp/[instanceId]/[name]/route.ts` 的驗證寫法。`getThreadMessages` 的每個回傳路徑都要帶新欄位。`Promise.all` 多查一次 `queued_messages`，依 `created_at` 排序。

- [ ] **Step 4: 跑 `pnpm exec vitest run test/run-control.test.ts test/threads.test.ts`，確認通過，commit**

指定上面列出的檔案逐一 stage，commit message：`feat: 平台新增停止與排隊 API`。

### Task 7: 無 `text` 的 `/chat` 與自動下一輪

**Files:**
- Modify: `packages/runtime/src/server.ts`、`packages/runtime/src/run.ts`
- Test: `packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: `takeQueued`、`hasQueued`、`POST /api/runtime/threads/:id/continue`。
- Produces: `startRun` 的 `req.text` 改為可選；`RunDeps` 加 `fetchImpl?: typeof fetch`。

- [ ] **Step 1: 寫失敗測試**

```ts
it('沒有 text：取走全部排隊訊息，以空行合併成這輪的使用者訊息', ...);
it('沒有 text 也沒有排隊：回 204，run 為 succeeded，不插入訊息', ...);
it('已有 run 在跑：回 409，排隊訊息保留', ...);
it('正常結束且有排隊：呼叫 continue，帶專案通行證', ...);
it('停止或失敗結束：不呼叫 continue，排隊訊息保留', ...);
it('continue 呼叫失敗只記 log，run 仍是 succeeded', ...);
```

- [ ] **Step 2: 跑測試確認失敗**

- [ ] **Step 3: 實作**

`createRun` 成功後才 `takeQueued`。在現有收尾 IIFE 的 `finish(result)` 之後，`result.status === 'succeeded'` 且 `hasQueued` 才呼叫 continue，全部包 try/catch。

- [ ] **Step 4: 跑測試確認通過，commit**

```bash
git add packages/runtime/src/server.ts packages/runtime/src/run.ts packages/runtime/test/server.test.ts
git commit -m "feat: 這輪結束後由平台接續排隊訊息"
```

### Task 8: 前端

**Files:**
- Create: `apps/web/lib/queue.ts`、`apps/web/components/workspace/queued-messages.tsx`
- Modify: `apps/web/components/workspace/chat.tsx`、`apps/web/components/workspace/message-view.tsx`、`apps/web/components/workspace/delegation-card.tsx`、`apps/web/components/workspace/discussion-view.tsx`
- Test: `apps/web/test/queue.test.ts`

**Interfaces:**
- Consumes: Task 6 的 API、`queued`、`runStatus`、`data-interjection`、`data-interrupted`、`cutoff: 'interrupted'`。
- Produces:
  - `afterRun(data: { running: boolean; runStatus: RunStatus | null; queued: QueuedView[] }): 'none' | 'wait' | 'restore'`
  - `restoredInput(current: string, queued: QueuedView[]): string`
  - `readIds(messages: UIMessage[]): Set<string>`：`data-interjection` 的 id。
  - `isInterrupted(message: UIMessage): boolean`

- [ ] **Step 1: 寫失敗測試（`queue.test.ts`）**

```ts
it('沒有排隊 → none；running → wait；succeeded → wait；failed、cancelled → restore', ...);
it('restoredInput：保留現有文字，排隊內容以空行接在後面', ...);
it('readIds 只取 data-interjection', ...);
```

- [ ] **Step 2: 跑測試確認失敗，實作 `lib/queue.ts`，確認通過**

- [ ] **Step 3: 改 `chat.tsx`**

- `busy` 時 `submit` 改呼叫 `POST /queue`，失敗時把文字還給輸入框並顯示 notice。
- 停止：`setStopping(true)` → `POST /stop` → `pollUntilDone()`。失敗顯示錯誤、解除 `stopping`。不呼叫 `useChat` 的 `stop`。
- 輸入框 Esc 觸發停止，要排除 `isComposing`。
- 按鈕：`busy` 時顯示停止鍵（`stopping` 時 disabled，顯示 `停止中…`），有文字時同時顯示送出鍵。
- `busy` 時 placeholder 用 `再傳一則訊息，會排隊`。
- `queued` 狀態：載入、輪詢都以伺服器回傳為準；`messages` 變動時用 `readIds` 移除已讀的。
- 載入和輪詢結束時走 `afterRun`：`wait` 繼續輪詢，超過 `QUEUE_WAIT_MS` 視同 `restore`；`restore` 用 `restoredInput` 放回輸入框，逐則 `DELETE`，409 忽略。
- `onFinish` 正常結束且 `queued` 非空時呼叫 `pollUntilDone`。

- [ ] **Step 4: 改畫面元件**

- `QueuedMessages`：props `{ items: QueuedView[]; onEdit(id, text); onDelete(id) }`，放在輸入框上方。編輯失敗顯示錯誤文案。
- `MessageView`：`data-interjection` 用使用者訊息泡泡（抽 `UserBubble`）；`data-interrupted` 畫 `<p role="status">已由你中斷</p>`，放在文字等 part 之後。
- `DelegationCard`：`cutoff === 'interrupted'` 或 `!live && status === 'working'` 時畫中性 chip `已中斷`，不顯示錯誤提示。
- `DiscussionView`：`cutoff === 'interrupted'` 比照。

- [ ] **Step 5: 跑全部 web 測試與型別檢查**

Run: `cd apps/web && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: 全部 PASS，無型別錯誤。

- [ ] **Step 6: 本機開站目視確認**

用 `/run` 或本機 dev server，確認單一顧問對話：停止鍵、Esc、排隊區、編輯、刪除、中斷標記。結束後用 `taskkill /T` 停 server 並確認埠已空。

- [ ] **Step 7: commit**

指定上面列出的檔案逐一 stage，commit message：`feat: 聊天畫面支援停止與排隊訊息`。

### Task 9: 上線與實測

**Files:** 無新增。把結果記到 spec 底部，或在 PR 描述列出。

- [ ] **Step 1: 跑全部測試**

Run: `pnpm test`（Git Bash）
Expected: 全部 PASS。

- [ ] **Step 2: 走 `superpowers:finishing-a-development-branch`，由使用者決定合併方式**

- [ ] **Step 3: 網站上線後更新 runtime**

沿用現有 runtime 發布流程。更新前的專案按停止會顯示 `暫時無法停止，請再試一次`。

- [ ] **Step 4: 正式站用 `ui-tester` 實測**

帳密在 `.superpowers/test-account.json`。單一顧問用「畫面實測」，多顧問用「ETF 投組健檢」。逐項確認：

- 停止後 `/workspace` 沒有殘留的沙盒子程序。
- 排隊訊息緊接工具結果送給 Vertex 模型時不報錯（SDK 測試用的是 mock，這裡才是真模型）。
- 主管等顧問時停止，傳「繼續」後不重做已完成的顧問。
- 排隊後關掉分頁，重新打開時已自動開下一輪。
- 停止時的排隊訊息回到輸入框。
- 重新整理後中斷標記還在。

- [ ] **Step 5: 回報實測結果，失敗項目照實列出**

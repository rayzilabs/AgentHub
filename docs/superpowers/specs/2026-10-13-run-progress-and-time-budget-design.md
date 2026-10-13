# 執行進度、工具紀錄與時間預算 技術規格

- 日期：2026-10-13
- 狀態：設計已逐段確認，待最終審閱
- 目標：使用者看得到 agent 跑到哪一步、有沒有在跑；run 出問題時查得到原因；快逾時時交出部分結果，而不是整個失敗
- 前提：沿用 MVP 規格（`2026-10-02-agenthub-mvp-design.md`），run 總上限維持 15 分鐘

---

## 0. 起因

正式站 2026-10-01 之後共 10 個 run，1 個失敗（10/7 20:40，專案「測試2」）：

- 使用者請主管「根據 ETF 資金流挑股票、債券、主動式 ETF，再做投組最佳化回測」。主管判斷有先後依賴，先只派工給 ETF 資金流顧問。
- 顧問用了 1 次 `read_file`、9 次 `bash`，每一步模型輸出只有 50～250 tokens，但兩步之間隔 1.5～3.7 分鐘，時間幾乎都花在指令上（單一指令上限 120 秒）。
- 15 分鐘到時顧問還在 `working`，run 被中止。主管的 `final` 只有一張派工卡片，沒有任何文字；投組顧問從未被派工。
- **無法查出顧問跑了哪些指令**：`tool_events` 只存工具名稱，而且顧問只有成功時才會被寫進 `messages`。

另外兩個平常就會遇到的體驗問題：

- 串流中，派工卡片把工具去重複成 chip（9 次 bash 只顯示一個「執行指令」），沒有內容也沒有時間。
- 超過 Vercel 300 秒後前端改輪詢，但主管的 `final` 要等 run 結束才寫入，使用者在 5～15 分鐘之間只看得到「回覆還在進行中」。10/2 的展覽 Demo 跑了 621 秒，就是這種情況。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| 交付方式 | 一份規格、三段實作（A → B → C），每段可以單獨上線 |
| 使用者看得到的工具細節 | **動作＋一句簡短描述**（由模型在工具輸入的 `description` 欄位填寫）。不在畫面顯示原始指令與輸出，避免透露創作者 skill 的做法 |
| 除錯用的完整細節 | 存在 `messages.tool_events`（截短），只有伺服器端讀得到 |
| run 總上限 | 維持 15 分鐘 |
| 顧問收尾 | 第 11 分鐘起不能再用工具，第 13 分鐘強制停止 |
| 主管收尾 | 第 11 分鐘起不接受新的派工／討論，第 13 分鐘起不能再用工具 |
| 收尾機制 | AI SDK `prepareStep` 設 `toolChoice: 'none'` 並補一段收尾指示；工具定義仍保留（避免 Gemini 看到歷史裡的工具呼叫卻沒有定義），不額外呼叫模型、不中斷正在跑的工具 |
| 執行中進度 | run 開始就建立 `final` 訊息，每 5 秒更新一次；另外每 20 秒更新 `updated_at` 當心跳 |

## 2. 段 A：工具紀錄與進度存檔（runtime）

### 2.1 工具輸入加 `description`

- `bash`、`write_file` 的 `inputSchema` 加上 `description: string`，欄位說明寫「每次都要填：用一句中文說明這一步在做什麼，給使用者看，不要包含指令本身」。schema 上設為選填（`.optional()`），避免模型漏填時整個工具呼叫驗證失敗、白白浪費一步。
- `read_file` 不加，畫面固定顯示「讀取檔案」。
- 記憶工具（`remember` / `recall`）、MCP 工具不加；畫面顯示動作名稱即可。

### 2.2 `ToolEvent` 擴充

```ts
// packages/runtime/src/ui-stream.ts 與 apps/web/lib/agent-output.ts 同步修改
export type ToolEvent = {
  tool: string;
  state: string;
  description?: string;
  started_at?: string; // ISO 時間
  ended_at?: string;
};

// 只存 DB，不送瀏覽器
export type ToolRecord = ToolEvent & {
  tool_call_id: string;
  input?: string;  // JSON.stringify 後截到 2,000 字
  output?: string; // 文字輸出或 errorText，截到 2,000 字
};
```

- `toolEvents(m)` 繼續回傳給瀏覽器用的 `ToolEvent[]`，多帶 `description`（從 tool part 的 `input.description` 取）與時間。
- 新增 `toolRecords(m)` 回傳 `ToolRecord[]`，用於寫入 `messages.tool_events`。
- 截短沿用 `tools/bash.ts` 的 `truncate()`，上限改為參數。

### 2.3 工具時間

UI tool part 本身沒有時間戳。新增一個小模組 `tool-clock.ts`，提供 `withToolTimes(stream)`，是作用在 `UIMessageChunk` 上的 TransformStream：

- 看到 `tool-input-start`（或第一次出現的 `toolCallId`）記下 `started_at`；看到 `tool-output-available`（非 preliminary）或 `tool-output-error` 記下 `ended_at`。
- 每次時間有變動，就在該 chunk 之後送出一個 `message-metadata` chunk，內容是完整的 `{ tool_times: Record<toolCallId, { started_at, ended_at? }> }`。每次都送完整的表，不依賴 metadata 合併行為。
- 在 `agents/build.ts` 的 `wrapAgent` 套用，主管、顧問、單一顧問的串流都會經過，跟現有的 `withWarnings` 同一層。
- 時間因此存在 UIMessage 的 `metadata` 裡，串流、DB 存檔、輪詢讀回來的訊息都帶有時間。`toolEvents()` 讀 `metadata.tool_times`，填入 `started_at` / `ended_at`。

### 2.4 顧問失敗或逾時也寫入

- `assign_task`：目前只在成功時呼叫 `record`。改成成功、失敗、逾時都寫一筆 `delegation` 訊息，`tool_events` 用 `toolRecords(last)`。失敗時 `content` 是已產生的文字，可能是空的。
- `convene_discussion`：`speakConcurrently` 一樣，失敗的發言也寫入。
- `RecordSpeech` 簽名不變；只要顧問產生過任何快照，不論成功、失敗或逾時都呼叫 `record`。`messages` 不加欄位。
- `loadHistory` 只讀 `user` / `final`，不受影響。

### 2.5 執行中定期存進度

- **Migration**：`messages` 加上 `updated_at timestamptz not null default now()`。
- `startRun`：寫入使用者訊息後，立刻插入一筆 `kind = 'final'`、`speaker_instance_id = rootId`、`content = ''`、`ui_message = null` 的訊息，記下 id。
- `settle()` 讀 `forServer` 串流時，每 5 秒（節流，依序寫入不並行）用最新快照 `update` 這筆訊息的 `ui_message`、`content`、`tool_events`、`updated_at`。
- 結束時做最後一次 update，取代現在的 insert。最後的 `final` 沒有內容時（`hasContent` 為 false）刪掉這筆，維持「沒有回覆就沒有 final」的現狀。
- 心跳：另外每 20 秒只更新 `updated_at`。一個 bash 可能跑 2 分鐘而沒有任何新快照，沒有心跳的話前端會誤判卡住。
- `final` 的 `created_at` 因此是 run 開始的時間，在 `messages` 裡會排在同一個 run 的 `delegation` / `discussion` 之前。前端只顯示 `user` / `final`，不受影響。
- 存進度失敗只寫 log，不讓 run 失敗，這點跟現在的 `record` 一樣。

### 2.6 瀏覽器收到的內容

- `DelegationOutput.tools`、`Speech.tools` 是 `ToolEvent[]`，不含 `input` / `output`。
- **已知缺口（不在本次範圍）**：主管或單一顧問自己的 tool part 是 AI SDK 原生串流，`input` / `output` 本來就會送到瀏覽器，也存在 `ui_message`。單一顧問模式下，原始指令因此仍然可以在網路請求裡看到。要遮掉必須在 runtime 過濾 UI stream，屬於安全性範圍（MVP 規格 §10）。

## 3. 段 B：前端進度顯示（web）

### 3.1 `ToolSteps` 元件

取代 `components/workspace/tool-list.tsx` 的 `ToolList`，用在派工卡片、討論發言，以及主管／單一顧問自己的一般工具（`message-view.tsx` 目前的 chip）。

```text
  ✓ 執行指令  計算近 4 週資金流評等            12s
  ● 執行指令  安裝數值計算套件              1:45…
  ✕ 執行指令  回測投組                    2:00
```

- 每次工具呼叫一行：狀態圖示、動作名稱（沿用 `TOOL_LABELS`）、`description`、經過時間。
- 執行中的那一行有 `dot-busy`，經過時間每秒更新，從 `started_at` 算到現在；已結束的顯示 `ended_at - started_at`。
- 超過 8 步時只顯示最新 5 步，上方顯示「前面還有 N 步」，點開展開全部。
- 沒有 `description` 或時間的舊資料：只顯示動作名稱，不顯示時間。
- 主管的 `assign_task` / `convene_discussion` 維持現有卡片，不進步驟列表。

### 3.2 整體狀態列

取代 `chat.tsx` 現在的「XX 正在處理」／「回覆還在進行中，完成後會自動顯示」：

```text
● 主管處理中 · 4:12 · 正在等 ETF 資金流顧問
```

- 總時間從 run 的 `started_at` 算起。`ThreadMessages` 加上 `startedAt: string | null`、`updatedAt: string | null`（`updatedAt` 取 `final` 訊息的 `updated_at`）。串流模式下 `startedAt` 用送出當下的時間。
- 「目前在做什麼」：取最後一個還沒結束的工具。`assign_task` 顯示「正在等 X」；`convene_discussion` 顯示「第 N 輪討論」；其他工具顯示 `description`，沒有就顯示動作名稱；都沒有則顯示「思考中」。
- **卡住提示**：只在輪詢模式判斷。`updatedAt`（含 20 秒心跳）超過 60 秒沒變，狀態列加上黃色「已經 1 分鐘沒有新進度，可能卡住了」。串流模式連線還在就表示 runtime 活著，不另外判斷；正在跑的工具那一行本身就有經過時間。現有「超過 20 分鐘的 running 視為失敗」不變。

### 3.3 輪詢模式顯示進度

- `pollUntilDone` 每次輪詢都用回傳的 `messages` 更新畫面（目前只在 `running = false` 時更新）。因為 2.5 節會定期存 `final`，畫面會跟著前進。
- 輪詢間隔維持 `POLL_INTERVAL_MS`（3 秒）。
- `getThreadMessages` 回傳 `final` 訊息時，`ui_message` 是 null（剛建立、還沒第一次更新）的那筆照現狀過濾掉。

### 3.4 共用型別

`apps/web/lib/agent-output.ts` 與 runtime 同步：`ToolEvent` 加三個選填欄位；`DelegationOutput`、`Speech` 加 `cutoff?: 'wrap-up' | 'stopped'`（見 4.4）。

## 4. 段 C：時間預算與收尾（runtime）

### 4.1 `RunClock`

```ts
export type RunClock = {
  startedAt: number;
  /** 顧問停止用工具、主管不再派新工作 */
  consultantWrapUpAt: number;   // start + 11 分
  /** 顧問強制停止、主管停止用工具 */
  consultantStopAt: number;     // start + 13 分
  /** 單一顧問模式：顧問本身的收尾點 */
  soloWrapUpAt: number;         // start + 13 分
  runTimeoutAt: number;         // start + 15 分（現有）
};
```

- 在 `startRun` 建立，依 `RunDeps.runTimeoutMs` 等比例縮放（11/15、13/15），讓測試可以用短時間跑完整流程。
- 傳給 `buildManager`、`createConsultantRunner`、`assignTaskTool`、`conveneDiscussionTool`、`buildConsultant`。

### 4.2 顧問

- `buildConsultant` 加上 `wrapUpAt?: number`。`prepareStep` 檢查 `Date.now() >= wrapUpAt` 時回傳 `{ toolChoice: 'none', instructions: 原指示 + 收尾段落 }`。
- 收尾段落：「時間已到，不能再使用工具。請根據目前已取得的結果直接回覆，並明確列出哪些部分沒有完成、原因是時間不足。」
- 被派工或參加討論時用 `consultantWrapUpAt`；單一顧問模式用 `soloWrapUpAt`。
- `ConsultantRunner` 在 `consultantStopAt` 用 `AbortSignal.any([上游 signal, 計時 signal])` 中止顧問。單一顧問模式沒有這一層，由現有的 15 分鐘逾時處理。

### 4.3 主管

- `buildManager` 的 `prepareStep`：`Date.now() >= consultantStopAt` 時設 `toolChoice: 'none'`，並補上「請彙整各顧問已交回的內容，缺漏的部分要明講」。
- `assign_task` / `convene_discussion` 在 `consultantWrapUpAt` 之後被呼叫時不啟動顧問，直接回傳 `failed`，`error` 為「剩餘時間不足，請用已有的結果彙整」。
- 討論進行中跨過 `consultantWrapUpAt` 時，不開新的一輪；已在發言的顧問照 4.2 收尾。`state.error` 寫「時間不足，提前結束討論」。

### 4.4 狀態與畫面

- 顧問在收尾點之後才完成：`DelegationOutput.status = 'done'`、`cutoff = 'wrap-up'`。卡片顯示「時間到，已提前收尾」。
- 顧問被強制停止：`status = 'failed'`、`cutoff = 'stopped'`，`message` 保留已產生的文字。`toModelOutput` 回給主管的內容是：「{name} 逾時，只完成部分工作。已完成的步驟：{各步 description}。已寫出的內容：{text 或「無」}」。卡片顯示「逾時，只交回部分結果」。
- 討論發言同樣使用 `cutoff`。
- 15 分鐘的最後防線不變：run 標成 `failed`、`TIMEOUT_ERROR`。因為 2.5 節的定期存檔，畫面仍顯示已完成的部分。

## 5. 錯誤處理

| 情境 | 處理方式 |
|---|---|
| 定期存進度失敗 | 只寫 log，下一次節流時間到再試；run 結束時的最後寫入失敗沿用現有的 `saveError` |
| 模型沒有填 `description` | 欄位是選填，工具照常執行；畫面只顯示動作名稱 |
| 收尾後模型仍嘗試呼叫工具 | `toolChoice: 'none'` 由 Gemini 端禁止函式呼叫；萬一仍產生，工具照常執行，下一步仍是 `none`，`MAX_STEPS` 兜底 |
| 顧問在收尾時有 bash 正在跑 | 不中斷，等它完成（最多 120 秒）；13 分鐘時才會被中止 |
| Sprite 崩潰 | 不變：runtime 重啟時清理 running；`updatedAt` 停止前進，前端 60 秒後顯示「可能卡住了」 |

## 6. 測試

**環境注意**：`packages/runtime` 與 `apps/web` 的 Vitest global teardown 會刪除雲端 Supabase 所有 `@test.local` 帳號。2026-10-13 確認正式站沒有真實帳號使用這個網域（展覽 Demo 用 `@demo.agenthub.app`），可以執行，但不要建立 `@test.local` 的人工測試帳號。

1. **單元測試（Vitest）**
   - `toolEvents` / `toolRecords`：`description` 取值、截短、時間合併、舊資料（沒有 metadata）。
   - `withToolTimes`：開始與結束時間、同一個 toolCallId 不重複記錄、preliminary output 不算結束、經過 `readUIMessageStream` 後 metadata 正確。
   - `RunClock`：依 `runTimeoutMs` 等比例縮放。
   - `assign_task`：失敗與逾時也呼叫 `record`；收尾點之後不啟動顧問；`cutoff` 的兩種情況與 `toModelOutput` 內容。
   - `runDiscussion`：跨過收尾點不開新的一輪；失敗發言會寫入。
   - `prepareStep`：過了收尾點 `toolChoice` 為 `none`，且指示有收尾段落（用 mock model 檢查 `doStreamCalls`）。
   - web：`ToolSteps` 的步數摺疊與時間格式；狀態列的「目前在做什麼」推算與卡住判斷。
2. **整合測試**（`server.test.ts`，mock model、短 `runTimeoutMs`）
   - 執行中可以從 DB 讀到持續更新的 `final`。
   - 顧問被強制停止時，主管仍產出 `final`，run 為 `succeeded`。
   - 失敗的顧問在 `messages` 有一筆 `delegation`，帶完整 `tool_events`。
3. **真實環境驗證**（手動）：新開一個專案，重問 10/7 的問題，確認畫面步驟列表即時更新、超過 5 分鐘輪詢時進度仍前進、最終有一份回覆（可以是部分結果）。

## 7. 部署

| 段 | 改動 | 部署 |
|---|---|---|
| A | runtime + migration | `pnpm db:push`、`pnpm db:test`，再 `publish-runtime`。新專案生效 |
| B | web | push 到 `main` 自動部署。舊專案（舊 runtime）也能顯示，只是沒有描述與時間 |
| C | runtime | `publish-runtime` |

- 只有新專案會用新 runtime。展覽 Demo（10/23–24）要用新版，有兩種做法：開一個新的 Demo 專案，或跑 `redeploy-runtime`（會重啟所有 Sprite）。時間點排在展覽前，並先跟 Eric 確認。
- 順序上 A 必須先上線（migration 與 `final` 改成先插入），B 才會在輪詢模式看到進度。

## 8. 不在本次範圍

- 遮掉單一顧問模式送到瀏覽器的原始工具輸入／輸出（見 2.6）。
- 讓創作者或專案自訂時間上限。
- 使用者手動中止 run。
- 依 `tool_events` 做的除錯介面；目前直接查 DB。

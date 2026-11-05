# 執行中停止與訊息排隊

日期：2026-11-05
狀態：設計，待使用者確認

標「我決定」的是我拍板的細節，其餘是使用者確認過的行為。

## 1. 為什麼要做

使用者在正式站實測授信顧問時，想在執行過程中介入，但現在做不到：

- 一輪最長 15 分鐘，開始後只能等它跑完或逾時。送錯方向也停不下來，額度照燒。
- 輸入框執行中能打字，但送出鍵被鎖住（`chat.tsx` 的 `busy`），想補充條件只能等。

使用者的原則是「盡量模仿 Claude Code」：Esc 中斷，Queue another message 排隊插話。

## 2. 目標

1. **停止**：執行中按停止鍵或 Esc，主管、顧問和執行中的指令一起停。
2. **保留**：已跑出的內容留在畫面上，標成「已由你中斷」，不算錯誤。
3. **接手**：下一則訊息接著同一段對話，例如傳「繼續」。已完成的顧問不用重做。
4. **排隊**：執行中可以繼續送訊息，agent 走到下一步時讀到，這一輪不中斷。
5. **收尾**：這輪結束前沒讀到的訊息，自動變成下一輪，關掉分頁也一樣。

## 3. 不做的事

- 原地凍結、之後從同一步續跑。使用者確認「恢復」就是靠下一則訊息接手。
- 把排隊訊息轉給執行中的顧問。排隊訊息只給根 agent，和 Claude Code 等 subagent 時一樣；急的話按停止。
- 把工具原始輸入和輸出帶進下一輪的上下文。
- 改變正常跑完的對話上下文。顧問報告只有被中斷的那一輪才額外帶入。
- 修單一顧問專案把工具原始內容傳到瀏覽器的問題（第 10 節），另外處理。

### 做壞了也算失敗的情況

- 停止後中斷的內容消失，或畫面顯示成錯誤。
- 排隊訊息遺失，或同一則被 agent 讀到兩次。
- 同一串對話同時跑兩輪。
- 停止後主管或顧問的子程序還在背景跑、繼續扣額度。
- 排隊訊息在 agent 看不到的情況下顯示成「已讀」。

## 4. 使用者看到的行為

### 停止

- 執行中，輸入框右側出現停止鍵；輸入框內按 Esc 效果相同（選字中不觸發）。
- 按下後顯示「停止中…」，不重複送出，直到這輪真的結束。
- 結束後，這輪的回覆留在原位，尾端標「已由你中斷」。如果還沒有任何內容，也要有這個標記。
- 已寫入的檔案不還原，已交付的檔案保留，已用的額度照算。
- 輸入框恢復可送出，下一則訊息是新的一輪。

### 排隊

- 執行中輸入框提示改成可排隊（我決定：文案「再傳一則訊息，會排隊」）。有文字時同時顯示送出鍵和停止鍵。
- 送出後訊息顯示在輸入框上方，依序排列，可以編輯或刪除。
- agent 走到下一步時，一次讀完所有排隊訊息。讀到的訊息從排隊區移走，出現在回覆中那個位置，樣式和使用者訊息相同。
- 被讀到之後不能再改。編輯和讀取同時發生時，以先完成的為準，編輯失敗要告訴使用者。

### 這輪結束時還有排隊訊息

| 這輪的結果 | 排隊訊息怎麼處理 |
|---|---|
| 正常完成 | 合成一則（以空行分隔），自動開下一輪 |
| 使用者停止 | 回到輸入框，不自動送出；輸入框原有文字保留，排隊內容接在後面 |
| 失敗或逾時（我決定） | 同上，回到輸入框並顯示原本的錯誤。狀況不明時不自動再花額度 |

關掉分頁後才結束的情況相同。正常完成時伺服器會自己開下一輪。另外兩種情況，訊息留在伺服器，下次打開這串對話時回到輸入框。

## 5. 資料

Migration 要由使用者貼到 Supabase SQL Editor 套用（CLI 沒有權限）。

### `runs.status` 加 `cancelled`（我決定）

不沿用 `failed`：中斷不是錯誤，下一輪組上下文也要靠這個狀態判斷。`getThreadMessages` 現有寫法只在 `failed` 回傳 error，`cancelled` 不需要改就不會顯示錯誤。`running` 仍受 `one_running_run_per_thread` 保護。

### 新表 `queued_messages`

欄位：`id`、`thread_id`（references threads，on delete cascade）、`text`、`created_at`。

- 開 RLS。網站照舊用 service role。
- runtime 帳號：`select (id, thread_id, text, created_at)` 和 `delete`，用 `runtime_project()` 限定在自己專案。比照 `20261014000002_runtime_scoped_access.sql` 寫法。
- 取走就是刪除：用 `delete ... returning`，依 `created_at` 排序。一列只會被一方取走，這是「不會讀到兩次」的保證。

### `messages.kind` 加 `interjection`（我決定）

存被 agent 讀到的排隊訊息，帶 `run_id`，`content` 是訊息文字，`ui_message` 留空。不用 `user`，原因有兩個：

- `getThreadMessages` 會把 `user` 列排在 `final` 之後顯示，但這則訊息要出現在回覆中間（第 6 節）。
- `final` 列在一輪開始時就插入，`created_at` 比插話早，歷史順序要另外處理。

`getThreadMessages` 不回傳 `interjection`，查詢條件不用動。`packages/runtime/src/types.ts` 的 `MessageKind` 要同步。

## 6. 排隊的實作

**放進步驟。** 根 agent 的 `prepareStep` 在每步開始前取走排隊訊息，附加到 `messages` 尾端回傳。AI SDK 7.0.126 文件註明這個覆寫會延續到後續步驟（`index.d.ts`「The override carries forward to later steps」），不用每步重放。現有 `wrapUpStep` 要與此合併，收尾階段一樣要讀。

只有根 agent 有這個能力：單一顧問專案是該顧問，多顧問專案是主管。`createConsultantRunner` 建出的顧問不接。

**畫面位置。** `final` 是一則 UIMessage。取走時放進一個 `data-interjection` part，內容含文字和排隊列的 `id`，寫法比照 `withWarnings` 用 TransformStream 插在下一個 `start-step` 之前。`MessageView` 把它畫成使用者訊息樣式。前端用 `id` 比對，從排隊區移除。

**持久化。** 取走時先寫 `interjection` 列，再交給模型。

**下一輪的歷史。** `loadHistory` 也讀 `interjection`，把它排在同 `run_id` 的 `final` 之前。這樣之後的輪次看到的是「插話 → 回覆」，不會以為插話沒被回答。

**時機限制。** 主管等顧問時不會進入下一步，排隊訊息要等顧問做完。模型結束且不再呼叫工具時也不會有下一步，這時走第 7 節。

## 7. 自動開下一輪

runtime 不能自己開：專案通行證效期 20 分鐘（`PROJECT_TOKEN_TTL_MS`），資料庫通行證最少也只保證 20 分鐘，一輪最長約 15 分鐘，舊通行證撐不完下一輪。平台也不能靠瀏覽器觸發，分頁可能已關。

流程：

1. runtime 這輪以 `succeeded` 結束，`finishRun` 之後查 `queued_messages`。
2. 有資料就用專案通行證呼叫平台新路由 `POST /api/runtime/threads/:id/continue`。
3. 平台驗證通行證與對話屬於該專案，重新簽兩張通行證，用 `forwardChat` 呼叫 runtime 的 `/chat`，不帶 `text`。
4. runtime 的 `/chat` 沒有 `text` 時，先 `createRun`，再取走全部排隊訊息合成這輪的使用者訊息。沒取到就把這輪標 `succeeded`、不插入任何訊息，回 204。

先 `createRun` 再取走，是為了撞到 409 時訊息還留在表裡。

**排隊與結束的競態。** 平台寫入排隊列之後，再查一次該對話是否沒有 `running` 的 run；沒有就走同一條 continue 邏輯。runtime 是先寫狀態再查排隊，平台是先寫排隊再查狀態，兩邊至少一方看得到，同時看到時由 `one_running_run_per_thread` 擋掉一個。

## 8. 停止的實作

**路徑。** 前端 `POST /api/threads/:id/stop` → 平台查最新 `running` run → runtime 新路由 `POST /runs/:id/stop`，驗證方式與 `GET /runs/:id` 相同。

**runtime。** `activeRuns` 從 Set 改成 Map，值是這輪的停止函式，`GET /runs/:id` 判斷不變。

`startRun` 加一個 `stopped` 旗標，與逾時分開：

- `settle` 現在用 `abort.signal.aborted` 判斷逾時，要改成只有計時器觸發才算逾時。
- `abort` 已經傳到 `streamUI`、顧問和 `bash`，不用另外接線。
- 寬限時間（我決定：10 秒）內串流沒結束就強制收尾，比照現有 `hardDeadlineMs`。寬限期前要先存下最後一份進度。
- `prepareRootAgent` 階段（同步檔案、裝套件）不能中止。要在它結束後、開始串流前檢查 `stopped`，直接收尾。

**收尾。** 回傳 `cancelled`，不寫 error。`final` 即使沒有內容也要留下，並加 `data-interrupted` part 給畫面畫標記。`runtime_update` 政策只准改 `running` 的 run，所以要維持先存 `final` 再 `finishRun` 的順序。

**平台。** 沒有 `running` 的 run 就回成功（可重複呼叫）。runtime 明確回答不知道這個 run 時，走現有 `markRunInterrupted`。連不上 runtime 時回錯誤，畫面告知沒有停下來，不要假裝成功。

**前端。** 不呼叫 `useChat` 的 `stop`：那只會切斷瀏覽器連線，伺服器照跑。發出停止後維持現有串流或輪詢，直到收到結束。

**卡片。** 被中斷的顧問現在會走 `status: 'failed'`，`DelegationCard` 和討論畫面會把 `run 已中止` 畫成錯誤。使用者中斷要比照 `cutoff` 多一個 `interrupted` 狀態，畫成「已中斷」的中性樣式。如果中止後 generator 沒機會再 yield，卡片會停在 `working`，也要靠 `live` 為 false 判斷成同樣的樣式。

## 9. 中斷後的上下文

`loadHistory` 對 `cancelled` 的 run，把該輪的 `delegation`、`discussion` 列讀進來，和該輪 `final` 的文字合成一則 assistant 訊息，開頭註明這輪被使用者中斷、以下是當時的進度。每段要標明是哪位顧問，所以 migration 要多開放 runtime 讀 `messages.speaker_instance_id`（目前的欄位權限沒有它），名稱再對照 `agent_instances`。

**內容範圍。** 只帶報告文字和已完成步驟的描述，不帶工具原始輸入和輸出。

- 已完成的顧問：`content` 已經是報告文字。
- 被中斷的顧問：`content` 改寫成現有 `stoppedSummary` 的格式（已完成的步驟＋已寫出的內容），措辭從「逾時」改成「被使用者中斷」。
- 不開放 runtime 讀 `tool_events`，那是除錯用的原始紀錄。

**要先驗證的風險。** `assign_task` 的 `save()` 在 `catch` 裡。如果中止時 SDK 直接結束這個 generator，`catch` 不會跑，被中斷的顧問就沒有紀錄。實作要用測試確認；不成立就改放 `finally`。討論工具 `speakConcurrently` 也要確認。

顧問本身的上下文不變：重新派工時仍只收到主管寫的任務說明。

## 10. 另外發現、這次不處理

單一顧問專案的根 agent 是顧問本人，`run.ts` 把 UI 串流直接轉給瀏覽器，`ui_message` 也原樣回傳。從程式看，工具原始輸入和輸出（可能含 skill 內容）可從開發者工具看到。尚未在正式站實測，另開項目處理。

## 11. 影響範圍

| 位置 | 改動 |
|---|---|
| `supabase/migrations/` | `cancelled`、`interjection`、`queued_messages` 與權限 |
| `packages/runtime/src/run.ts`、`active-runs.ts`、`server.ts` | 停止、無 `text` 的 `/chat`、結束時呼叫 continue |
| `packages/runtime/src/agents/build.ts` | `prepareStep` 取排隊、插 `data-interjection` |
| `packages/runtime/src/run-store.ts`、`tools/delegate.ts`、`tools/discuss.ts` | 歷史組裝、中斷摘要、排隊存取 |
| `apps/web/lib/services/threads.ts` | 回傳 `queued` |
| `apps/web/app/api/threads/[id]/` | `stop`、`queue` 路由（新增、編輯、刪除） |
| `apps/web/app/api/runtime/threads/[id]/continue/` | 新路由 |
| `apps/web/components/workspace/` | `chat.tsx` 停止鍵、Esc、排隊區；`message-view.tsx` 兩種新 part |

## 12. 上線順序

1. 使用者貼 migration。舊程式不受影響，只是多了欄位值和新表。
2. 部署網站。
3. 更新 runtime。舊 runtime 沒有 `/runs/:id/stop`，平台要把這種情況當成「暫時無法停止」回報。

## 13. 驗證

- 單元測試涵蓋：停止與逾時分流、`loadHistory` 組裝與排序、取走不重複、競態下只開一輪。
- runtime 測試用 `test/mock-model.ts` 驗 `prepareStep` 真的把訊息送進下一步，且後續步驟仍在。
- 正式站用 `ui-tester` 帳號實測，專案「畫面實測」是單一顧問，另需多顧問專案（「ETF 投組健檢」）測主管等顧問時停止。
- 實測項目：停止後沒有殘留子程序、下一則「繼續」不重做已完成的顧問、關掉分頁後排隊訊息仍自動開下一輪。

## 14. 留給實作的細節

- 排隊區的樣式，比照現有輸入列。
- 路由的回應格式與錯誤文案。
- 前端串流結束後切換到輪詢的細節。正常完成且本地還有排隊訊息時，要繼續輪詢等下一輪出現；約 30 秒沒出現就視為失敗，訊息回到輸入框。

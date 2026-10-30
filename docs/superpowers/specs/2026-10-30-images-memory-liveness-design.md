# 顧問讀圖片、沙盒記憶體上限、run 存活確認 設計

日期：2026-10-30

## 為什麼要做

2026-10-29 真實使用者 chhan 上傳一張持股截圖，請投組顧問依截圖回測：

1. `read_file` 把圖片當文字讀（沙盒內 `head -c`），顧問看不到圖，只好自己 `pip install easyocr torch` 做 OCR。
2. Sprite 只有 8 GB 記憶體、沒有 swap，沙盒指令沒有任何資源限制；載入 torch 與 OCR 模型時記憶體耗盡，核心把 runtime 程序一起砍掉。
3. runs 表的狀態停在 `running`（改狀態的程序已經死了，15 分鐘計時器也在同一個程序裡）。前端顯示「執行中」，chhan 等了 6 分多鐘，直到送出下一則訊息喚醒 runtime、清理孤兒 run，才看到「runtime 重啟」。

## 使用者定下的決定

1. **三件事一起做**：顧問看得到圖片、沙盒指令加記憶體上限、確定 runtime 掛掉時盡快標成中斷。
2. **圖片走「做法一」**：`read_file` 讀到圖片時，工具回傳＝文字＋圖片本身（Gemini 原生的多模態工具回傳）；runtime 在請求離開 Sprite 前，把工具回傳裡夾帶的圖片換成 Supabase Storage 的簽名網址。模型看到的仍是圖片（Vertex 依網址下載後轉成圖片 token），請求體積只多一個網址。
3. **存活確認要「直接問 runtime」**，不是靠心跳推測；Vercel 去問 Sprite 時**要驗證身分**。

## 已實測的事實（2026-10-30）

- Vertex `gemini-3.6-flash` 接受 `fileData.fileUri` 為一般 https 網址（含查詢參數），**放在 `functionResponse.parts` 裡也可以**；同一張圖用網址或 base64，圖片都算 1,083 token、回答相同；2.2 MB 的 JPG 用網址 3.4 秒完成。
- AI SDK（`@ai-sdk/google` 4.0.87＋`@ai-sdk/google-vertex` 5.0.101）對 Gemini 3＋Vertex 的工具回傳：只有 `gs://` 網址直接傳，**https 網址一律先在 Sprite 上下載、改成 inlineData**（上限 7 MB），下載用內部的 `fetchUntrustedUrl`，無法以選項關閉。使用者訊息裡的 https 網址則直接傳。→ 所以做法一要在 `createVertex({ fetch })` 這一層改寫請求。
- Vercel Functions 請求與回應各上限 4.5 MB（官方文件）；所有模型請求都經 Vercel `/api/runtime/model`，圖片若以 base64 夾帶，且每一步都重送整段歷史，很快就會撞到。
- Sprite：8 GB、無 swap、8 CPU；cgroup v2 可寫、memory 控制器可用、根 cgroup 的 `subtree_control` 目前為空；`sprite` 帳號可免密碼 sudo；有 `prlimit`、沒有 `systemd-run`；沒有 ImageMagick、系統 Python 沒有 PIL。

## 目標

### A. 顧問讀圖片

- `read_file` 讀到共用資料夾（`/workspace/shared`）裡的圖片（png、jpg/jpeg、webp、gif；以檔頭判斷，不只看副檔名），回傳文字說明（檔名、格式、尺寸）＋圖片內容，模型直接看圖。顧問與主管都適用（主管的 `read_file` 也讀共用資料夾）。
- 請求送往 Vercel 前，runtime 的 `fetch` 把工具回傳 `functionResponse.parts` 裡的 inlineData，換成該檔在 Storage `project-files/<專案 id>/<檔名>` 的簽名網址（`fileData`）。比對依**內容雜湊**：只有與 Storage 版本逐位元組相同的圖片才換；其他一律不動。
- 每一步重送歷史時都會再換一次；同一個 run 內同一張圖重用同一個簽名網址。
- 簽名網址時效 1 小時（大於 run 上限 15 分鐘）；只出現在 Sprite → Vercel → Vertex 這條路上，不給使用者、不給顧問、不寫進資料庫。
- 圖片只在讀到它的那次 run 裡可見；存檔的歷史不含圖片，之後的訊息若還要看，顧問再 `read_file` 一次。（我的決定）

### B. 沙盒記憶體上限

- 所有顧問的沙盒程序（bash、stdio MCP；主管的沙盒帳號也算）放進同一個 cgroup v2 群組，總上限 6 GB（8 GB 留 2 GB 給 runtime 與系統）。超過時核心只在群組內 OOM，runtime 不受影響。
- 指令被 OOM 砍掉時，顧問收到明確訊息（例如「指令因記憶體超過上限被終止」），而不是一般失敗碼。
- 設定放在既有的 root 設定腳本（`agenthub-sandbox` 系列，`apps/web/lib/sprites.ts` 的 `sandboxSetupScript`），沙盒包裝程式在降權前把程序移入群組；既有 Sprite 用 `redeploy-runtime` 套用。

### C. run 存活確認

- runtime 在記憶體裡維護「目前在跑的 run」清單（建立 run 時加入；`finish` 把狀態寫進 runs 表**之後**才移除，避免 Vercel 在「已移除、狀態還沒寫」的空檔誤判）。
- 新增端點（例如 `GET /runs/:id`），回答該 run 是否在清單裡。**驗證身分**：Vercel 呼叫時附上該專案的資料庫通行證（同 `/chat` 的 `x-agenthub-db-token`），runtime 向 Supabase 確認這張通行證屬於本專案的 runtime 帳號，才回答；否則 401。
- Vercel 的訊息查詢（前端輪詢用，`/api/threads/:id/messages`）發現 run 為 `running` 時，最多每 15 秒問一次 Sprite：
  - 「在跑」→ 不動
  - 「不知道這個 run」→ 確定已死（runtime 重啟過或收尾出錯），立刻把 run 標成 failed，錯誤「執行環境中斷」
  - 連不上／逾時 → 無法判斷，不標記；回給前端「暫時連不上執行環境」的提示，仍受 15 分鐘上限保護
- runtime 的結果優先：若 runtime 稍後仍寫入結果，以 runtime 的為準（例如判斷與收尾同時發生的競態）。

## 不做的事

- 顧問在自己工作目錄或沙盒產生的圖片（例如自己畫的圖表）：沒有 Storage 網址，`read_file` 回「這張圖不在共用資料夾，無法檢視」，不夾帶。（我的決定）
- PDF 等其他檔案類型（使用者說的是「圖」）。
- 縮圖、裝影像工具、改用 Supabase Edge Function、改用 GCS `gs://`。
- 以心跳逾時判定死亡（心跳只是間接證據；使用者要「真的知道」）。

## 失敗的樣子

- 有任何一張圖以 base64 送進 Vercel（請求變大、撞 4.5 MB）。
- 顧問能藉由在共用資料夾放同名檔案，讓 runtime 對任意內容簽出網址，或讀到別的專案的檔案。
- 圖片的 base64 或簽名網址被寫進 `messages`（ui_message、tool_events）或 log。
- 還在跑的 run 被標成中斷。
- 記憶體上限讓一般工作（例如顧問建 venv 裝 numpy、pandas 計算）失敗。

## 限制

- 平台在 Eric 的 repo（`D:\AgentHub\eric-agenthub`），直接在 main 開發、push 自動部署 web；runtime 要 `publish-runtime`＋`redeploy-runtime`（重啟所有 Sprite，要先確認沒有執行中的對話）。
- 改 runtime 權限或資料表前先查並更新 `docs/security-model.md`。
- runtime 測試要從 Git Bash 跑；測試會連真的 Supabase。
- 沙盒相關改動要用 `apps/web/scripts/probe-sandbox.ts`（真實 Sprite）驗收。
- 工具紀錄（`toolRecords`）與存檔的 ui_message 目前會存工具輸出；圖片內容必須在存檔前移除，只留文字說明。

## 留給實作者

- 讀圖片位元組的方式：仍經沙盒（尊重權限），以 base64 等二進位安全的方式取出。
- 簽名網址的取得：用 runtime 的資料庫通行證呼叫 Storage `createSignedUrl`；先實測 runtime 帳號的 RLS 是否允許，不允許時在 migration 補最小權限並更新 security-model.md。實測時也確認 Vertex 下載得到 Supabase 的簽名網址（2026-10-30 只測過 Google 與 NASA 的公開網址）。
- 改寫請求的位置與比對細節（`createVertex({ fetch })` 包一層、解析 JSON、只動 `functionResponse.parts[].inlineData`、比對失敗原樣保留）。
- cgroup 群組名稱、6 GB 是否要依實測調整、OOM 訊息怎麼偵測（`memory.events` 的 `oom_kill` 計數或退出訊號）。
- 存活端點的路徑、Vercel 端的節流方式（例如在 runs 表記上次查詢時間，或只在記憶體內節流）。

## 驗收

- 圖片：真實 Sprite 上傳一張手機截圖（≥2 MB）到專案、請顧問描述內容，回答正確；攔截到的模型請求小於 100 KB，且工具回傳裡是 `fileData` 網址；messages 裡沒有 base64 與簽名網址。顧問在共用資料夾放一個同名但內容不同的檔案時，`read_file` 不簽網址。
- 記憶體：真實 Sprite 上讓顧問執行一支吃掉 7 GB 的程式，指令被終止並收到上限訊息，runtime 與 run 仍正常完成；`probe-sandbox.ts` 全過；建 venv 裝 numpy、pandas 正常。
- 存活：真實 Sprite 上執行中 kill runtime 程序，前端在 30 秒內顯示中斷；正常跑 10 分鐘以上的 run 不會被誤標；沒有正確通行證呼叫存活端點回 401。

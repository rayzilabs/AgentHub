# AgentHub MVP 技術規格

- 日期：2026-10-02
- 狀態：設計已逐段確認，待最終審閱
- 目標：**把功能跑通**。不做金流、不處理資安、不做上架審核。

---

## 0. 產品摘要

專業人士（律師、會計師、行銷顧問等）把自己的 SKILL／SOP 包成 agent 上架；其他使用者在市集一鍵啟用，放進自己的專案使用。

- 每個 agent 綁定 **system prompt + skill + MCP**，並且一定有自己的 **memory** 和 **sandbox**。
- **單一 agent 模式**：專案裡只有一位顧問，使用者直接跟顧問對話。
- **多 agent 模式**：專案裡有 2 位以上顧問時，平台自動加入一位**主管**。主管面對使用者，可以：
  - **派工**：把任務交給某位顧問，拿回結果。
  - **召開討論**：讓多位顧問就同一題目來回討論（主持人式，最多 3 輪），再由主管產出整合各面向的總結。

## 1. 決策紀錄

| 項目 | 決定 |
|---|---|
| 範圍 | MVP 只求功能跑通。不做金流、不做資安、不做上架審核 |
| 對外入口 | **Vercel `/api/*` 是瀏覽器唯一的後端入口**。Supabase 只在伺服器端使用；Sprite 用私有網址 |
| 沙盒 | **每個專案一台 Fly.io Sprite**，每個 agent 在裡面有自己的工作目錄 |
| agent 迴圈 | 跑在專案 Sprite 裡的 Node 服務，有請求進來才喚醒執行 |
| Agent SDK | **Vercel AI SDK**（`ai`、`@ai-sdk/google-vertex`、`@ai-sdk/mcp`）。不用 Google ADK，理由見 §6.1 |
| 模型 | `gemini-3.8-flash`，走 Gemini Enterprise Agent Platform（原 Vertex AI）的 express mode（API key，global 端點） |
| 主管 | 平台內建，不從市集上架 |
| 多 agent 協作 | 派工 + 主持人式討論（最多 3 輪）。不做自由式 agent 互傳訊息 |
| 記憶 | agent 自己用 `remember` / `recall` 決定記什麼，分「agent 私有」和「專案共用」兩層，存在 Supabase |
| MCP 金鑰 | 租用者啟用時填寫，存在 Supabase Vault。只支援固定 API key，不做 OAuth |
| 上架 | 網頁表單 + 上傳 skill zip，MCP 逐筆新增 |
| 一鍵啟用 | 只複製 system prompt、skill、MCP 設定的**快照**。記憶與執行環境全新 |
| 用量 | 每次模型呼叫都寫入用量帳本（只記錄、不計費），留給之後算分潤 |

## 2. 整體架構

```
瀏覽器 ──► Vercel（Next.js 前端 + /api/*）──► Supabase（DB、Auth、Storage；只在伺服器端使用）
  │              │                                   ▲
  │              │ 轉送對話（Bearer Sprite token）    │ runtime 讀寫資料（service role key）
  │              ▼                                   │
  │        專案 Sprite（私有網址，一個專案一台）───────┘
  │          agent runtime（Node，port 8080）
  │            POST /chat   → AI SDK UI message stream
  │            GET  /health
  │          /agents/<實例id>/       各 agent 的工作目錄（含 skills/）
  │          /shared/                專案共用檔案（從 Storage 同步）
  │              │
  │              └──► Gemini（global 端點）
  │
  └─ 用簽名網址直接上傳檔案 ──► Supabase Storage
```

### 2.1 元件職責

- **Vercel（Next.js）**
  - 所有前端頁面：市集、上架表單、專案頁、對話介面、記憶管理。
  - `/api/*` 是唯一的後端入口。每支 API 先確認目前使用者有權限，例如他是專案擁有者，才操作資料。
  - 持有 Supabase service role key、Sprite 組織 token。
  - 登入用 `@supabase/ssr`，在伺服器端處理，瀏覽器只拿到 session cookie。MVP 只做 Email + 密碼登入，瀏覽器完全不會連到 Supabase。之後若加 Google 登入，OAuth 導向會經過 `<project>.supabase.co/auth/v1/...`，網域會出現在網址列；這是 Supabase Auth 的正常設計，不構成風險。
- **Supabase**
  - Auth。
  - Postgres：所有持久資料（§3）。
  - Storage：skill zip、專案檔案、runtime 安裝包。
  - Vault：MCP 金鑰。
  - 所有資料表都開 RLS 但不設規則，等於拒絕任何直接存取；只有 service role 能讀寫。
- **專案 Sprite**
  - 唯一跑 agent 的地方。
  - 不保存任何「唯一」的資料：對話、記憶、檔案都以 Supabase 為準。Sprite 壞了重建一台，只會失去 agent 的暫存工作檔。
  - 網址維持預設的私有模式，只接受帶 `Authorization: Bearer <Sprite 組織 token>` 的請求。
- **Gemini**：只有 runtime 會呼叫。

### 2.2 專案結構（monorepo）

```
apps/web/                 Next.js（前端 + /api/*）
packages/runtime/         agent runtime，打包後部署到 Sprite
supabase/migrations/      資料表、RPC
scripts/                  冒煙測試、runtime 批次更新
```

## 3. 資料模型

```
profiles            使用者（id = auth.users.id）
  display_name

agent_templates     創作者上架的 agent（範本）
  id, creator_id → profiles
  name, description, category
  system_prompt     text
  skills_zip_path   text    skills bucket 內的物件路徑，檔名用內容雜湊：<template_id>/<sha256>.zip
  skills            jsonb   [{ name, description, path }]，上架時從各個 SKILL.md 解析；path 是該 skill 資料夾在 zip 內的相對路徑
  mcp_servers       jsonb   [{ name,
                               transport: 'stdio' | 'http',
                               command, args,          -- stdio 用
                               url, headers,           -- http 用；headers 可含 ${KEY}
                               required_secrets: [{ key, description }] }]
  status            'draft' | 'published'

projects            使用者的專案（一個專案 = 一台 Sprite）
  id, owner_id → profiles
  name
  sprite_name, sprite_url
  sprite_status     'provisioning' | 'ready' | 'error'
  sprite_error      text

agent_instances     專案裡的 agent（一鍵啟用時從範本複製）
  id, project_id → projects
  template_id       → agent_templates，只記錄來源，可為 null（主管為 null）
  role              'consultant' | 'manager'
  name, system_prompt, skills_zip_path, skills, mcp_servers   ← 啟用當下的快照

instance_secrets    租用者填的 MCP 金鑰
  instance_id, mcp_name, key
  vault_secret_id   → Supabase Vault

threads             專案裡的對話串（一個專案可有多串）
  id, project_id, title

runs                一次「使用者發問 → 最終回覆」
  id, thread_id
  status            'running' | 'succeeded' | 'failed'
  error, started_at, finished_at

messages            所有發言
  id, thread_id, run_id
  speaker_instance_id   null 代表使用者
  kind              'user' | 'final' | 'delegation' | 'discussion'
  round             討論的第幾輪，只有 kind = 'discussion' 才有
  content           text    純文字內容，用來組對話歷史、搜尋
  ui_message        jsonb   AI SDK 的 UIMessage，只有 'user' 和 'final' 才存；前端顯示歷史紀錄用
  tool_events       jsonb   這則發言期間用過的工具

memories            agent 記憶
  id, project_id
  instance_id       null = 專案共用記憶；有值 = 該 agent 的私有記憶
  content           text
  created_by_instance_id

usage_events        模型用量帳本（只記錄，不計費）
  id, run_id, project_id, instance_id
  template_id, creator_id     冗餘存一份，之後算分潤不必回查
  model
  prompt_tokens, output_tokens, cached_tokens, thought_tokens
  created_at
```

### 3.1 設計決定

1. **啟用時存快照，不引用範本。** 創作者之後修改範本，不影響已啟用的 agent，MVP 不需要版本管理。skill zip 以內容雜湊命名、上傳後不再覆蓋，實例可以一直指向它。
2. **skill 和 MCP 存成 JSONB 欄位，不拆子表。** 複製時一行搞定，MVP 也不需要對它們做查詢。
3. **對話歷史只用「使用者訊息 + 最終回覆」。** 每次 run 從 `messages` 撈出 `kind in ('user','final')` 當歷史，不重播工具呼叫細節。顧問每次被派工都從頭開始，只拿到任務、記憶和 `/shared` 檔案。Sprite 記憶體裡不保留任何狀態。
4. **主管也是一筆 `agent_instances`（`role = 'manager'`）。** 專案有 2 位以上顧問時才自動建立，讓主管也有自己的記憶，發言紀錄的結構也一致。
5. **前端歷史用 `ui_message` 渲染。** 這樣即時串流和重新整理後看到的畫面，用的是同一種資料結構（UIMessage），包括可展開的顧問發言。

### 3.2 RPC

`hire_agent(project_id, template_id, secrets jsonb)`：在同一個交易裡完成以下三件事，任一步失敗就整個撤銷：

1. 從範本複製快照到 `agent_instances`。
2. 把每個金鑰存進 Vault，並寫入 `instance_secrets`。
3. 如果這是專案裡的第 2 位顧問，同時建立主管。

## 4. Vercel API

| 用途 | Route |
|---|---|
| 範本 | `GET/POST /api/templates`、`GET/PATCH /api/templates/:id`、`POST /api/templates/:id/publish`、`POST /api/templates/:id/upload-url` |
| 專案 | `GET/POST /api/projects`、`GET/DELETE /api/projects/:id`、`POST /api/projects/:id/provision`（重試建立 Sprite） |
| 啟用 | `POST /api/projects/:id/agents`（伺服器端呼叫 `hire_agent`） |
| 檔案 | `POST /api/projects/:id/files/upload-url`、`GET /api/projects/:id/files` |
| 對話 | `GET/POST /api/projects/:id/threads`、`GET /api/threads/:id/messages`、`POST /api/threads/:id/chat`（轉送串流）、`GET /api/runs/:id` |
| 記憶 | `GET/PATCH/DELETE /api/projects/:id/memories` |

- **上傳一律用 Supabase Storage 的簽名網址。** Vercel 函式的請求內容上限是 4.5 MB，所以由 Vercel 發一個短效、限定路徑的上傳網址，瀏覽器直接上傳到 Storage。
- **建議用 Vercel Pro。** 函式最長 800 秒（Hobby 只有 300 秒），大部分討論都能完整串流；超過時的處理見 §7。

## 5. 主要流程

### 5.1 創作者上架

1. 創作者在表單填名稱、介紹、system prompt，`POST /api/templates` 建立一筆 `draft` 範本。
2. 呼叫 `POST /api/templates/:id/upload-url` 取得簽名網址，瀏覽器直接把 skill zip 上傳到暫存路徑 `skills/<template_id>/upload.zip`。
3. 呼叫 `PATCH /api/templates/:id`，**由伺服器端下載並驗證 zip**：
   - 每個含 `SKILL.md` 的資料夾算一個 skill。
   - 從檔案開頭的 frontmatter 讀出 `name`、`description`，缺任何一個就整份退回，並逐一列出哪個資料夾、缺了什麼。
   - 驗證通過後，計算 sha256，把檔案搬到 `skills/<template_id>/<sha256>.zip`，更新 `skills_zip_path` 和 `skills`。
4. MCP 逐筆新增：stdio（`command` + `args`）或 http（`url` + `headers`），再宣告需要的金鑰。
5. 存成 `draft`。按「上架」後改成 `published`。

### 5.2 建立專案（`POST /api/projects`）

1. 寫入 `projects`，`sprite_status = 'provisioning'`。
2. 用 `@fly/sprites` 建立 Sprite，網址維持私有。
3. Vercel 產生 `runtime/<版本>.tgz` 的短效簽名下載網址（Sprite 此時還沒有任何憑證），在 Sprite 裡下載並安裝，再寫入環境變數檔：
   - `SUPABASE_URL`、`SUPABASE_SECRET_KEY`
   - `VERTEX_API_EXPRESS_MODE_KEY`
   - `PROJECT_ID`
4. 把 runtime 註冊成 Sprite 的常駐服務，監聽 port 8080。
5. `/health` 回應成功 → `ready`；失敗 → `error`，原因寫入 `sprite_error`。
6. 前端每幾秒查一次狀態，等待時顯示「準備中」（預估 30–60 秒）。
7. `POST /api/projects/:id/provision` 可以重複執行：Sprite 存在就只重跑第 3–5 步，不存在就從第 2 步開始。

### 5.3 一鍵啟用（`POST /api/projects/:id/agents`）

1. 使用者在市集按「啟用」，選要加入的專案，再填入該 agent 需要的 MCP 金鑰。
2. Vercel 確認使用者擁有該專案，然後呼叫 `hire_agent`（§3.2）。
3. 不需要通知 Sprite，下次對話開始時 runtime 會自己同步。

### 5.4 一次對話（`POST /api/threads/:id/chat`）

```
Vercel：
  1. 確認使用者擁有這串對話所屬的專案，且 sprite_status = 'ready'
  2. 轉送到 <sprite_url>/chat（帶 Sprite token），只送 { thread_id, 使用者這次的訊息 }，
     把回應串流原樣回傳給瀏覽器。
     Sprite 剛從深眠醒來時，服務可能還沒開始監聽 → 連線被拒就等 1 秒重試，最多 3 次

Sprite runtime：
  3. 確認 thread 屬於自己的 PROJECT_ID；同一串已有 running 的 run → 回 409
  4. 寫入使用者 message，建立 run（running）
  5. 向 Sprites Tasks API 登記「工作中」（有效 5 分鐘，每 2 分鐘更新）
  6. 同步：
       - 讀取專案目前的 agent_instances
       - 各 agent 的 skills/ 不存在或版本不符 → 從 Storage 下載解壓
       - Storage 的 project-files/<project_id>/ → 同步到 /shared
       - 讀取 MCP 金鑰
  7. 組裝 agent：
       - 1 位顧問 → 根 agent 就是這位顧問
       - 2 位以上 → 根 agent 是主管，工具有 assign_task、convene_discussion
  8. agent.stream(...)，以 AI SDK UI message stream 回傳
  9. 每一步結束（onStepFinish）→ 寫 usage_events
 10. 完成 → 寫入 final message（含 ui_message），run 改 succeeded，取消「工作中」登記
     失敗 → run 改 failed 並記錄 error，取消「工作中」登記
```

前端用 `useChat` 接這支 API，並用 `prepareSendMessagesRequest` 只送出最後一則使用者訊息。`useChat` 預設會送整串 messages，但歷史由 runtime 從 DB 讀取，不需要重複傳。派工與討論的工具結果，渲染成可展開的「顧問發言」區塊。

**瀏覽器中途斷線：** Sprite 上的 run 照樣跑完（因為有「工作中」登記）。重新整理後，前端從 `/api/threads/:id/messages` 讀取已有訊息；若 run 仍在進行，就每幾秒查一次 `/api/runs/:id`，完成後重新讀取。MVP 不做斷線後接回串流。

### 5.5 派工（主管的 `assign_task` 工具）

1. 主管指定顧問並寫出任務說明。
2. 工具的 `execute` 是 async generator，呼叫 `runConsultant()`：
   - 顧問在自己的工作目錄從頭開始執行，看得到 `/shared`。
   - 每 200ms 最多 `yield` 一次顧問「到目前為止」的 UIMessage，讓前端即時顯示。
3. `toModelOutput` 只把顧問的最後一段文字交給主管，主管的脈絡不會被顧問的過程塞滿。
4. 完成後寫入一筆 `kind = 'delegation'` 的 message。

### 5.6 主持人式討論（主管的 `convene_discussion` 工具）

輸入：題目、參與的顧問、最多幾輪（上限 3）。

1. **第 1 輪同時進行**：每位顧問只拿到題目和專案檔案，各自寫出獨立意見。這時互相看不到，避免被前面的發言帶著走。
2. **第 2 輪起輪流發言**：每位顧問讀完目前的完整討論紀錄，回應、反駁或修正自己的看法，最後一行標記 `立場：同意` 或 `立場：有保留`。
3. **何時結束**：某一輪所有人都標「同意」，或已經達到最大輪數。
4. **即時顯示**：工具 `yield` 的是「每位顧問目前發言」的整體快照，第 1 輪就是多條串流合併成一個快照。每 200ms 最多 yield 一次。
5. **寫入紀錄**：每次發言寫入一筆 `kind = 'discussion'` 的 message，記錄是第幾輪。
6. **交回主管**：`toModelOutput` 把完整的討論紀錄文字交給主管。主管依固定格式產出總結：
   - 各面向的建議（例如法務、工程、財務）
   - 已達成共識的方案
   - 仍有分歧的地方，明確列出，不假裝大家都同意
7. **成本參考**：3 位顧問 × 3 輪，大約 9 次顧問呼叫加上幾次主管呼叫。

### 5.7 專案檔案

1. 呼叫 `POST /api/projects/:id/files/upload-url` 取得簽名網址，直接上傳到 Storage 的 `project-files/<project_id>/`。
2. 每次 run 開始時，runtime 把 Storage 的檔案同步到 `/shared`，並把檔案清單寫進每個 agent 的 prompt。

## 6. Agent runtime

### 6.1 為什麼用 Vercel AI SDK，不用 Google ADK

- ADK 的 `AgentTool` 只把子 agent 的**最終回應**交回給上層，內層過程不會出現在主管的事件流裡；前端看不到顧問正在做什麼。
- AI SDK 有官方的子 agent 做法：工具的 `execute` 寫成 async generator，搭配 `readUIMessageStream` 把子 agent 的完整過程推給前端，再用 `toModelOutput` 控制模型只看到結論。
- ADK 的其他優勢（`ParallelAgent`/`LoopAgent`、Session/Memory Bank 服務）在本設計中都沒用到：討論流程自己寫、資料存在 Supabase。
- AI SDK 的 UI message stream 可以直接給前端 `useChat` 使用，前後端格式一致；也不綁定模型商。

### 6.2 模組

```
packages/runtime/src/
  server.ts            HTTP 服務：POST /chat、GET /health；驗證 Sprite token 由 Sprite 平台處理
  run.ts               一次 run 的完整流程（§5.4 第 3–10 步）
  sync.ts              同步各 agent 的 skills/ 和 /shared
  agents/build.ts      依 agent_instances 組出 ToolLoopAgent
  agents/prompts.ts    主管 prompt、總結格式、記憶規則說明
  consultant.ts        runConsultant()：派工與討論共用
  tools/bash.ts        執行指令
  tools/files.ts       read_file / write_file
  tools/memory.ts      remember / recall
  tools/delegate.ts    assign_task
  tools/discuss.ts     convene_discussion
  mcp.ts               依設定建立 MCP client、代入金鑰
  keepalive.ts         Tasks API 的「工作中」登記與定期更新
  usage.ts             寫 usage_events
```

### 6.3 Agent 組成

| | 顧問 | 主管 |
|---|---|---|
| 模型 | `createVertex({ apiKey })('gemini-3.8-flash')`（express mode） | 同左 |
| system prompt | 創作者的 prompt + 記憶區塊 + skill 清單 + `/shared` 檔案清單 + 工作目錄說明 | 內建主管 prompt + 記憶區塊 + 顧問名單與專長 + 總結格式 |
| 工具 | `bash`、`read_file`、`write_file`、`remember`、`recall`、它自己的 MCP 工具 | `read_file`、`remember`、`recall`、`assign_task`、`convene_discussion` |
| 工作目錄 | `/agents/<實例id>/`，可讀寫 `/shared` | 不需要 |
| 步數上限 | `stopWhen: stepCountIs(30)` | 同左 |

- **skill**：prompt 只列出每個 skill 的名稱和說明，以及 `SKILL.md` 的路徑；agent 需要時再用 `read_file` 讀完整內容（跟 Claude Code 的漸進式載入相同）。
- **MCP**：用 `@ai-sdk/mcp` 的 `createMCPClient`。
  - http：`url` + `headers`，`${KEY}` 換成租用者的金鑰。
  - stdio：用 `command` + `args` 啟動，金鑰放進環境變數，工作目錄是該 agent 的目錄。
  - 每次 run 開始時啟動 MCP，run 結束時關閉。
- **記憶**
  - run 開始時，把最近 50 筆記憶（私有 + 專案共用）放進 prompt。
  - `recall(關鍵字)` 用 `ILIKE` 搜尋全部記憶。
  - `remember(內容, 'private' | 'project')` 寫入一筆。
  - prompt 中規定：**只記使用者明確說過的事實與偏好**；討論和派工的內容不寫入記憶。

### 6.4 執行規則

- **每串對話同時只能有一個 run**，第二個請求回 409。不同對話串可以同時進行。
- **安全上限**：
  - 每個 agent 一次呼叫最多 30 步。
  - 討論最多 3 輪。
  - 一個 run 最長 15 分鐘，用 AbortController 中斷。
  - `bash` 單次 120 秒逾時，輸出超過 20 KB 截斷。
- **模型重試**：AI SDK `maxRetries: 3`。
- **「工作中」登記**：有效 5 分鐘、每 2 分鐘更新；runtime 崩潰時會自動過期，Sprite 可以正常休眠。
- **啟動清理**：runtime 每次啟動時，把本專案所有 `running` 的 run 改成 `failed`，原因寫「runtime 重啟」。

### 6.5 部署與更新

1. esbuild 打包成 tarball，上傳到 Storage 的 `runtime/<版本>.tgz`。
2. 建立專案時，Sprite 下載指定版本並安裝（§5.2）。
3. 更新時跑 `scripts/` 裡的管理腳本，逐一讓每台 Sprite 下載新版並重啟服務。

## 7. 錯誤處理

| 情境 | 處理方式 |
|---|---|
| 建立 Sprite 失敗 | `sprite_status = 'error'` + `sprite_error`。前端顯示「重試」，呼叫 `POST /api/projects/:id/provision` |
| 對話時連不上 Sprite | 先等 1 秒重試，最多 3 次（涵蓋深眠喚醒時服務還沒起來的情況）。仍失敗才由 Vercel 回錯誤，前端顯示「agent 環境無法連線」和重試按鈕。此時還沒建立 run |
| Gemini 429／5xx | 自動重試 3 次。仍失敗 → run failed，已產生的發言保留，前端顯示錯誤 |
| MCP 啟動失敗 | 不讓 run 失敗：跳過這個 MCP，在 prompt 告知 agent「X 目前無法使用」，前端顯示警告 |
| 工具執行出錯 | 錯誤內容當成工具結果交給模型，由模型決定下一步，不拋出例外 |
| 派工時顧問失敗 | `assign_task` 回傳錯誤說明，由主管決定重派或告訴使用者 |
| 討論中某位顧問失敗 | 該輪標記「未發言」，討論繼續；全部失敗才中止 |
| run 超過 15 分鐘 | AbortController 中斷，標成 failed |
| runtime 崩潰，run 卡在 running | runtime 重啟時清理（§6.4）；`/api/runs/:id` 也把超過 20 分鐘的 running 當成失敗 |
| Vercel 串流被時間上限切斷 | 前端改成輪詢 `/api/runs/:id`，完成後重新讀取訊息 |
| skill zip 格式不對 | 上架時擋下，逐一列出哪個資料夾缺了什麼 |
| Storage 同步失敗 | run 一開始就失敗，錯誤訊息寫明是哪個檔案 |

## 8. 測試

1. **單元測試（Vitest）**
   - skill zip 解析與驗證。
   - MCP 設定的金鑰代入（`${KEY}`）。
   - 討論結束條件：立場解析、最多 3 輪、有人失敗時的處理。
   - 從 `messages` 組出對話歷史。
   - `remember` / `recall`。
2. **整合測試**
   - 本機跑 runtime（不用 Sprite），接雲端 Supabase 開發專案，用 AI SDK 的 mock 模型取代 Gemini。資料庫測試用 pgTAP 在雲端執行（`supabase test db --linked`）。
   - 情境：單一顧問、主管派工、召開討論。
   - 驗證：串流內容、`messages` 與 `usage_events` 寫入、run 狀態。
3. **真實環境冒煙測試**（手動執行，不進 CI）：腳本依序建專案、啟用 3 個金融 agent、問一個需要討論的問題，確認 run 成功且有總結。

## 9. 已知風險

- Gemini 3.x 沒有亞洲區域，只能走 `global` 端點，從台灣呼叫有額外延遲。
- Sprite 不能指定區域，由 Fly 決定擺放位置。
- 第一次用 `npx` 啟動 stdio MCP 需要下載套件。Demo 前要先把每個 agent 跑過一次，讓快取先建好。
- `@fly/sprites` 仍是 0.2 版，API 可能變動。
- Vercel 函式預設跑在 `iad1`（美東）。專案的函式區域要改成東京或新加坡，縮短「台灣 → Vercel → Sprite」這條鏈的延遲。
- AI SDK 的 stdio MCP transport 標示為實驗性。
- Vercel 文件寫明函式的「請求或回應內容」上限是 4.5 MB，但沒說明串流回應是否同樣受限。派工與討論的工具每次 yield 都送出完整快照，長討論的總串流量可能很大。若碰到上限，串流被切斷後前端會改用輪詢（§7），不會遺失結果；之後可改成只送增量內容。
- 安全性刻意不處理（見 §10），**不可在此狀態下對外開放、放真實客戶的機密資料**。

## 10. 不在 MVP 範圍

- **金錢**：金流、分潤撥款。用量帳本已經在記錄。
- **資安**：
  - 每個 agent 一個 Unix 帳號（目前只有各自的工作目錄）。
  - 金鑰與 agent 指令分開存放（目前 Gemini 金鑰、service role key 都在 runtime 環境變數，agent 的 bash 可以讀到）。
  - 對外連線白名單。
  - 上架審核。
  - 細緻的 RLS 規則。
  - 限流。
- **創作者**：MCP 的 OAuth、從 GitHub 匯入、不會寫程式的建構流程、範本版本管理與更新推送。
- **市集**：評價、搜尋與排序。
- **專案**：從專案移除 agent、多人共用專案。
- **協作**：自由式 agent 討論。
- **體驗**：斷線後接回串流、記憶向量搜尋（pgvector）。
- **維運**：runtime 自動更新、同一台 Sprite 上多個 run 同時修改同一檔案的衝突處理。

## 附錄：查證來源（2026-10-01 ～ 10-02）

| 事實 | 來源 |
|---|---|
| Sprites API、checkpoint 不能複製到新 Sprite | https://docs.fly.io/sprites/api/openapi.json、https://community.fly.io/t/sprites-clone-sprite/26728 |
| 有開著的 TCP 連線，Sprite 就不會休眠；閒置後淺眠 / 深眠 | https://docs.fly.io/sprites/concepts/lifecycle |
| Services 與 Tasks API（單次最長 1 小時，需定期更新） | https://docs.fly.io/sprites/keeping-sprites-running |
| 私有網址用 `Authorization: Bearer <org token>` | https://docs.fly.io/sprites/cli/commands |
| Gemini 3.x 只有 `global` / `us` / `eu` 端點 | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models |
| AI SDK 子 agent 串流（generator + `toModelOutput`） | https://ai-sdk.dev/docs/agents/subagents |
| AI SDK MCP client（`@ai-sdk/mcp`） | https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools |
| ADK `AgentTool` 只回傳最終回應 | https://adk.dev/agents/custom-agents/index |
| Vercel 函式時間上限：Hobby 300 秒、Pro 800 秒；請求／回應內容上限 4.5 MB；預設區域 `iad1` | https://vercel.com/docs/functions/limitations |
| Sprite 預設映像檔內建 Node.js、Python、Bun 等 | https://docs.fly.io/sprites/working-with-sprites |

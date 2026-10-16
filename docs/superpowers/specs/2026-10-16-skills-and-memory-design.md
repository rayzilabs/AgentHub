# Skill 載入與記憶：改成 Claude Code 的做法

日期：2026-10-16

## 1. 為什麼要改

目前顧問的 skill 與記憶都只做到最小可用：

- **skill**：system prompt 列出名稱、說明與 `SKILL.md` 路徑，再加一句「先用 read_file 讀它」。模型（Gemini）常常不讀就回答；`read_file` 超過 20000 字元截斷；`$ARGUMENTS`、`` !`指令` ``、skill 所在資料夾等 Claude Code 的寫法都不支援。創作者在 Claude Code 寫好、測好的 skill 上傳後行為不同。
- **記憶**：`remember` 只能新增一句話、`recall` 用關鍵字搜尋。模型不能修改或刪除記憶，過時的記憶會和新的並存（例如「偏好保守」和「偏好積極」同時出現在 prompt）；沒有分類，最近 50 筆以外的記憶要靠模型主動搜尋。

目標是讓這兩件事的**行為**和 Claude Code 一致：創作者照 Claude Code 的格式寫的 skill 可以直接用，記憶的組織方式（一筆一件事、有名稱與說明、索引常駐、可更新與刪除）也照 Claude Code。

## 2. 目標與不做的事

**目標**

1. 顧問有專用的 `skill` 工具，載入方式、回傳內容、參數替換與 Claude Code 相同。
2. 上架時依 Agent Skills 規格檢查 `name`、`description`，讓在 Claude Code 能用的 skill 一定能上架。
3. 記憶改成「一筆一件事」：名稱、一行說明、類型、內容；prompt 只放索引，內容按需讀取；模型可以新增、更新、刪除。
4. 使用者在工作區記憶面板仍可查看、修改、刪除記憶。

**不做**

- 使用者在對話框打 `/skill-name` 直接呼叫 skill（多顧問時要決定交給誰，另案處理）。因此 `disable-model-invocation`、`user-invocable`、`argument-hint` 不處理。
- `allowed-tools`（Claude Code 用來免除權限詢問；我們沒有逐次權限詢問）、`model`、`context: fork`、`hooks` 欄位：上架時接受但忽略。
- 類似 `CLAUDE.md` 的「使用者寫給所有顧問的專案說明」。
- 跨輪保留工具呼叫紀錄、context 壓縮（另案）。
- 記憶之間的 `[[連結]]`。
- 跨專案的使用者記憶（Claude Code 的使用者層級記憶）：所有記憶都屬於單一專案，私有記憶屬於專案裡的顧問實例。

**失敗的定義**（就算技術上能跑也算失敗）

- 舊的記憶在遷移後不見或看不到。
- 顧問能讀到或改到別位顧問的私有記憶。
- skill 的 `` !`指令` `` 以 runtime 身分（而不是顧問的沙盒帳號）執行。

## 3. Skill

### 3.1 Claude Code 的行為（要對齊的對象）

- skill 清單（名稱 + 說明）常駐在 context；全文要透過 `Skill` 工具載入。
- 載入時回傳的內容開頭是 skill 所在資料夾（`Base directory for this skill: …`），接著是去掉 frontmatter 的本文。
- 本文裡的 `$ARGUMENTS` 換成呼叫時給的參數，`$ARGUMENTS[N]` 與 `$N` 換成第 N 個參數（從 0 起算）；本文沒有 `$ARGUMENTS` 而有參數時，在最後加上 `ARGUMENTS: <參數>`。`${CLAUDE_SKILL_DIR}` 換成 skill 資料夾。
- `` !`指令` `` 在內容交給模型前先執行，輸出取代原本的文字。
- 系統指示要求：工作和某個 skill 相符時，必須先載入 skill 再做其他事；同一段對話已載入的不重複載入。

### 3.2 上架檢查（`apps/web/lib/skills-zip.ts`）

在現有檢查之外加上：

- `name`：1–64 字元，只能是小寫英文字母、數字、連字號。
- `description`：最多 1024 字元。
- 錯誤訊息照現有格式，例如「`credit/SKILL.md`：name「Credit 5P」只能用小寫英文字母、數字和連字號（最多 64 字元）」。

`SkillMeta` 形狀不變（`name`、`description`、`path`）。已上架的範本不重新檢查。

### 3.3 `skill` 工具（runtime，新檔 `packages/runtime/src/tools/skill.ts`）

只給顧問；顧問沒有任何 skill 時不提供這個工具。

- 輸入：`{ name: string, args?: string }`。
- 說明（給模型看）：載入 skill 的完整說明。工作和「你的 skills」裡某個 skill 相符時，必須先呼叫這個工具，再開始回答或使用其他工具；同一次對話已經載入過的 skill 不要重複載入。
- 執行：
  1. 依 `name` 在 `instance.skills` 找；找不到時回傳錯誤，列出可用名稱。
  2. 讀 `<skillsDir>/<path>/SKILL.md`，去掉 frontmatter。
  3. 依 3.1 替換 `${CLAUDE_SKILL_DIR}`、`$ARGUMENTS[N]`、`$N`、`$ARGUMENTS`。參數以空白切分，雙引號包住的視為一個參數。
  4. 執行每個 `` !`指令` ``：用顧問的沙盒帳號（與 `bash` 工具同一個 `Sandbox`），工作目錄是 skill 資料夾，單次 30 秒；輸出（stdout + stderr，去頭尾空白）取代原文字；失敗時換成 `[指令失敗：<原因>]`，不讓整個工具失敗。
  5. 回傳 `{ content }`：第一行「這個 skill 的資料夾：<絕對路徑>（SKILL.md 裡的相對路徑都以這裡為準）」，空一行接本文。超過 60000 字元截斷並註明。

### 3.4 system prompt（`packages/runtime/src/agents/prompts.ts`）

「你的 skills」一節改成：

```
## 你的 skills
- credit-5p：授信五 P 審查清單：…
- ratio-check：授信常用財務比率的公式與參考門檻…
工作內容和上面某個 skill 相符時，這是必要步驟：先用 skill 工具載入它，再開始回答或使用其他工具。不要只憑名稱和說明猜內容。
```

不再列 `SKILL.md` 路徑。skill 的其他檔案仍可用 `read_file`、`bash` 存取。

### 3.5 前端

`apps/web/lib/progress.ts` 的 `TOOL_LABELS` 加 `skill: '載入 skill'`。派工卡片的步驟說明照現有機制顯示。

## 4. 記憶

### 4.1 Claude Code 的行為（要對齊的對象）

- 一筆記憶一件事，有 `name`（短代號）、`description`（一行說明，用來判斷是否相關）、`type`（user／feedback／project／reference）和內容。
- context 裡常駐的是索引（名稱 + 說明），需要細節時再讀內容。
- 模型自己新增、更新、刪除；存之前先看有沒有相同主題的記憶，有就更新，不要重複；發現錯的就刪。
- feedback 與 project 類的內容寫成「事實」＋「**為什麼：**」＋「**怎麼用：**」。
- 相對日期轉成絕對日期；能從檔案或對話本身得知的東西不要記。

### 4.2 資料表（新 migration）

`memories` 新增欄位：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | `text not null` | 1–64 字元，不含換行 |
| `description` | `text not null` | 1–200 字元 |
| `type` | `text not null` | `user`、`feedback`、`project`、`reference` |

- 內容 `content` 加長度上限 5000 字元（check constraint）。
- 唯一：`unique nulls not distinct (project_id, instance_id, name)`；私有記憶（`instance_id` = 顧問）與專案共用記憶（`instance_id` 為 null）是不同的名稱空間。
- 既有資料回填：`name = 'memory-' || left(id::text, 8)`，`description` = `content` 去掉換行後的前 100 字元，`type = 'user'`。回填後才加 `not null` 與唯一限制。
- 依 `updated_at desc` 排序的索引取代現有的 `(project_id, created_at desc)`。

### 4.3 runtime 權限（`docs/security-model.md` 第 4 節先改，再寫 migration）

`memories` 一列改成：

| 資料 | 讀 | 新增 | 修改 | 刪除 | 限制 |
|---|---|---|---|---|---|
| `memories` | ✅ | ✅ | 只能改 `content`、`description`、`type`、`updated_at` | ✅ | 自己專案。顧問之間的私有記憶隔離由 runtime 的程式負責（同一專案的顧問共用一個 runtime 帳號） |

- grant select 加上 `name`、`description`、`type`、`updated_at`；grant insert 加上 `name`、`description`、`type`。
- 新增 `grant update (content, description, type, updated_at)` 與 `grant delete`，policy 條件都是 `project_id = runtime_project()`。
- `supabase/tests/runtime_access.sql` 加斷言：能改、能刪自己專案的記憶；改不到、刪不到別的專案；不能改 `name`、`instance_id`、`project_id`。

### 4.4 記憶工具（`packages/runtime/src/tools/memory.ts`，取代 `remember`、`recall`）

顧問與主管都有。下表的「看得到」指：自己的私有記憶＋專案共用記憶。

| 工具 | 輸入 | 行為 |
|---|---|---|
| `memory_write` | `name`、`scope`（`private`／`project`）、`type`、`description`、`content` | 同一 scope 已有同名記憶就更新 `content`、`description`、`type`、`updated_at`；沒有就新增。回傳 `{ ok, action: 'created' \| 'updated' }`。不用 upsert（runtime 沒有改 `name` 等欄位的權限），先查再寫；新增撞到唯一限制時改成更新 |
| `memory_read` | `names: string[]`（1–10 個） | 回傳看得到的同名記憶全文（同名的私有與專案記憶都回傳，標明 scope）；找不到的名稱列在 `missing` |
| `memory_delete` | `name`、`scope` | 刪除；不存在時回傳錯誤 |

專案共用記憶任何一位 agent 都能更新或刪除；私有記憶只有擁有者能動（查詢與寫入一律加 `instance_id` 條件）。

### 4.5 system prompt 的記憶一節

run 開始時撈看得到的記憶，依 `updated_at desc` 取前 200 筆，放進 prompt：

```
## 記憶
以下是記憶索引。需要細節時用 memory_read 讀內容。
- [專案/user] user-profile — 使用者是科技業工程師，年收約 200 萬
- [私有/feedback] report-style — 報告先給結論再給數字
（還有 12 筆較舊的記憶沒有列出，可以用 memory_read 依名稱讀取）   ← 只有超過 200 筆時
```

接著是記憶規則（照 Claude Code 改寫，並保留原規格「只記使用者明確說過的事」的決定）：

- 記憶分四類：user（使用者是誰：角色、背景、偏好）、feedback（使用者對你工作方式的指示，包含糾正與認可）、project（這個專案進行中的事實、目標、限制、期限）、reference（外部資源的位置）。
- 只記使用者明確說過的事實、偏好與指示。你自己或其他 agent 推論出的內容、派工與討論的內容不要記。
- 寫之前先看索引有沒有相同主題的記憶，有就用同一個名稱更新，不要新增重複的；發現記憶錯了或過時就更新或刪除。
- 一筆記憶一件事。名稱用簡短的英文小寫加連字號；說明寫一行，讓之後看索引就能判斷相不相關。
- feedback 與 project 類的內容寫成：事實，接著「為什麼：」與「怎麼用：」各一行。
- 「明天」「下週」這類相對日期換成絕對日期。
- 能從專案檔案或這次對話直接得知的東西不要記。

### 4.6 網站

- `listMemories` 多回傳 `name`、`description`、`type`、`updated_at`，依 `updated_at desc` 排序。
- `PATCH /api/projects/:id/memories` 可改 `content` 與 `description`（都選填，至少一個）。
- 記憶面板每筆顯示：歸屬（顧問名或「整個專案共用」）、類型、說明（粗體）、內容；修改時可改說明與內容。提示文字改成「顧問會記下你說過的事實、偏好與指示，並自己更新；你也可以修改或刪除。」
- `TOOL_LABELS`：移除 `remember`、`recall`，加 `memory_write: '寫入記憶'`、`memory_read: '讀取記憶'`、`memory_delete: '刪除記憶'`。舊訊息裡的 `remember`／`recall` 步驟會顯示工具原名，可以接受。

## 5. 部署順序

舊 runtime 的 `remember` 只寫 `content`；migration 加上 `not null` 後舊 runtime 的寫入會失敗（工具回傳錯誤，對話不會中斷）。只有一個雲端資料庫，記憶相關的測試要等 migration 推上去才能跑，所以這段空窗從推 migration 一直延續到 runtime 重新部署：把 migration 放在 skill 相關工作之後才推，推完就接著做記憶的程式碼，盡快完成部署。

1. `pnpm db:push` → `pnpm db:test`（實作途中）。
2. `pnpm test`、`pnpm typecheck` 通過。
3. `publish-runtime` → `redeploy-runtime.ts`。
4. push `main`（網站）。
5. 冒煙測試；Demo 專案問一題用到 skill 的問題，確認顧問有呼叫 `skill`。

## 6. 測試

- web：`skills-zip.test.ts` 加 name 格式與 description 長度；`threads.test.ts` 的記憶測試改用新欄位，加 PATCH description。
- runtime：
  - `skill.test.ts`：去 frontmatter、資料夾路徑、`$ARGUMENTS`／`$N`／`$ARGUMENTS[N]`／無佔位時附加、`${CLAUDE_SKILL_DIR}`、`` !`指令` `` 成功與失敗、找不到名稱、截斷。
  - `memory.test.ts`：新增與同名更新、私有隔離（別人的私有記憶讀不到、改不到、刪不到）、專案記憶任何人可改、`memory_read` 的 `missing`、索引超過上限時的提示。
  - `build.test.ts`、`prompts.test.ts`、`runtime-access.test.ts` 跟著改工具名稱與 prompt。
- pgTAP：`runtime_access.sql` 依 4.3；`schema.test.sql` 檢查新欄位與唯一限制。

## 7. 交給實作者決定

- `` !`指令` `` 的比對規則細節（只要和 Claude Code 文件的寫法相容）。
- 參數切分的引號處理細節。
- 記憶面板的版面細節（沿用現有 `.panel` 樣式）。

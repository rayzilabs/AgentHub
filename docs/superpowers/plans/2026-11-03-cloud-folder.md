# 雲端資料夾與顧問交付檔案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顧問用「交付檔案」工具把成品放進使用者的雲端資料夾。使用者在對話裡直接下載，也能在專案側欄與「我的雲端」管理檔案，所有顧問透過 `/workspace/shared` 讀得到同一批檔案。

**Architecture:** 新增 `project_folders`、`project_files` 兩張表，檔案的身分是 id，storage 路徑固定為 `<專案id>/files/<檔案id>`，改名與搬移只改資料表。runtime 以專案通行證上傳到自己專案的 `files/` 底下，再呼叫 security definer 函式 `deliver_project_file` 登記（建資料夾、同名加序號）。每次 run 前依資料表把整棵樹同步到 `/shared`。網站用 service role 做所有使用者操作。

**Tech Stack:** Next.js（apps/web）、Vercel AI SDK `ai`（packages/runtime）、Supabase（Postgres＋Storage）、Vitest（兩邊都連真的 Supabase）。

**Spec:** `docs/superpowers/specs/2026-11-03-cloud-folder-design.md`

## Global Constraints

- 單檔上限 50 MB：`project-files` bucket 的 `file_size_limit = 52428800`；交付工具也先檢查。
- 同一次 run 交付總量上限 200 MB（`RUN_DELIVERY_LIMIT_BYTES = 200 * 1024 * 1024`）。
- 檔名與資料夾名：1～100 字元，不能有 `/`、`\`、控制字元，不能是 `.` 或 `..`。中文、空白都可以。
- storage 路徑：新檔案一律 `<專案id>/files/<檔案id>`。
- 檔案一定在某個資料夾裡（`folder_id not null`），專案根目錄只有資料夾。
- 使用者上傳的預設資料夾叫「我上傳的」，在根目錄。
- 顧問的資料夾在根目錄，名稱是顧問名稱經 `safe_entry_name` 處理後的結果。顧問只能交付到自己的資料夾底下。
- 自動加序號的格式：`週報.docx` → `週報 (2).docx` → `週報 (3).docx`；沒有副檔名就是 `README (2)`。只用在上傳與交付；使用者自己改名或搬移撞名時回 409。
- 介面文字：`檔案已刪除`、`這個資料夾已經有同名檔案`、`不能把資料夾搬進自己裡面`、刪除確認 `確定要刪除「{名稱}」？刪除後無法復原。`、刪資料夾確認 `確定要刪除「{名稱}」和裡面所有檔案？刪除後無法復原。`
- 下載連結：每次按才產生，有效 60 秒，帶 `download: 原檔名`。
- 所有網站端檔案操作都先過 `getOwnProject`（不是擁有者回 404）。
- migration 要能重複執行（`if not exists`、`drop policy if exists`），由使用者貼到 Dashboard SQL Editor 套用。**套用前跑不了任何連資料庫的測試。**
- runtime 測試從 Git Bash 跑；Vitest teardown 會刪 `@test.local` 帳號，不要建這個網域的人工帳號。
- runtime 有改，publish-runtime 與 redeploy 所有 Sprite 前要先跟使用者確認。
- 不做：資源回收筒、版本歷史、zip 打包下載、線上預覽／編輯、匯出對話。

## Review Focus

1. **顧問在 `/shared` 裡把資料夾換成 symlink**（例如 `/shared/ETF 資金流顧問` → 某顧問的工作目錄）：runtime 以 sprite 帳號同步，不能跟著 symlink 寫到別處，要刪掉 symlink 重建成真的資料夾。→ Task 4 測試 `資料夾被換成 symlink 時不跟著寫`。
2. **兩位顧問在討論裡同時交付同名檔案到同一個子資料夾**（各自的資料夾不同，但同一位顧問的平行呼叫也可能撞）：兩個都要成功、名稱不同。→ Task 1 測試 `同時交付同名檔案都成功且加序號`。
3. **顧問名稱含 `/`、只有 `..`、或超過 100 字**：資料夾名稱要被淨化，交付不能失敗。→ Task 1 測試 `顧問名稱不合法時淨化成安全的資料夾名`。
4. **刪除含有顧問成品的資料夾**：storage 物件一起刪，舊對話的下載按鈕顯示「檔案已刪除」而不是 500。→ Task 2 測試 `刪資料夾連子孫檔案的 storage 一起刪`、`下載已刪除的檔案回 404`。
5. **改版前上傳的舊檔案**（`<專案id>/<檔名>`）：搬進新制後顧問照樣讀得到、使用者看得到，原本被 `storageFileName` 改成 `file_123.pdf` 的檔名照舊保留。→ Task 9 的搬移腳本測試 `舊檔案搬進「我上傳的」`。

---

### Task 1: 資料表、storage 權限與交付函式（migration）

**Files:**
- Create: `supabase/migrations/20261103000001_cloud_folder.sql`
- Modify: `apps/web/test/runtime-access.test.ts`（新增 describe）

**Interfaces:**
- Produces（資料表）：
  - `public.project_folders(id uuid pk default gen_random_uuid(), project_id uuid not null → projects on delete cascade, parent_id uuid null → project_folders on delete cascade, name text not null, created_at timestamptz default now())`，`unique nulls not distinct (project_id, parent_id, name)`，`check (public.is_entry_name(name))`
  - `public.project_files(id uuid pk, project_id uuid not null → projects on delete cascade, folder_id uuid not null → project_folders on delete cascade, name text not null, size bigint not null, content_type text not null, source text not null check in ('user','agent'), agent_instance_id uuid null → agent_instances on delete set null, run_id uuid null → runs on delete set null, created_at, updated_at timestamptz default now())`，`unique (folder_id, name)`，`check (public.is_entry_name(name))`，索引 `(project_id)`
- Produces（函式）：
  - `public.is_entry_name(text) returns boolean`（immutable）：符合 Global Constraints 的名稱規則
  - `public.safe_entry_name(text) returns text`：`/`、`\`、控制字元換成 `_`，截到 100 字；結果是空字串、`.` 或 `..` 時回 `顧問`
  - `public.numbered_name(p_name text, p_n int) returns text`：`週報.docx`, 2 → `週報 (2).docx`（副檔名是最後一個 `.` 之後，且 `.` 不在第一個字）
  - `public.ensure_folder(p_project_id uuid, p_parent_id uuid, p_name text) returns uuid`：有就回 id，沒有就建（處理併發的 unique_violation）
  - `public.register_project_file(p_project_id uuid, p_file_id uuid, p_folder_id uuid, p_name text, p_source text, p_instance_id uuid, p_run_id uuid) returns public.project_files`：從 `storage.objects`（bucket `project-files`、name `<專案>/files/<檔案id>`）讀 `metadata->>'size'`、`metadata->>'mimetype'`，物件不存在就 raise `'storage object missing'`；名稱撞到就用 `numbered_name` 從 2 開始試（unique_violation 時重試）；只給 service_role
  - `public.deliver_project_file(p_file_id uuid, p_instance_id uuid, p_subfolder text, p_name text, p_run_id uuid) returns table (id uuid, name text, folder text, size bigint)`（`folder` 是從根目錄起、以 `/` 連接的資料夾路徑，例如 `ETF 資金流顧問/2026-W43`，runtime 直接拿來組 `DeliveredFile`）：security definer；`runtime_project()` 是 null 就 raise `'not allowed'`；`p_instance_id` 必須是本專案的 consultant；根資料夾 `ensure_folder(專案, null, safe_entry_name(顧問名稱))`，`p_subfolder` 以 `/` 切開，每段都要 `is_entry_name`，逐層 `ensure_folder`；最後呼叫 `register_project_file(…, 'agent', …)`；給 authenticated
- Produces（權限）：
  - `update storage.buckets set file_size_limit = 52428800 where id = 'project-files'`
  - runtime（authenticated＋`runtime_project()`）：`project_folders`、`project_files` 只能 select 自己專案；不能 insert／update／delete（登記一律走 `deliver_project_file`）
  - storage policy `runtime_insert_project_files`：`for insert to authenticated with check (bucket_id = 'project-files' and name like public.runtime_project()::text || '/files/%')`；不給 update、delete

- [ ] **Step 1: 寫 migration**

開頭照 `20261016000001_memory_files.sql` 的格式寫註解（目的、規格路徑、可重複執行）。

- [ ] **Step 2: 請使用者在 Dashboard SQL Editor 套用 migration，確認沒有錯誤**

這一步要停下來等使用者。套用前不要跑後面的測試。

- [ ] **Step 3: 寫權限測試（`runtime-access.test.ts` 新增 `describe('雲端資料夾的 runtime 權限')`）**

沿用檔案裡的 `seedProject` 與 `asToken`。測試名稱與斷言：
- `runtime 只能上傳到自己專案的 files/ 底下`：`ra.storage.from('project-files').upload(`${a}/files/${uuid}`)` 成功；上傳到 `${b}/files/…`、`${a}/x.txt` 都有 error；對已上傳的物件 `upload(..., { upsert: true })` 有 error。
- `交付後資料表看得到、資料夾是顧問名稱`：上傳後 `ra.rpc('deliver_project_file', { p_file_id, p_instance_id: a.instanceId, p_subfolder: '2026-W43', p_name: '週報.docx', p_run_id: null })` 回傳的第一列 `name === '週報.docx'`、`folder === 'x/2026-W43'`；`ra.from('project_folders').select('name')` 含 `x`（seed 的顧問名）與 `2026-W43`。
- `同時交付同名檔案都成功且加序號`：上傳兩個物件，`Promise.all` 兩次 `deliver_project_file`（同子資料夾、同名 `週報.docx`），名稱集合是 `['週報.docx', '週報 (2).docx']`。
- `顧問名稱不合法時淨化成安全的資料夾名`：把 instance name 改成 `'../a/b'` 再交付，根資料夾名是 `'.._a_b'`；改成 `'..'` 時是 `'顧問'`。
- `不能替別的專案的顧問交付、不能直接寫資料表`：`p_instance_id: b.instanceId` 有 error；`ra.from('project_files').insert(...)` 的 `error.code === '42501'`。
- `子資料夾名稱不合法就拒絕`：`p_subfolder: '../x'` 有 error。
- `storage 物件不存在就拒絕`：沒上傳就 `deliver_project_file` 有 error。

- [ ] **Step 4: 跑測試**

Run: `pnpm --filter @agenthub/web test -- runtime-access`
Expected: 全部 PASS（migration 已套用）

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261103000001_cloud_folder.sql apps/web/test/runtime-access.test.ts
git commit -m "feat: 雲端資料夾的資料表、storage 權限與顧問交付函式"
```

---

### Task 2: 網站端檔案服務

**Files:**
- Modify（整個改寫）: `apps/web/lib/services/files.ts`
- Modify（整個改寫）: `apps/web/test/files.test.ts`

**Interfaces:**
- Consumes: Task 1 的資料表與 `register_project_file`、`ensure_folder`
- Produces（`lib/services/files.ts`，全部的 `db` 都是 service role 的 `Db`）：
  ```ts
  export const UPLOAD_FOLDER = '我上傳的';
  export type FolderRow = { id: string; parent_id: string | null; name: string };
  export type FileRow = { id: string; folder_id: string; name: string; size: number; content_type: string; source: 'user' | 'agent'; agent_instance_id: string | null; created_at: string; updated_at: string };
  export type ProjectTree = { folders: FolderRow[]; files: FileRow[] };
  export const entryName: z.ZodType<string>; // 名稱規則，錯誤訊息「名稱不能有 / 或 \，長度 1～100 字」
  export const storagePath = (projectId: string, fileId: string) => `${projectId}/files/${fileId}`;
  getProjectTree(db, userId, projectId): Promise<ProjectTree>
  createUploadUrl(db, userId, projectId): Promise<{ fileId: string; signedUrl: string }>
  completeUpload(db, userId, projectId, input: { fileId: string; folderId: string | null; name: string }): Promise<FileRow>
  updateFile(db, userId, projectId, fileId, input: { name?: string; folderId?: string }): Promise<FileRow>
  deleteFile(db, userId, projectId, fileId): Promise<void>
  createFolder(db, userId, projectId, input: { name: string; parentId: string | null }): Promise<FolderRow>
  updateFolder(db, userId, projectId, folderId, input: { name?: string; parentId?: string | null }): Promise<FolderRow>
  deleteFolder(db, userId, projectId, folderId): Promise<void>
  fileDownloadUrl(db, userId, fileId): Promise<{ url: string; name: string }>
  removeProjectStorage(db, projectId): Promise<void>
  ```
- 行為：
  - `completeUpload` 的 `folderId` 是 null 時放進 `ensure_folder(專案, null, UPLOAD_FOLDER)`；`folderId` 不屬於這個專案回 404。用 `register_project_file`（source `user`）。
  - `updateFile`／`updateFolder` 撞名（23505）回 409 `這個資料夾已經有同名檔案`；`updateFolder` 把資料夾搬到自己或子孫底下回 400 `不能把資料夾搬進自己裡面`。
  - `deleteFolder`：先收集子孫資料夾的所有檔案 id，刪 storage 物件，再刪資料夾列（cascade）。
  - `fileDownloadUrl`：檔案不存在或不是擁有者都回 404 `檔案已刪除`；`createSignedUrl(path, 60, { download: name })`。
  - `removeProjectStorage`：列出並刪掉 `<專案>/files/` 與 `<專案>/` 第一層（舊制檔案）的所有物件，分批 `remove`（每批最多 1000）。
  - `storageFileName` 刪掉（新制不再需要）；舊的 `listFiles`、`createFileUploadUrl` 刪掉。

- [ ] **Step 1: 寫失敗的測試（`files.test.ts`）**

輔助：`uploadVia(signedUrl, text)` 用 `fetch(PUT)` 上傳。測試名稱與斷言：
- `上傳到根目錄會放進「我上傳的」，中文檔名保留`：`completeUpload(..., { folderId: null, name: '財報 2026.pdf' })` 後，`getProjectTree` 的 folders 有 `我上傳的`，file name 是 `財報 2026.pdf`、size 等於上傳的位元組數。
- `同名上傳加序號`：上傳兩次 `brief.md`，名稱是 `brief.md`、`brief (2).md`。
- `改名撞名回 409、搬移成功`：`updateFile(name: 'brief.md')` 對第二個檔案 → status 409；`createFolder('封存')` 後 `updateFile(folderId)` 成功，tree 裡該檔案的 `folder_id` 是新資料夾。
- `資料夾不能搬進自己裡面`：A 底下建 B，`updateFolder(A, { parentId: B })` → status 400。
- `刪資料夾連子孫檔案的 storage 一起刪`：A/B 底下各一個檔案，`deleteFolder(A)` 後 tree 為空（除了「我上傳的」），`db.storage.from('project-files').list(`${p}/files`)` 沒有這兩個 id。
- `下載已刪除的檔案回 404`：`deleteFile` 後 `fileDownloadUrl` 的 `status === 404`、`message === '檔案已刪除'`；未刪前回傳的 `url` 用 `fetch` 拿得到內容。
- `別人的專案一律 404`：other 使用者呼叫 `getProjectTree`、`fileDownloadUrl` 都是 404。
- `entryName 擋掉不合法名稱`：`'a/b'`、`'..'`、`''`、101 字都 safeParse 失敗；`'週報 W43.docx'` 成功。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @agenthub/web test -- files`
Expected: FAIL（函式不存在）

- [ ] **Step 3: 實作 `lib/services/files.ts`**

- [ ] **Step 4: 跑測試確認通過**

Run: `pnpm --filter @agenthub/web test -- files`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/services/files.ts apps/web/test/files.test.ts
git commit -m "feat: 網站端雲端資料夾服務：資料夾樹、上傳、改名搬移、刪除、下載連結"
```

---

### Task 3: 檔案 API 與刪專案時清 storage

**Files:**
- Modify: `apps/web/app/api/projects/[id]/files/route.ts`（GET 回 tree，新增 POST＝completeUpload）
- Modify: `apps/web/app/api/projects/[id]/files/upload-url/route.ts`（不帶參數，回 `{ fileId, signedUrl }`）
- Create: `apps/web/app/api/projects/[id]/files/[fileId]/route.ts`（PATCH、DELETE）
- Create: `apps/web/app/api/projects/[id]/folders/route.ts`（POST）
- Create: `apps/web/app/api/projects/[id]/folders/[folderId]/route.ts`（PATCH、DELETE）
- Create: `apps/web/app/api/files/[fileId]/download/route.ts`（GET → `{ url, name }`）
- Modify: `apps/web/app/api/projects/[id]/route.ts`（DELETE：刪 Sprite 之後、刪專案列之前呼叫 `removeProjectStorage`）
- Test: `apps/web/test/projects.test.ts`

**Interfaces:**
- Consumes: Task 2 全部函式
- Produces（HTTP，全部用 `route()`＋`requireUser`＋`readJson`＋zod）：
  - `GET /api/projects/:id/files` → `ProjectTree`
  - `POST /api/projects/:id/files/upload-url` → `{ fileId, signedUrl }`
  - `POST /api/projects/:id/files` body `{ fileId: uuid, folderId: uuid | null, name: entryName }` → `FileRow`
  - `PATCH /api/projects/:id/files/:fileId` body `{ name?: entryName, folderId?: uuid }` → `FileRow`；`DELETE` → `{ ok: true }`
  - `POST /api/projects/:id/folders` body `{ name: entryName, parentId: uuid | null }` → `FolderRow`
  - `PATCH /api/projects/:id/folders/:folderId` body `{ name?: entryName, parentId?: uuid | null }`；`DELETE`
  - `GET /api/files/:fileId/download` → `{ url, name }`，404 `{ error: '檔案已刪除' }`

- [ ] **Step 1: 寫失敗的測試（`projects.test.ts` 新增）**

`刪除專案時刪掉 storage 裡的檔案`：建專案、上傳一個新制檔案、另外直接上傳一個舊制 `${p}/old.txt`，呼叫 `DELETE` route handler（同檔案裡其他 route 測試的呼叫方式），之後 `list(`${p}/files`)` 與 `list(p)` 都沒有物件。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @agenthub/web test -- projects`
Expected: FAIL（storage 還有物件）

- [ ] **Step 3: 實作所有 route 與刪專案的修改**

- [ ] **Step 4: 跑測試確認通過，並跑 typecheck**

Run: `pnpm --filter @agenthub/web test -- projects files && pnpm --filter @agenthub/web typecheck`
Expected: PASS；typecheck 只剩 `file-panel.tsx` 用到舊 API 的錯誤（Task 6 會換掉）。如果不想讓 typecheck 壞在中間，這一步先把 `file-panel.tsx` 改成呼叫新的 upload-url＋POST files，列表顯示 `tree.files`。

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/projects apps/web/app/api/files apps/web/test/projects.test.ts apps/web/components/workspace/file-panel.tsx
git commit -m "feat: 雲端資料夾 API，刪除專案時一併刪除檔案"
```

---

### Task 4: runtime 同步整棵資料夾到 /shared

**Files:**
- Modify: `packages/runtime/src/sync.ts`（`syncSharedFiles`）
- Modify: `packages/runtime/src/images.ts`（`ImageRegistry`）
- Modify: `packages/runtime/src/tools/files.ts`（`sharedName` → 支援子資料夾）
- Modify: `packages/runtime/src/agents/prompts.ts`（`filesSection`）
- Modify: `packages/runtime/src/agents/build.ts`、`packages/runtime/src/consultant.ts`、`packages/runtime/src/run.ts`（`sharedFiles` 型別改成 `SharedFile[]`）
- Modify: `packages/runtime/test/helpers.ts`（新增 `seedSharedFile`）
- Test: `packages/runtime/test/sync.test.ts`、`packages/runtime/test/images.test.ts`、`packages/runtime/test/build.test.ts`（或 prompts 測試所在檔），以及所有直接上傳 `${projectId}/<檔名>` 當共用檔案的既有測試（`runtime-access.test.ts`、`server.test.ts`、`images.test.ts` 等，用 `grep -rn "project-files" packages/runtime/test` 找）改用 `seedSharedFile`

**Interfaces:**
- Consumes: Task 1 的 `project_folders`、`project_files`（runtime 可 select）
- Produces：
  ```ts
  // sync.ts
  export type SharedFile = { path: string; fileId: string }; // path 以 / 分隔、相對 sharedRoot，例如 'ETF 資金流顧問/2026-W43/週報.docx'
  export async function syncSharedFiles(db: Db, projectId: string, sharedRoot: string): Promise<SharedFile[]>;
  // images.ts
  ImageRegistry.useSharedFiles(files: SharedFile[]): void;          // run.ts 在同步後呼叫
  ImageRegistry.resolve(relPath: string, bytes: Uint8Array): Promise<string | null>; // 以 relPath 查 fileId，比對 `<專案>/files/<id>`
  // prompts.ts
  export const SHARED_FILES_LISTED = 50;
  // test/helpers.ts：以 service role 建好路徑上的資料夾、上傳 `<專案>/files/<id>`、insert project_files（source 'user'）
  export async function seedSharedFile(db: Db, projectId: string, path: string, content: string | Uint8Array): Promise<string>; // 回 fileId
  ```
- 行為：
  - 同步紀錄 `.sync.json` 改成 `{ [path]: fileId }`。fileId 沒變就不重新下載；path 不在新清單的刪掉，接著由下往上 `rmdir` 變空的資料夾（非空就停，不刪顧問自己放的東西）。
  - 寫檔前，從 sharedRoot 往下逐層 `lstat`：是 symlink 或不是資料夾就 `rm` 後 `mkdir`；檔案本身照舊先 `rm` 再寫。
  - path 的每一段都要 `isPlainName`，不合格整筆略過並 `console.warn`。
  - 舊制的根目錄物件不再同步（Task 9 搬移）。
  - `filesSection`：列出前 50 個，超過時加一行 `- …還有 {n} 個檔案，用 bash 執行 ls -R {sharedRoot} 查看`。
  - `read_file` 看圖：`sharedName` 改成「在 sharedRoot 底下、不含 `..`」的相對路徑（用 `/` 連接），交給 `images.resolve`。

- [ ] **Step 1: 寫失敗的測試**

`sync.test.ts`（用 service role 的 `testDb()` 直接 insert 資料夾與檔案列、上傳 storage 物件）：
- `依資料夾結構同步，中文路徑可用`：`ETF 資金流顧問/2026-W43/週報.docx` 內容正確，回傳 `[{ path: 'ETF 資金流顧問/2026-W43/週報.docx', fileId }]`。
- `改名後舊路徑消失、新路徑出現，空資料夾被清掉`：改 `project_files.name` 與搬到別的資料夾後再同步，舊檔不存在、舊的 `2026-W43` 資料夾不存在、新路徑存在。
- `顧問自己放在 /shared 的檔案不受影響`：先寫 `sharedRoot/notes.txt`，同步兩次後仍在。
- `資料夾被換成 symlink 時不跟著寫`：把 `sharedRoot/ETF 資金流顧問` 換成指向另一個暫存資料夾 X 的 symlink 再同步，X 裡沒有新檔案，`lstat(sharedRoot/ETF 資金流顧問).isDirectory()` 為 true。
- `fileId 沒變就不重新下載`：同步後改本機檔案內容，再同步，內容維持被改過的（證明沒重抓）。

`images.test.ts`：`子資料夾裡的圖片也能解析`：`useSharedFiles([{ path: 'a/b.png', fileId }])` 後 `resolve('a/b.png', bytes)` 回簽名網址；內容不同回 null。

prompts 測試：`共用檔案超過 50 個時只列前 50 個並提示 ls -R`。

- [ ] **Step 2: 跑測試確認失敗**（Git Bash）

Run: `cd packages/runtime && pnpm test -- sync images build`
Expected: FAIL

- [ ] **Step 3: 實作**

- [ ] **Step 4: 跑測試與 typecheck**

Run: `cd packages/runtime && pnpm test -- sync images build && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src packages/runtime/test
git commit -m "feat(runtime): 依雲端資料夾結構同步共用檔案，圖片支援子資料夾"
```

---

### Task 5: runtime 交付檔案工具

**Files:**
- Create: `packages/runtime/src/tools/deliver.ts`
- Modify: `packages/runtime/src/ui-stream.ts`（`DeliveredFile`、`deliveredFiles`）
- Modify: `packages/runtime/src/tools/delegate.ts`（`DelegationOutput.files`）
- Modify: `packages/runtime/src/tools/discuss.ts`（`Speech.files`）
- Modify: `packages/runtime/src/agents/build.ts`（`ConsultantContext` 加 `runId`、`deliveries`；`tools.deliver_file`）
- Modify: `packages/runtime/src/agents/prompts.ts`（工作環境加交付規則）
- Modify: `packages/runtime/src/consultant.ts`、`packages/runtime/src/run.ts`（傳入 `runId` 與每個 run 一份的 `DeliveryBudget`）
- Test: `packages/runtime/test/deliver.test.ts`、`packages/runtime/test/delegate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 storage 寫入權限與 `deliver_project_file`；Task 4 不依賴
- Produces：
  ```ts
  // ui-stream.ts（web 的 lib/agent-output.ts 要有一份相同的型別）
  export type DeliveredFile = { file_id: string; name: string; folder: string; size: number }; // folder 是從根目錄起的路徑，例如 'ETF 資金流顧問/2026-W43'
  export function deliveredFiles(m: UIMessage): DeliveredFile[]; // 取 tool-deliver_file、state output-available、output 有 file_id 的
  // tools/deliver.ts
  export const FILE_LIMIT_BYTES = 50 * 1024 * 1024;
  export const RUN_DELIVERY_LIMIT_BYTES = 200 * 1024 * 1024;
  export type DeliveryBudget = { used: number };
  export function deliverFileTool(opts: { cwd: string; sandbox: Sandbox; db: Db; projectId: string; instanceId: string; runId: string; budget: DeliveryBudget }): Tool;
  ```
- 工具：
  - 名稱 `deliver_file`；description：`把做好的檔案交付給使用者：檔案會出現在使用者的雲端資料夾（你的資料夾底下）與這則回覆的下載按鈕，所有顧問也讀得到。只交付成品（報告、圖表、表格），不要交付暫存檔或腳本。`
  - inputSchema：`{ path: z.string(), folder: z.string().optional() /* 子資料夾，例如 2026-W43，可用 / 分層 */, name: z.string().optional() /* 給使用者看的檔名，預設用原檔名 */, description: DESCRIPTION_FIELD }`
  - 執行：以沙盒帳號 `test -f` 確認是一般檔案、`stat -c %s` 取大小（> 50 MB 回 `{ error: '檔案超過 50 MB，無法交付' }`；加上 `budget.used` 超過 200 MB 回 `{ error: '這次回覆交付的檔案合計超過 200 MB' }`）→ `base64 -w0` 取出位元組（跟 `readImage` 相同做法）→ `db.storage.from('project-files').upload(`${projectId}/files/${randomUUID()}`, bytes, { contentType, upsert: false })` → `db.rpc('deliver_project_file', …)` → 回 `DeliveredFile`。rpc 失敗時刪掉剛上傳的物件（runtime 沒有 delete 權限就略過，留給 Task 9 的備註）。
  - contentType 依副檔名：docx、xlsx、pptx、pdf、md（text/markdown）、csv、txt、json、png、jpg/jpeg、webp、gif、svg、html、zip，其他 `application/octet-stream`。
  - 主管不給這個工具。
- prompt（`buildConsultantInstructions` 的「工作環境」段加一行）：`- 做出要給使用者的檔案（報告、圖表、表格）時，用 deliver_file 交付，使用者才拿得到；只寫進工作目錄或共用資料夾的檔案，使用者看不到。`
- `DelegationOutput` 與 `Speech` 加 `files?: DeliveredFile[]`（`viewOf` 與 discuss 的 speech 更新時用 `deliveredFiles(m)` 填，空陣列就不帶）。

- [ ] **Step 1: 寫失敗的測試**

`deliver.test.ts`（`seedProject`＋`seedConsultant` 建專案，`runtimeDb(await runtimeToken(db, projectId))` 當工具的 db，確保走的是 runtime 權限；沙盒照 `tools.test.ts` 的寫法）：
- `交付後回傳檔案資訊、storage 與資料表都有`：寫 `report.docx` 到工作目錄，執行工具 `{ path: 'report.docx', folder: '2026-W43' }`，回傳 `name: 'report.docx'`、`folder: '{顧問名}/2026-W43'`、`size` 正確；service role 查 `project_files` 有這筆、`source === 'agent'`、`run_id` 正確。
- `name 參數改變顯示檔名`：`{ path: 'out.docx', name: '台灣ETF淨流量週報_W43.docx' }` → 回傳該名稱。
- `超過單檔上限就拒絕`：把 `FILE_LIMIT_BYTES` 用依賴注入或測試專用的小上限（例如工具 opts 加 `limits?: { file: number; run: number }`）設成 10 bytes，交付 11 bytes 的檔案回 error，storage 沒有新物件。
- `同一次 run 合計超過上限就拒絕`：run 上限 15 bytes，交付兩個 10 bytes 檔案，第二個回 error。
- `讀不到的檔案交不出去`：路徑不存在回 error。

`delegate.test.ts`：`顧問交付的檔案出現在派工輸出的 files`：假顧問串流含一個 `tool-deliver_file` output-available part，`DelegationOutput.files` 等於它的 output。

- [ ] **Step 2: 跑測試確認失敗**（Git Bash）

Run: `cd packages/runtime && pnpm test -- deliver delegate`
Expected: FAIL

- [ ] **Step 3: 實作**

- [ ] **Step 4: 跑測試與 typecheck**

Run: `cd packages/runtime && pnpm test -- deliver delegate && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src packages/runtime/test
git commit -m "feat(runtime): 顧問用 deliver_file 把成品交付到使用者的雲端資料夾"
```

---

### Task 6: 檔案瀏覽元件（專案側欄）

**Files:**
- Create: `apps/web/lib/file-tree.ts`
- Create: `apps/web/components/files/file-browser.tsx`
- Delete: `apps/web/components/workspace/file-panel.tsx`
- Modify: `apps/web/components/workspace/workspace.tsx`（`FilePanel` → `FileBrowser`）
- Modify: `apps/web/lib/progress.ts`（`TOOL_LABELS.deliver_file = '交付檔案'`）
- Test: `apps/web/test/file-tree.test.ts`

**Interfaces:**
- Consumes: Task 3 的 HTTP API、Task 2 的 `ProjectTree`、`FolderRow`、`FileRow` 型別
- Produces：
  ```ts
  // lib/file-tree.ts（純函式）
  export type TreeNode = { folder: FolderRow; folders: TreeNode[]; files: FileRow[] };
  export function buildTree(tree: ProjectTree): TreeNode[];                 // 根層資料夾，「我上傳的」排第一，其餘依名稱
  export function folderPath(folders: FolderRow[], id: string): string;      // 'ETF 資金流顧問/2026-W43'
  export function descendantFolderIds(folders: FolderRow[], id: string): string[]; // 含自己，搬移選單用來排除
  export const formatSize: (bytes: number) => string;                       // 從 file-panel.tsx 搬過來
  // components/files/file-browser.tsx
  export function FileBrowser({ projectId, title }: { projectId: string; title?: string }): JSX.Element;
  ```
- 畫面：資料夾可展開收合；每個檔案一列：名稱、大小、下載；每列有「更多」選單（改名、搬移、刪除）；資料夾列有改名、搬移、刪除、新增子資料夾；底部有「上傳檔案」（上傳到目前選取的資料夾，沒選就是根目錄→「我上傳的」）與「新增資料夾」。改名用列內輸入框，搬移用選單列出 `folderPath`（排除 `descendantFolderIds`）。刪除用 `window.confirm` 加 Global Constraints 的確認文字（跟現有刪專案一致）。錯誤顯示在 `notice notice-error`。下載：`GET /api/files/:id/download` 後 `window.location.assign(url)`。按鈕都要有 `aria-label`（例如 `下載 週報.docx`）。提示文字沿用 `上傳後，所有顧問下一次回覆時都讀得到。`
- 樣式沿用 `panel`、`btn`、`btn-sm`、`notice`、`group-title`、`hint`；手機上在既有的 `BottomSheet` 裡，不另外處理。

- [ ] **Step 1: 寫失敗的測試（`file-tree.test.ts`）**

- `buildTree 把「我上傳的」排第一、子資料夾與檔案掛對位置`
- `folderPath 組出完整路徑`：`'ETF 資金流顧問/2026-W43'`
- `descendantFolderIds 含自己與所有子孫`

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @agenthub/web test -- file-tree`
Expected: FAIL

- [ ] **Step 3: 實作 `file-tree.ts` 與 `FileBrowser`，換掉 `FilePanel`**

- [ ] **Step 4: 跑測試、typecheck、lint，並在本機看畫面**

Run: `pnpm --filter @agenthub/web test -- file-tree && pnpm --filter @agenthub/web typecheck && pnpm --filter @agenthub/web lint`
Expected: PASS

本機用 `next build` ＋ `next start -p 3100`（3456 埠有別人的 dev server，不要動），以 Playwright 開一個測試專案：上傳、建資料夾、搬移、改名、刪除、下載各一次，截圖存在 `d:\AgentHub` 底下。

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/file-tree.ts apps/web/components/files apps/web/components/workspace apps/web/lib/progress.ts apps/web/test/file-tree.test.ts
git commit -m "feat: 專案側欄改成雲端資料夾，可下載、改名、搬移、刪除"
```

---

### Task 7: 對話裡的下載按鈕

**Files:**
- Create: `apps/web/components/files/file-card.tsx`
- Modify: `apps/web/lib/agent-output.ts`（`DeliveredFile`；`DelegationOutput.files`、`Speech.files`）
- Modify: `apps/web/components/workspace/message-view.tsx`
- Modify: `apps/web/components/workspace/delegation-card.tsx`
- Modify: `apps/web/components/workspace/discussion-view.tsx`
- Test: `apps/web/test/progress.test.ts`（或新檔 `apps/web/test/delivered.test.ts`）

**Interfaces:**
- Consumes: Task 5 的 `DeliveredFile` 形狀；Task 3 的下載 API；Task 6 的 `formatSize`
- Produces：
  ```ts
  // components/files/file-card.tsx
  export function FileCards({ files }: { files: DeliveredFile[] }): JSX.Element | null;
  // lib/agent-output.ts
  export function filesInMessage(m: UIMessage): DeliveredFile[]; // 收集 assign_task 輸出與 convene_discussion 每段發言的 files，依 file_id 去重、保留順序
  ```
- 行為：
  - 每張卡片：檔名、`folder`、大小、下載按鈕。按下去 404 時卡片改成灰色並顯示 `檔案已刪除`、按鈕停用；其他錯誤顯示在卡片下方。
  - `MessageView`：工具名稱 `deliver_file` 且 output-available 時畫 `FileCards`（單一顧問模式）；不是 output-available 時照舊畫 `ToolStep`。
  - 主管模式：`filesInMessage(message)` 有東西時，在訊息最後畫標題「這次交付的檔案」加 `FileCards`。
  - `DelegationCard`、`DiscussionView` 每段發言底下畫自己的 `files`。

- [ ] **Step 1: 寫失敗的測試**

`filesInMessage 收集派工與討論交付的檔案並去重`：一則 UIMessage 含一個 assign_task（files 兩個）與一個 convene_discussion（speeches 裡 files 一個、與前面重複一個），結果是三個、順序是出現順序。

- [ ] **Step 2: 跑測試確認失敗**

Run: `pnpm --filter @agenthub/web test -- delivered`
Expected: FAIL

- [ ] **Step 3: 實作**

- [ ] **Step 4: 跑測試、typecheck、lint**

Run: `pnpm --filter @agenthub/web test -- delivered && pnpm --filter @agenthub/web typecheck && pnpm --filter @agenthub/web lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components apps/web/lib/agent-output.ts apps/web/test
git commit -m "feat: 顧問交付的檔案在對話裡直接顯示下載按鈕"
```

---

### Task 8: 我的雲端頁面

**Files:**
- Create: `apps/web/app/cloud/page.tsx`
- Modify: `apps/web/components/nav.tsx`（登入後的連結加 `{ href: '/cloud', label: '我的雲端' }`，放在「我的專案」後面）

**Interfaces:**
- Consumes: `listProjects`（`lib/services/projects.ts`）、Task 6 的 `FileBrowser`
- Produces：`/cloud` 頁面。未登入 `redirect('/login?next=/cloud')`；版面照 `app/projects/page.tsx`（`mx-auto max-w-3xl`、標題 `我的雲端`、副標 `所有專案的檔案都在這裡；每個專案是一個資料夾。`）。每個專案一個可展開的區塊（預設收合，展開才載入），展開後是 `<FileBrowser projectId={p.id} />`，標題旁有連到 `/projects/:id` 的「開啟專案」。沒有專案時顯示跟 `/projects` 一樣的空狀態並連到 `/projects`。

- [ ] **Step 1: 實作頁面與導覽連結**

- [ ] **Step 2: typecheck、lint、本機看畫面**

Run: `pnpm --filter @agenthub/web typecheck && pnpm --filter @agenthub/web lint`
Expected: PASS

本機 `next start -p 3100`：導覽列出現「我的雲端」且在該頁時有底色；展開專案看得到 Task 6 建的檔案；在這裡上傳的檔案回到專案頁側欄也看得到。

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/cloud apps/web/components/nav.tsx
git commit -m "feat: 導覽列新增「我的雲端」，跨專案集中管理檔案"
```

---

### Task 9: 舊檔案搬移、文件與上線

**Files:**
- Create: `apps/web/scripts/migrate-project-files.ts`
- Modify: `docs/security-model.md`（第 3 節表格、第 4 節權限表、資料夾說明）
- Test: `apps/web/test/migrate-project-files.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ensure_folder`、`register_project_file`；Task 2 的 `storagePath`、`UPLOAD_FOLDER`
- Produces：
  ```ts
  export async function migrateProjectFiles(db: Db, projectId: string): Promise<{ moved: number }>;
  ```
  腳本主程式列出所有專案逐一呼叫，印每個專案搬了幾個。對 `<專案>/` 第一層每個物件（`id !== null`）：新 id → `storage.move(舊路徑, storagePath(專案, 新id))` → `register_project_file`（folder＝`ensure_folder(專案, null, '我上傳的')`、name＝原物件名、source `user`）。可重複執行：搬過的物件已不在第一層。

- [ ] **Step 1: 寫失敗的測試**

`舊檔案搬進「我上傳的」`：直接上傳 `${p}/brief.md`、`${p}/file_123.pdf`，執行 `migrateProjectFiles`，`moved === 2`；tree 的「我上傳的」裡有這兩個名稱；`list(p)` 第一層只剩 `files` 資料夾；再跑一次 `moved === 0`。

- [ ] **Step 2: 跑測試確認失敗，實作，再跑確認通過**

Run: `pnpm --filter @agenthub/web test -- migrate-project-files`
Expected: 先 FAIL，實作後 PASS

- [ ] **Step 3: 更新 `docs/security-model.md`**

- 第 3 節：租用者看得到的 `/shared` 改成「雲端資料夾裡的檔案（自己上傳的與顧問交付的）；顧問直接寫進 `/shared` 但沒交付的看不到」。
- 第 4 節權限表：`project_folders`、`project_files`（runtime 只讀）、`deliver_project_file`、storage `project-files/<專案>/files/` 只能新增。
- 已知限制：交付失敗時 runtime 刪不掉剛上傳的物件（沒有 delete 權限），會留下沒有資料表紀錄的物件，刪專案時才清掉。

- [ ] **Step 4: 全部測試**

Run: `pnpm test && pnpm typecheck`（runtime 部分從 Git Bash）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/scripts/migrate-project-files.ts apps/web/test/migrate-project-files.test.ts docs/security-model.md
git commit -m "feat: 舊制專案檔案搬進雲端資料夾，更新權限文件"
```

- [ ] **Step 6: 上線（開始前一次取得同意，之後網站部署到 Sprite redeploy 連續做完）**

為什麼要連續做完：網站與 Sprite 上的 runtime 新舊混用時，顧問那一側有空窗——

- 新網站已部署、Sprite 還是舊 runtime：新上傳的檔案放在 `<專案>/files/<id>`，舊 runtime 的 `list(<專案>)` 會濾掉 `files` 子資料夾（`id === null`），顧問看不到新上傳的檔案。
- 搬移腳本跑完、Sprite 還沒 redeploy：舊 runtime 下一次 run 在第一層找不到物件，照舊的 `/shared/.sync.json` 把 `/shared` 裡每個舊副本刪掉，顧問在 redeploy 前看不到任何使用者檔案；剛好在 storage 改名那一刻下載的 run 會以 SyncError 失敗。

所以順序固定如下，中間不停下來等使用者：

0. **上線前**
   - 取得使用者同意：這次會 redeploy **所有** Sprite（正在跑的 run 會被中斷），並說明上面的空窗，同意後才開始 1～7。
   - 在一台真的 Sprite 上跑 `probe-sandbox.ts`（`pnpm --filter @agenthub/runtime publish-runtime -- --versioned-only` 後，`cd apps/web && pnpm exec tsx scripts/probe-sandbox.ts main-<sha>.js`），全部通過，包含兩個新的 symlink 項目（同步遇到被換成 symlink 的資料夾會還原成真資料夾、沒寫進顧問 A 的目錄；沙盒帳號跟著 `/shared` 裡的 symlink 也寫不進顧問 A 的目錄）與同步寫入的權限項目（`agent:workspace 664`、不留暫存檔、其他顧問讀得到）。
   - 記下每個專案 `project-files/<專案>/` 第一層的物件數（`id !== null`），第 5 步要對。
1. 走 `superpowers:finishing-a-development-branch`，合併進 main（先不 push）。
2. `pnpm --filter @agenthub/runtime publish-runtime`：只把新的 `main.js` 上傳到 storage，不重啟任何 Sprite。
3. 確認目前沒有正在跑的 run（`runs` 沒有 `status = 'running'`）；有的話等它結束。
4. push main，等 Vercel 部署完成（部署狀態顯示 Ready、正式站載得到新版）。
5. **立刻**跑 `migrate-project-files.ts`；每個專案印出的「搬了 N 個」要等於第 0 步記下的第一層物件數，有失敗的專案先處理（腳本可重跑）。
6. **立刻**跑 `redeploy-runtime.ts` redeploy 所有 Sprite，全部成功。
7. 上線後檢查：
   - 請正式站使用者重新整理已開著的分頁（舊版側欄預期檔案清單是陣列，新 API 回傳的是樹，不重新整理會壞掉）。
   - 選一台有舊制檔案的 Sprite：`/workspace/shared/我上傳的/…` 存在，檔案是 `agent:workspace` 664、資料夾 2775；顧問帳號 `cat` 得到；`~/agenthub/shared-sync.json` 存在；`/workspace/shared` 第一層沒有舊副本、也沒有 `/workspace/shared/.sync.json`。
   - 記錄 redeploy 後第一次 run 的準備時間（整棵重新下載、每個檔案一次 sudo），以檔案最多的專案為準。
   - 在 Linux／Sprite 上確認：交付拒絕 chmod 000 的檔案、拒絕指向超過 50 MB 檔案的 symlink；同步或交付時把目標換成 FIFO，只有那一個操作失敗或逾時（同步 120 秒上限），run 照常進行。
8. 正式站 e2e（臨時帳號，照規格第 5 節）：
   - 開專案租 ETF 顧問 → 請它把一份簡短報告存成 docx 並交付 → 回覆有下載按鈕、下載的檔案打得開 → 側欄與我的雲端都看得到 → 改名、搬移後舊按鈕仍能下載 → 刪除後按鈕顯示「檔案已刪除」→ 加投組顧問、另開對話請它讀那份檔案，讀得到。
   - 檔案卡片：單一顧問模式、主管模式（委派與討論）都會出現；重新整理頁面後卡片還在；主管的「這次交付的檔案」清單沒有重複。
   - 刪掉一個搬移過來的舊制檔案，下一次 run 後 `ls /workspace/shared`（與 `我上傳的/`）看不到它。
   - 刪專案（含一個交付失敗留下、沒有資料表紀錄的孤兒物件）後，`list(<專案>)` 與 `list(<專案>/files)` 都是空的。
9. 把結果寫進這份計畫最後的「實測」段。

---

## 後續（不在這份計畫）

- 規格第 6 節：ETF 顧問產出 docx（含四張圖）並交付。改的是 `agenthub-fintech-agents`（skill、`requirements.txt`、`scripts/pack.py` → `scripts/publish_agents.py`），等這份計畫上線後另寫計畫。

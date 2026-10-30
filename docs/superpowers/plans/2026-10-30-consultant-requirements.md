# 顧問各自的 Python 套件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 創作者在 skill zip 放 `requirements.txt`；上架時檢查格式與 PyPI；runtime 在顧問第一次對話前，以顧問的沙盒帳號裝進該顧問自己的虛擬環境，之後顧問的 `python3` 就是它；裝不起來時顧問與使用者都會知道。

**Architecture:** web 新增 `lib/requirements.ts`（解析＋PyPI 檢查），在 `processSkillsUpload` 裡 `parseSkillsZip` 之後呼叫。runtime 新增 `src/requirements.ts`：讀出顧問所有 skill 的 `requirements.txt` 合併、依雜湊決定是否以沙盒執行 `python3 -m venv --system-site-packages` ＋ `pip install`；`prepareRootAgent` 在 `syncSkills` 之後對每位顧問執行，把結果（環境的 bin 目錄或失敗訊息）交給 `buildConsultant`，由 `createSandbox` 把 bin 目錄排進 PATH、失敗訊息寫進指示並以 `data-warning` 送出。

**Tech Stack:** TypeScript strict、Next.js、Hono、Vercel AI SDK 7、Vitest、fflate、Fly Sprites。

**Spec:** `docs/superpowers/specs/2026-10-30-consultant-requirements-design.md`

## Global Constraints

- requirements.txt 每行只能是：空行、`#` 註解，或 `名稱[extras]` 加可選版本條件（`==`、`>=`、`<=`、`~=`、`!=`、`<`、`>`，可逗號分隔多個）；拒絕 `-` 開頭、含 `://`、含 `@`、含 `/`、含 `;` 的行。每份最多 50 行、4096 bytes。
- 名稱比對照 PEP 503 正規化（小寫、連續的 `-`／`_`／`.` 視為一個 `-`）。
- PyPI 查詢 `https://pypi.org/pypi/<名稱>/json`：404 → 套件不存在；有 `==X` 時 `X` 必須在 `releases` 的 key 裡；連不上或逾時（每個 5 秒）→ 擋下，訊息「暫時無法連線 PyPI 檢查，請稍後再試」。
- 顧問環境目錄：`<顧問工作目錄>/.agenthub-venv`；雜湊檔 `.agenthub-venv/.requirements-sha256`；失敗檔 `.agenthub-venv/.requirements-failed`（內容：雜湊＋換行＋錯誤摘要，最多 2000 字）。
- 安裝逾時 **180 秒**（spec 寫 5 分鐘；安裝在 runtime 回應之前，Vercel 轉送對話的路由 `maxDuration` 300 秒，5 分鐘會先被 Vercel 切斷）。
- 失敗只影響該顧問；主管不使用任何顧問的虛擬環境。
- 直接在 main 開發；runtime 上線要 `publish-runtime`＋`redeploy-runtime`（先確認沒有 running 的 run、徵得使用者同意）。

## Review Focus

- 同一份 requirements 第二次對話不重裝（雜湊相同就跳過）；失敗過的同一份也不在每次對話重試卡住 3 分鐘。（Task 2）
- 創作者改了 requirements.txt（重新上傳 zip）→ 下次對話重裝。（Task 2）
- 顧問沒有任何 requirements.txt → 完全不建虛擬環境、行為與現在相同。（Task 2、3）
- 多個 skill 各有 requirements.txt → 合併後安裝；合併順序固定（依 skill 資料夾名稱），雜湊才穩定。（Task 2）
- requirements.txt 用 Windows 換行（CRLF）或有 UTF-8 BOM → 照常解析。（Task 1）

---

### Task 1: 上架時檢查 requirements.txt

**Files:**
- Create: `apps/web/lib/requirements.ts`
- Modify: `apps/web/lib/services/templates.ts`（`processSkillsUpload`：`parseSkillsZip` 之後）
- Test: `apps/web/test/requirements.test.ts`

**Interfaces:**
- Produces:
  - `type Requirement = { name: string; normalized: string; pinned?: string; line: number }`
  - `parseRequirements(text: string): { requirements: Requirement[]; problems: string[] }`（problems 形如「第 3 行：不接受 -e、網址或本機路徑」）
  - `checkOnPyPI(reqs: Requirement[], fetchImpl?: typeof fetch): Promise<string[]>`（回傳問題清單）
  - `requirementsProblems(files: Record<string, Uint8Array>, skills: SkillMeta[], fetchImpl?: typeof fetch): Promise<string[]>`：逐一檢查 `<skill.path>/requirements.txt`（`path` 為空字串時是 `requirements.txt`），問題前綴 `<skill 名稱>/requirements.txt`。
  - `processSkillsUpload` 有問題時 `throw new HttpError(400, problems.join('\n'))`。`parseSkillsZip` 不改；zip 要另外 `unzipSync` 一次取檔案（或讓 `parseSkillsZip` 回傳 files，實作者擇一並記錄）。

- [ ] **Step 1: 寫失敗測試**

```ts
it('parseRequirements：接受名稱、extras、版本條件、註解、空行、CRLF、BOM', () => {
  const r = parseRequirements('﻿# 註解\r\nnumpy\r\nPandas>=2.0,<3\r\nrequests[socks]==2.32.3\r\n\r\n');
  expect(r.problems).toEqual([]);
  expect(r.requirements.map((x) => [x.normalized, x.pinned ?? null])).toEqual([['numpy', null], ['pandas', null], ['requests', '2.32.3']]);
});
it('parseRequirements：拒絕選項、網址、@、路徑、環境標記，超過 50 行或 4096 bytes', () => {
  for (const bad of ['-e git+https://x/y.git', '--index-url https://x', 'pkg @ https://x/p.whl', './local', 'pkg; python_version<"3.8"', 'git+https://x/y']) {
    expect(parseRequirements(`numpy\n${bad}`).problems[0]).toMatch(/^第 2 行/);
  }
  expect(parseRequirements(Array.from({ length: 51 }, (_, i) => `p${i}`).join('\n')).problems[0]).toContain('50');
});
it('checkOnPyPI：不存在的套件、不存在的版本各回報；連不上回報稍後再試', async () => {
  const fake = (async (url: string) => url.includes('/nope/') ? new Response('', { status: 404 }) : Response.json({ releases: { '2.32.3': [] } })) as typeof fetch;
  expect(await checkOnPyPI(parseRequirements('requests==2.32.3').requirements, fake)).toEqual([]);
  expect((await checkOnPyPI(parseRequirements('nope').requirements, fake))[0]).toContain('PyPI 上找不到');
  expect((await checkOnPyPI(parseRequirements('requests==9.9.9').requirements, fake))[0]).toContain('9.9.9');
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  expect((await checkOnPyPI(parseRequirements('requests').requirements, down))[0]).toContain('稍後再試');
});
it('requirementsProblems：問題前綴 skill 名稱與檔名；沒有 requirements.txt 時沒有問題', async () => {});
```

- [ ] **Step 2: `pnpm -F @agenthub/web exec vitest run test/requirements.test.ts` 確認失敗。**
- [ ] **Step 3: 實作並接進 `processSkillsUpload`。**
- [ ] **Step 4: web 全部測試＋`pnpm typecheck` 全過。**
- [ ] **Step 5: Commit** — `git add apps/web/lib/requirements.ts apps/web/lib/services/templates.ts apps/web/test/requirements.test.ts`；`git commit -m "feat(web): 上架時檢查 skill 的 requirements.txt（格式與 PyPI）"`

### Task 2: runtime 安裝顧問的套件

**Files:**
- Create: `packages/runtime/src/requirements.ts`
- Test: `packages/runtime/test/requirements.test.ts`

**Interfaces:**
- Produces:
  - `consultantRequirements(skillsDir: string): Promise<string>`：讀 `skillsDir/<skill>/requirements.txt`（skill 資料夾名稱排序）串接，各段之間一個換行；沒有任何檔案回空字串。
  - `type EnvResult = { bin?: string; failure?: string }`
  - `ensureConsultantEnv(opts: { workDir: string; requirements: string; run: (argv: string[], input?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>; timeoutMs?: number }): Promise<EnvResult>`：
    - `requirements` 為空 → `{}`（不建環境）
    - 雜湊等於 `.requirements-sha256` → `{ bin: <workDir>/.agenthub-venv/bin }`，不執行任何指令
    - 雜湊等於 `.requirements-failed` 第一行 → `{ failure: <檔案第二行起> }`，不執行任何指令
    - 否則 `run(['bash','-c', 'rm -rf .agenthub-venv && python3 -m venv --system-site-packages .agenthub-venv && .agenthub-venv/bin/pip install --disable-pip-version-check -q -r /dev/stdin'], requirements)`，逾時 180 秒；成功寫雜湊檔回 bin，失敗寫失敗檔回 failure（stderr 最後 2000 字）。雜湊檔與失敗檔也經 `run` 以沙盒帳號寫入（環境目錄擁有者是顧問）。
  - `run` 由 Task 3 以 `runInSandbox(sandbox, argv, { cwd: workDir, input })` 提供。

- [ ] **Step 1: 寫失敗測試**（`run` 用假的紀錄器；檔案系統用 `tmpRoots` 的暫存目錄）

```ts
it('沒有 requirements：不建環境、不執行指令', async () => {
  const calls: string[][] = [];
  expect(await ensureConsultantEnv({ workDir, requirements: '', run: rec(calls) })).toEqual({});
  expect(calls).toEqual([]);
});
it('第一次安裝成功寫雜湊，第二次同一份不再安裝；內容改了重裝', async () => {});
it('安裝失敗記下失敗、回 failure；同一份下次直接回 failure 不重試；改了內容會重試', async () => {});
it('consultantRequirements：依 skill 資料夾名稱排序合併', async () => {});
```

- [ ] **Step 2: Git Bash 跑測試確認失敗。**
- [ ] **Step 3: 實作。**
- [ ] **Step 4: runtime 全部測試＋typecheck 全過。**
- [ ] **Step 5: Commit** — `git add packages/runtime/src/requirements.ts packages/runtime/test/requirements.test.ts`；`git commit -m "feat(runtime): 依 requirements.txt 為顧問建立自己的虛擬環境"`

### Task 3: 串接：顧問用自己的環境，失敗時告知

**Files:**
- Modify: `packages/runtime/src/sandbox.ts`（`createSandbox(user, opts?)`、`sandboxEnv` 加 `pathPrefix`）
- Modify: `packages/runtime/src/run.ts`（`prepareRootAgent`：`syncSkills` 後對每位顧問 `ensureConsultantEnv`，結果存成 `Map<instanceId, EnvResult>`）
- Modify: `packages/runtime/src/agents/build.ts`（`ConsultantContext.env?: EnvResult`；沙盒帶 `pathPrefix: env.bin`；失敗時指示加一段、warnings 加一則）
- Modify: `packages/runtime/src/agents/prompts.ts`（`buildConsultantInstructions` 接受 `envFailure?: string`）
- Modify: `packages/runtime/src/consultant.ts`（`ConsultantRunnerDeps.envs?: Map<string, EnvResult>` 傳給 `buildConsultant`）
- Test: `packages/runtime/test/sandbox.test.ts`、`packages/runtime/test/build.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `consultantRequirements`、`ensureConsultantEnv`、`EnvResult`。
- Produces: `sandboxEnv(user, extraEnv, pathPrefix?)`：有 `pathPrefix` 時 `SANDBOX_PATH`（沙盒）與本機模式的 `PATH` 都以它開頭；`createSandbox(user?: string, opts?: { pathPrefix?: string })`。指示段落標題「## 套件安裝失敗」，內容「以下套件沒有裝好：<摘要>。不要假設它們存在；需要時告知使用者這位顧問的環境不完整。」；warning 文字「顧問 <名稱> 的套件安裝失敗」。

- [ ] **Step 1: 寫失敗測試** — `sandboxEnv('agent', {}, '/w/.agenthub-venv/bin').SANDBOX_PATH` 以 `/w/.agenthub-venv/bin:` 開頭；`buildConsultant({ ..., env: { failure: 'No matching distribution' } })` 的 instructions 含「套件安裝失敗」與「No matching distribution」、`warnings` 含「套件安裝失敗」；`env: { bin }` 時不含。
- [ ] **Step 2: 確認失敗。**
- [ ] **Step 3: 實作串接。**
- [ ] **Step 4: runtime 全部測試＋typecheck 全過。**
- [ ] **Step 5: Commit** — `git add packages/runtime/src/sandbox.ts packages/runtime/src/run.ts packages/runtime/src/agents/build.ts packages/runtime/src/agents/prompts.ts packages/runtime/src/consultant.ts packages/runtime/test/sandbox.test.ts packages/runtime/test/build.test.ts`；`git commit -m "feat(runtime): 顧問使用自己的套件環境，安裝失敗時告知顧問與使用者"`

### Task 4: 文件與真實 Sprite 驗收項目

**Files:**
- Modify: `docs/security-model.md`（第 5 節目錄表加 `.agenthub-venv`；說明以顧問帳號安裝、只從 PyPI）
- Modify: `docs/creator/`（給創作者的說明：requirements.txt 放哪、允許的寫法、上限、預裝 numpy 與 pandas）
- Modify: `apps/web/scripts/probe-sandbox.ts`（以沙盒帳號在 `/tmp` 建 `--system-site-packages` 虛擬環境、`pip install` 一個小套件、能同時 import 它與 numpy）

- [ ] **Step 1: 修改三個檔案。**
- [ ] **Step 2: web＋runtime 全部測試＋typecheck 全過。**
- [ ] **Step 3: Commit** — `git add docs/security-model.md docs/creator apps/web/scripts/probe-sandbox.ts`；`git commit -m "docs: 創作者用 requirements.txt 宣告顧問套件；驗收腳本加虛擬環境檢查"`

### Task 5: 上線驗收（與當晚的 runtime redeploy 一起）

- [ ] **Step 1:** 隨當晚的 push、`publish-runtime`、`redeploy-runtime` 上線（同一次）。
- [ ] **Step 2:** `probe-sandbox.ts` 全過。
- [ ] **Step 3:** 臨時帳號建兩個測試範本，skill 各帶 `requests==2.31.0`、`requests==2.32.3`，上架；同一專案租用兩位，各自請它執行 `python3 -c "import requests, numpy; print(requests.__version__)"`，各印自己的版本；再問一次確認沒有重裝（第二次 run 耗時明顯較短、環境目錄的雜湊檔時間不變）。
- [ ] **Step 4:** 上架含錯字套件的 zip 被擋下並指出行號。
- [ ] **Step 5:** 清理臨時帳號、範本、專案與 Sprite；結果寫進本計畫結尾。

## 實測

（Task 5 完成後填寫。）

# Skill 載入與記憶（Claude Code 做法）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顧問用專用的 `skill` 工具載入 skill（行為對齊 Claude Code），記憶改成「名稱＋說明＋類型＋內容」、索引常駐、可新增／更新／刪除。

**Architecture:** runtime 新增 `tools/skill.ts`，改寫 `tools/memory.ts` 與 `agents/prompts.ts`；web 加強 skill zip 檢查、記憶面板顯示新欄位；Supabase migration 擴充 `memories` 並開放 runtime 更新／刪除。

**Tech Stack:** TypeScript、Vercel AI SDK v7（`tool()`）、zod 4、Supabase（Postgres RLS、pgTAP）、Next.js 16、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-16-skills-and-memory-design.md`

## Global Constraints

- UI 文字、錯誤訊息、註解、工具說明都用繁體中文；錯誤訊息要說清楚發生什麼、怎麼處理。
- 不加新套件；不留相容層（`remember`／`recall` 直接刪除）。
- skill `name`：`/^[a-z0-9-]{1,64}$/`；`description` 最多 1024 字元。
- 記憶：`name` 1–64 字元不含換行；`description` 1–200 字元；`type` ∈ `user`／`feedback`／`project`／`reference`；`content` 最多 5000 字元；prompt 索引最多 200 筆。
- `skill` 工具回傳上限 60000 字元；`` !`指令` `` 單次 30 秒，以顧問的沙盒帳號執行。
- runtime 測試從 Git Bash 執行（PowerShell 的 `bash` 會解析到 WSL）。
- 測試直接打雲端 Supabase；Task 4 的 migration 推上去之前，依賴新欄位的測試（Task 5、6）不會過。
- **commit、`pnpm db:push`、`publish-runtime`、`redeploy-runtime`、`git push` 都要先取得使用者同意**；push `main` 就是上 production。
- commit message：`<type>(<範圍>): <繁體中文描述>`，stage 時指定檔案路徑。

## Review Focus

1. SKILL.md 沒有 frontmatter 結尾、或本文裡出現 `---` 分隔線：只去掉開頭那一段 frontmatter，本文的 `---` 保留（Task 2 測試）。
2. `` !`指令` `` 卡住或輸出很大：30 秒逾時後換成 `[指令失敗：…]`，輸出走 `truncate`，整個工具不失敗（Task 2 測試）。
3. 兩位顧問各有同名私有記憶，加上同名專案記憶：`memory_write`／`memory_delete` 只動到自己 scope 的那一筆，`memory_read` 不會回傳別人的私有記憶（Task 5 測試）。
4. 模型連續兩次 `memory_write` 同名同 scope：第二次是更新，不新增第二筆、不報錯（Task 5 測試）。
5. 既有記憶遷移後：在記憶面板與 prompt 索引都看得到，`name` 是 `memory-xxxxxxxx`（Task 4 pgTAP、Task 6 測試）。

---

### Task 1: skill zip 上架檢查對齊 Agent Skills 規格

**Files:**
- Modify: `apps/web/lib/skills-zip.ts`
- Test: `apps/web/test/skills-zip.test.ts`
- Modify: `README.md`（「上架顧問的格式」一節）

**Interfaces:**
- Produces: `parseSkillsZip(bytes: Uint8Array): SkillMeta[]`，簽名不變，多兩項檢查。

- [ ] **Step 1: 寫失敗的測試**（沿用檔案內的 `zip`、`skill`、`problemsOf`）

```ts
it('name 只能用小寫英文字母、數字、連字號，最多 64 字元', () => {
  expect(problemsOf(zip({ 'a/SKILL.md': skill('Credit 5P', '說明') })))
    .toEqual(['a/SKILL.md：name「Credit 5P」只能用小寫英文字母、數字和連字號（最多 64 字元）']);
  expect(problemsOf(zip({ 'b/SKILL.md': skill('x'.repeat(65), '說明') }))[0]).toContain('最多 64 字元');
  expect(parseSkillsZip(zip({ 'c/SKILL.md': skill('credit-5p', '說明') }))[0].name).toBe('credit-5p');
});

it('description 最多 1024 字元', () => {
  expect(problemsOf(zip({ 'a/SKILL.md': skill('long', '字'.repeat(1025)) })))
    .toEqual(['a/SKILL.md：description 最多 1024 字元（目前 1025 字元）']);
});
```

既有測試裡若有不符新規則的 name（例如中文 name），改成合法 name。

- [ ] **Step 2: 執行確認失敗**

Run: `pnpm -F @agenthub/web test test/skills-zip.test.ts`
Expected: 新增的兩個測試 FAIL

- [ ] **Step 3: 在 `parseSkillsZip` 的 missing 檢查之後、duplicate 檢查之前加上兩項檢查**，錯誤文字與測試一致；不合格就 `continue`。

- [ ] **Step 4: 執行確認通過**

Run: `pnpm -F @agenthub/web test test/skills-zip.test.ts test/demo.test.ts`
Expected: PASS（demo 的 6 個 skill name 都合規）

- [ ] **Step 5: README「上架顧問的格式」**：寫明 name／description 規則；說明顧問會用 `skill` 工具載入、支援 `$ARGUMENTS`、`$N`、`${CLAUDE_SKILL_DIR}`、`` !`指令` ``；`allowed-tools`、`model`、`disable-model-invocation` 等欄位接受但忽略，使用者不能用 `/名稱` 呼叫。

- [ ] **Step 6: Commit**（取得同意後）

```bash
git add apps/web/lib/skills-zip.ts apps/web/test/skills-zip.test.ts README.md
git commit -m "feat(web): skill 上架依 Agent Skills 規格檢查 name 與 description"
```

---

### Task 2: runtime 的 `skill` 工具

**Files:**
- Create: `packages/runtime/src/tools/skill.ts`
- Test: `packages/runtime/test/skill.test.ts`

**Interfaces:**
- Consumes: `runBash(sandbox, command, cwd, timeoutMs)`、`truncate(text, max)`（`tools/bash.ts`）；`Sandbox`（`sandbox.ts`）；`SkillMeta`（`types.ts`）。
- Produces:
  - `export const SKILL_OUTPUT_LIMIT = 60_000;`
  - `export const SKILL_COMMAND_TIMEOUT_MS = 30_000;`
  - `export function splitArgs(args: string): string[]`
  - `export function expandSkill(body: string, o: { dir: string; args: string }): string` — 去 frontmatter 以外的純文字替換（不含 `` !`指令` ``）
  - `export async function loadSkill(o: { skills: SkillMeta[]; skillsDir: string; sandbox: Sandbox; name: string; args?: string }): Promise<{ content: string } | { error: string }>`
  - `export function skillTool(o: { skills: SkillMeta[]; skillsDir: string; sandbox: Sandbox })` — AI SDK `tool()`，inputSchema `{ name: z.string(), args: z.string().optional() }`，`execute` 呼叫 `loadSkill`。

- [ ] **Step 1: 寫失敗的測試**（用 `tmpRoots()` 建資料夾、`createSandbox()` 當本機沙盒；skill 檔案用 `writeFile` 寫到 `<skillsDir>/<path>/SKILL.md`）

```ts
describe('splitArgs', () => {
  it('以空白切分，雙引號內視為一個參數', () => {
    expect(splitArgs('a  "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(splitArgs('')).toEqual([]);
  });
});

describe('expandSkill', () => {
  it('替換 ${CLAUDE_SKILL_DIR}、$ARGUMENTS[N]、$N、$ARGUMENTS', () => {
    expect(expandSkill('${CLAUDE_SKILL_DIR}/a.py $ARGUMENTS[1] $0 | $ARGUMENTS', { dir: '/s/x', args: 'p "q r"' }))
      .toBe('/s/x/a.py q r p | p "q r"');
  });
  it('本文沒有 $ARGUMENTS 而有參數時，最後加上 ARGUMENTS 行；沒參數則不加', () => {
    expect(expandSkill('做事', { dir: '/s', args: '台積電' })).toBe('做事\n\nARGUMENTS: 台積電');
    expect(expandSkill('做事', { dir: '/s', args: '' })).toBe('做事');
  });
});

describe('loadSkill', () => {
  it('回傳資料夾說明行加上去掉 frontmatter 的本文，本文裡的 --- 保留', async () => {
    // SKILL.md：'---\nname: dcf\ndescription: 估值\n---\n\n# DCF\n\n---\n結尾'
    const r = await loadSkill({ skills, skillsDir, sandbox: local, name: 'dcf' });
    expect(r).toEqual({ content: `這個 skill 的資料夾：${dir}（SKILL.md 裡的相對路徑都以這裡為準）\n\n# DCF\n\n---\n結尾` });
  });
  it('執行 !`指令`，以 skill 資料夾為工作目錄，輸出取代原文字', async () => {
    // 資料夾內有 data.txt 內容 '42'；本文 '值：!`cat data.txt`'
    expect((await loadSkill({ ..., name: 'cmd' }) as { content: string }).content).toContain('值：42');
  });
  it('指令失敗或逾時換成 [指令失敗：…]，工具本身不失敗', async () => {
    // 本文 'A !`exit 3` B'
    expect((await loadSkill({ ..., name: 'bad' }) as { content: string }).content).toMatch(/A \[指令失敗：.*\] B/);
  });
  it('找不到名稱時回傳錯誤並列出可用名稱', async () => {
    expect(await loadSkill({ skills, skillsDir, sandbox: local, name: 'nope' }))
      .toEqual({ error: '找不到 skill「nope」。可用的 skills：dcf、cmd、bad' });
  });
  it('超過 60000 字元截斷', async () => {
    // 本文 'x'.repeat(70_000)
    expect((await loadSkill({ ..., name: 'big' }) as { content: string }).content).toContain('已截斷');
  });
});
```

逾時：測試用 `vi.useFakeTimers` 不適用子行程；改把 `SKILL_COMMAND_TIMEOUT_MS` 做成 `loadSkill` 的選填參數 `commandTimeoutMs`，測試傳 200 並用 `sleep 5`，期望 `[指令失敗：逾時]`。

- [ ] **Step 2: 執行確認失敗**

Run（Git Bash）：`pnpm -F @agenthub/runtime test test/skill.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作 `tools/skill.ts`**
  - frontmatter：只去掉檔案開頭（可有 BOM）`/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/` 那一段，再去掉本文開頭空行。
  - 替換順序：`${CLAUDE_SKILL_DIR}` → `$ARGUMENTS[N]` → `$ARGUMENTS` → `$N`（`/\$(\d+)/`）；超出範圍的索引換成空字串。是否加 `ARGUMENTS:` 行，依替換前本文有沒有 `$ARGUMENTS` 判斷。
  - `` !`指令` ``：`/!`([^`\n]+)`/g`，依序執行 `runBash(sandbox, cmd, dir, timeout)`；`exitCode !== 0` → `[指令失敗：結束碼 N]`，`timedOut` → `[指令失敗：逾時]`，成功 → `output.trim()`。
  - 指令在替換參數**之後**執行（與 Claude Code 相同，指令裡可以用參數）。
  - 最後 `truncate(text, SKILL_OUTPUT_LIMIT)`。
  - SKILL.md 讀不到 → `{ error: '讀不到 skill「<name>」的 SKILL.md：<原因>' }`。
  - 工具 description 用規格 3.3 的文字。

- [ ] **Step 4: 執行確認通過**

Run（Git Bash）：`pnpm -F @agenthub/runtime test test/skill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**（取得同意後）

```bash
git add packages/runtime/src/tools/skill.ts packages/runtime/test/skill.test.ts
git commit -m "feat(runtime): skill 工具，載入方式與參數替換對齊 Claude Code"
```

---

### Task 3: 把 `skill` 工具接進顧問，prompt 改成 Claude Code 的寫法

**Files:**
- Modify: `packages/runtime/src/agents/build.ts:134-140`（顧問工具）
- Modify: `packages/runtime/src/agents/prompts.ts:30-38`（skills 一節）
- Modify: `apps/web/lib/progress.ts:4-6`（`skill: '載入 skill'`）
- Test: `packages/runtime/test/build.test.ts`

**Interfaces:**
- Consumes: `skillTool({ skills, skillsDir, sandbox })`（Task 2）。
- Produces: 顧問有 skill 時工具多一個 `skill`；`ConsultantPromptInput` 不變（仍需 `skillsDir`，給工具用；prompt 不再印路徑）。

- [ ] **Step 1: 改測試**
  - `build.test.ts:40-56`：期望改成包含 `- 審合約：檢查合約風險`，並包含 `先用 skill 工具載入它`；不包含 `SKILL.md`。（測試資料的 skill name 改成合法的 `contract-review`。）
  - `build.test.ts:92-111`：instance 加一個 skill，期望工具名稱含 `skill`；另加一個 `it('沒有 skill 的顧問不提供 skill 工具')`。

- [ ] **Step 2: 執行確認失敗**

Run（Git Bash）：`pnpm -F @agenthub/runtime test test/build.test.ts`
Expected: 上述測試 FAIL

- [ ] **Step 3: 實作**
  - `prompts.ts`：skills 一節改成規格 3.4 的文字（每行 `- ${name}：${description}`，最後一行「工作內容和上面某個 skill 相符時，這是必要步驟：先用 skill 工具載入它，再開始回答或使用其他工具。不要只憑名稱和說明猜內容。」）。
  - `build.ts`：`instance.skills.length > 0` 時加入 `skill: skillTool({ skills: ctx.instance.skills, skillsDir: skillsDir(...), sandbox })`，`sandbox` 用同一個 `createSandbox(sandboxUserFor(...))`。
  - `progress.ts`：`TOOL_LABELS` 加 `skill: '載入 skill'`。

- [ ] **Step 4: 執行確認通過**

Run（Git Bash）：`pnpm -F @agenthub/runtime test test/build.test.ts test/prompts.test.ts`，以及 `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**（取得同意後）

```bash
git add packages/runtime/src/agents/build.ts packages/runtime/src/agents/prompts.ts packages/runtime/test/build.test.ts apps/web/lib/progress.ts
git commit -m "feat(runtime): 顧問用 skill 工具載入 skill，prompt 要求先載入再回答"
```

---

### Task 4: `memories` 資料表與 runtime 權限

**Files:**
- Modify: `docs/security-model.md:66`（先改）
- Create: `supabase/migrations/20261016000001_memory_files.sql`
- Modify: `supabase/tests/runtime_access.sql`
- Modify: `supabase/tests/schema.test.sql`

**Interfaces:**
- Produces（後續 Task 依賴）：`memories` 有 `name text not null`、`description text not null`、`type text not null`，唯一 `memories_owner_name`＝`unique nulls not distinct (project_id, instance_id, name)`；runtime（`authenticated` + `runtime_project()`）可 select `id, project_id, instance_id, name, description, type, content, created_at, updated_at`，insert `project_id, instance_id, name, description, type, content, created_by_instance_id`，update `content, description, type, updated_at`，delete。

- [ ] **Step 1: 改 `security-model.md` 第 4 節 `memories` 一列**為規格 4.3 的內容。

- [ ] **Step 2: 寫 migration**
  1. `add column name text, add column description text, add column type text`。
  2. 回填：`name = 'memory-' || left(id::text, 8)`、`description = left(regexp_replace(content, '\s+', ' ', 'g'), 100)`、`type = 'user'`。
  3. `set not null` 三欄；check：`char_length(name) between 1 and 64 and name !~ '[\r\n]'`、`char_length(description) between 1 and 200`、`type in ('user','feedback','project','reference')`、`char_length(content) <= 5000`。
  4. `add constraint memories_owner_name unique nulls not distinct (project_id, instance_id, name)`。
  5. `drop index memories_project_created; create index memories_project_updated on public.memories (project_id, updated_at desc);`
  6. 權限：`revoke select, insert on public.memories from authenticated;` 後依 Interfaces 重新 grant；新增 `create policy runtime_update ... for update to authenticated using (project_id = public.runtime_project()) with check (project_id = public.runtime_project());` 與 `runtime_delete ... for delete ... using (project_id = public.runtime_project());`

- [ ] **Step 3: 改 pgTAP**
  - `runtime_access.sql` 準備資料加兩筆記憶（`b1` 與 `b2` 各一筆，`name` 'm'）；runtime 身分的區塊加斷言：
    - `update ... set content = '新' where name = 'm'` 後自己專案那筆是 '新'，別的專案那筆不變；
    - `delete` 只刪得到自己專案；
    - `update public.memories set name = 'x'` 會丟 `insufficient_privilege`（用 `begin ... exception when insufficient_privilege then null; end` 包住，沒丟就 `assert false, '不能改記憶名稱'`）；`instance_id`、`project_id` 同。
  - `schema.test.sql`：`plan` +2；`has_column('memories','name')` 等擇一，以及 `col_is_unique` 或以重複 insert 驗證 `memories_owner_name`（同專案共用記憶同名第二筆丟 `unique_violation`）。

- [ ] **Step 4: 推 migration 並驗證**（**先取得使用者同意**：會改 production 資料庫；推完後舊 runtime 的 `remember` 會失敗，直到 Task 7 重新部署 runtime）

Run：`pnpm db:push` → `pnpm db:test`
Expected: 全部 pgTAP 通過；`select count(*) from memories where name is null` = 0。

- [ ] **Step 5: Commit**（取得同意後）

```bash
git add docs/security-model.md supabase/migrations/20261016000001_memory_files.sql supabase/tests/runtime_access.sql supabase/tests/schema.test.sql
git commit -m "feat(db): 記憶加上名稱、說明、類型，runtime 可更新與刪除自己專案的記憶"
```

---

### Task 5: 記憶工具與 prompt 改成 Claude Code 的做法

**Files:**
- Modify（重寫）：`packages/runtime/src/tools/memory.ts`
- Modify: `packages/runtime/src/agents/prompts.ts`（`MEMORY_RULE`、`memorySection`）
- Test: `packages/runtime/test/memory.test.ts`（重寫）、`packages/runtime/test/build.test.ts`（工具名稱、記憶區塊）、`packages/runtime/test/runtime-access.test.ts:44`

**Interfaces:**
- Consumes: Task 4 的欄位與權限。
- Produces:
  - `export const MEMORY_INDEX_LIMIT = 200;`
  - `export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;`
  - `export type MemoryRow = { id: string; instance_id: string | null; name: string; description: string; type: MemoryType; content: string; updated_at: string };`
  - `export async function loadMemoryIndex(db, projectId, instanceId): Promise<{ rows: MemoryRow[]; omitted: number }>` — 看得到的記憶依 `updated_at desc` 取前 200，`omitted` 是其餘筆數（`count: 'exact'`）。取代 `loadMemories`。
  - `export function formatMemoryIndex(index: { rows: MemoryRow[]; omitted: number }): string` — 取代 `formatMemoryBlock`。
  - `export function memoryTools(db, projectId, instanceId): { memory_write, memory_read, memory_delete }`
  - `ManagerPromptInput`／`ConsultantPromptInput` 的 `memories: MemoryRow[]` 改成 `memories: { rows: MemoryRow[]; omitted: number }`；`build.ts` 兩處呼叫改用 `loadMemoryIndex`。

- [ ] **Step 1: 重寫 `memory.test.ts`**（沿用 `setup()`：一個專案、顧問 a、b）

```ts
it('memory_write 新增後同名同 scope 再寫是更新，不會多一筆', async () => {
  const t = memoryTools(db, projectId, a);
  expect(await t.memory_write.execute!({ name: 'risk', scope: 'project', type: 'user', description: '風險偏好', content: '保守' }, opts))
    .toEqual({ ok: true, action: 'created' });
  expect(await t.memory_write.execute!({ name: 'risk', scope: 'project', type: 'user', description: '風險偏好', content: '積極' }, opts))
    .toEqual({ ok: true, action: 'updated' });
  const { rows } = await loadMemoryIndex(db, projectId, a);
  expect(rows.map((r) => r.content)).toEqual(['積極']);
});

it('私有記憶互相隔離：同名時各自一筆，讀、改、刪都只動到自己的', async () => {
  // a、b 各寫 private 'note'，a 寫 project 'note'
  // memory_read(b, ['note']) 只回 b 的 private 與 project 兩筆
  // memory_delete(a, {name:'note', scope:'private'}) 後 b 的 private 還在
});

it('專案記憶任何一位顧問都能更新與刪除', async () => { /* a 寫 project，b 更新、b 刪除 */ });

it('memory_read 回傳 scope 與內容，找不到的列在 missing', async () => {
  // 期望 { memories: [{ name, scope: 'project', type, description, content }], missing: ['nope'] }
});

it('memory_delete 不存在時回傳錯誤', async () => {
  expect(await t.memory_delete.execute!({ name: 'nope', scope: 'private' }, opts))
    .toEqual({ error: '找不到私有記憶「nope」' });
});

it('formatMemoryIndex 標示 scope 與類型，超過上限時提示還有幾筆', () => {
  expect(formatMemoryIndex({ rows: [], omitted: 0 })).toBe('（目前沒有記憶）');
  expect(formatMemoryIndex({ rows: [row({ instance_id: null, type: 'user', name: 'user-profile', description: '科技業工程師' })], omitted: 12 }))
    .toBe('- [專案/user] user-profile — 科技業工程師\n（還有 12 筆較舊的記憶沒有列出，可以用 memory_read 依名稱讀取）');
});
```

另外：`build.test.ts` 的工具名稱清單把 `recall`、`remember` 換成 `memory_delete`、`memory_read`、`memory_write`；prompt 測試期望包含 `user（使用者是誰`、`不要新增重複的`、`相對日期`。`runtime-access.test.ts:44` 的 mock 改呼叫 `memory_write`（完整參數），並斷言資料庫裡多一筆該名稱的記憶。

- [ ] **Step 2: 執行確認失敗**

Run（Git Bash）：`pnpm -F @agenthub/runtime test test/memory.test.ts test/build.test.ts test/runtime-access.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**
  - 查詢「看得到」沿用 `instance_id.is.null,instance_id.eq.<id>`；scope 對應：`private` → `instance_id = <自己>`，`project` → `instance_id is null`。
  - `memory_write`：先 `select id` 找同 scope 同名 → 有就 `update { content, description, type, updated_at: now }`；沒有就 `insert`，若錯誤碼是 `23505` 改走 update。zod：`name` `z.string().trim().min(1).max(64).regex(/^[^\r\n]+$/)`、`description` `min(1).max(200)`、`content` `min(1).max(5000)`、`type` `z.enum(MEMORY_TYPES)`。
  - 三個工具的 description 依規格 4.4；`memory_write` 的 description 寫明「同名就是更新」。
  - `prompts.ts`：記憶一節＝`## 記憶`＋「以下是記憶索引。需要細節時用 memory_read 讀內容。」＋`formatMemoryIndex`＋規格 4.5 的規則（逐條照抄）。主管與顧問共用同一段。

- [ ] **Step 4: 執行確認通過**（需 Task 4 已推上去）

Run（Git Bash）：`pnpm -F @agenthub/runtime test` 與 `pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**（取得同意後）

```bash
git add packages/runtime/src/tools/memory.ts packages/runtime/src/agents/prompts.ts packages/runtime/src/agents/build.ts packages/runtime/test/memory.test.ts packages/runtime/test/build.test.ts packages/runtime/test/runtime-access.test.ts
git commit -m "feat(runtime): 記憶改成名稱、說明、類型與內容，索引常駐，可更新與刪除"
```

---

### Task 6: 網站的記憶面板與工具標籤

**Files:**
- Modify: `apps/web/lib/services/threads.ts:16,77-102`
- Modify: `apps/web/app/api/projects/[id]/memories/route.ts`（PATCH）
- Modify: `apps/web/components/workspace/memory-panel.tsx`
- Modify: `apps/web/lib/progress.ts:4-6`
- Test: `apps/web/test/threads.test.ts:95-115`
- Modify: `README.md`（「功能」一節的記憶描述）

**Interfaces:**
- Consumes: Task 4 的欄位。
- Produces:
  - `MemoryView = { id; instance_id: string | null; agent_name: string | null; name: string; description: string; type: string; content: string; updated_at: string }`
  - `updateMemory(db, userId, projectId, memoryId, patch: { content?: string; description?: string }): Promise<void>`

- [ ] **Step 1: 改 `threads.test.ts` 記憶測試**：insert 時帶 `name`、`description`、`type`；`listMemories` 期望含 `name`、`description`、`type`、依 `updated_at` 新到舊；`updateMemory(..., { description: '新說明' })` 後只改說明、內容不變。

- [ ] **Step 2: 執行確認失敗**

Run：`pnpm -F @agenthub/web test test/threads.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**
  - `listMemories` select 加欄位、`order('updated_at', { ascending: false })`。
  - `updateMemory` 只更新有給的欄位並設 `updated_at`。
  - PATCH schema：`{ id: z.uuid(), content: z.string().trim().min(1).max(5000).optional(), description: z.string().trim().min(1).max(200).optional() }`，兩者都沒有回 400「請提供要修改的內容或說明」。
  - 面板：每筆第一行「歸屬 · 類型中文（使用者／工作方式／專案／參考資料）」（`text-muted`），第二行說明（`font-medium`），第三行內容（`whitespace-pre-wrap`）；修改時說明用 `input.field`、內容用 `textarea.field`；提示文字改成規格 4.6 的句子。
  - `TOOL_LABELS`：刪 `remember`、`recall`，加 `memory_write: '寫入記憶'`、`memory_read: '讀取記憶'`、`memory_delete: '刪除記憶'`。
  - README「功能」：單一顧問一條的「自己決定要記住什麼」改成「會把你說過的事實、偏好與指示分類記下，並自己更新或刪除過時的記憶」。

- [ ] **Step 4: 執行確認通過**

Run：`pnpm test` 與 `pnpm typecheck`（根目錄，Git Bash）
Expected: 全部 PASS

- [ ] **Step 5: Commit**（取得同意後）

```bash
git add apps/web/lib/services/threads.ts "apps/web/app/api/projects/[id]/memories/route.ts" apps/web/components/workspace/memory-panel.tsx apps/web/lib/progress.ts apps/web/test/threads.test.ts README.md
git commit -m "feat(web): 記憶面板顯示名稱、說明與類型，可修改說明"
```

---

### Task 7: 部署與驗收（每一步都先取得使用者同意）

- [ ] **Step 1:** `pnpm test`、`pnpm typecheck` 全部通過（Git Bash，根目錄）。
- [ ] **Step 2:** `pnpm -F @agenthub/runtime publish-runtime` → `cd apps/web && pnpm exec tsx scripts/redeploy-runtime.ts`；Expected：每個就緒專案都印出更新成功。
- [ ] **Step 3:** 依使用者全域規則先跑 `superpowers:finishing-a-development-branch`，選 push 後 `git push origin main`；`vercel ls agenthub` 看到新部署 Ready。
- [ ] **Step 4:** `cd apps/web && BASE_URL=https://agenthub-kappa-pink.vercel.app pnpm exec tsx scripts/smoke.ts`；Expected：全部通過。
- [ ] **Step 5:** 在「金融科技展 Demo」專案問「用五 P 幫我看這家公司的授信風險：…」，確認派工卡片出現「載入 skill」步驟；說一句「我偏好保守型配置」再改口「改成積極型」，記憶面板只剩一筆且內容是積極型。

# 平台代管 MCP（3b）計畫 B：創作者頁面

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 創作者在範本編輯頁就能把 MCP 交給平台代管：設定金鑰、上傳 zip 部署、看部署進度與日誌、發布、下架，不必呼叫 API。

**Architecture:**
- 計畫 A 的 API 已上線，本計畫主要是前端。
- 後端只補三件小事：
  - 版本列表附上「幾個專案在用」。
  - 讀取金鑰名稱（不含值）。
  - 金鑰值不能是空的。
- 前端邏輯放在 `lib/` 的純函式並寫單元測試（專案慣例：元件本身沒有元件測試）：
  - MCP 表單草稿的轉換。
  - 版本狀態的文字與可用動作。
  - zip 檢查。
- 元件 `HostedMcpPanel` 放在編輯頁「工具（MCP）」區塊裡，只在該 MCP 已儲存為平台代管時出現。

**Tech Stack:** Next.js 16（client component）、Tailwind（既有 class：`panel`、`field`、`btn`、`chip`、`notice`、`hint`、`label`）、Vitest、Playwright（本機瀏覽器驗收）。

**Spec:** `docs/superpowers/specs/2026-10-15-hosted-mcp-3b-design.md`（第 2.2 節頁面流程；計畫 A：`docs/superpowers/plans/2026-10-15-hosted-mcp-a.md`）

## Global Constraints

- 頁面流程（spec 2.2）：
  1. 範本的 MCP 選「平台代管」。
  2. 填金鑰（名稱與值），值只能覆寫，不會再顯示。
  3. 上傳 zip，按「部署」，建立新版本。
  4. 每 5 秒更新狀態並顯示日誌：成功列出工具清單；失敗顯示日誌最後 100 行。
  5. 確認工具清單後按「發布這個版本」。
  6. 舊版本沒有任何專案在用時可以「下架」。
  7. 範本上架時，每個代管 MCP 都必須至少有一個已發布版本（伺服器已檢查，頁面顯示錯誤訊息即可）。
- 套件 zip 最大 50 MB；部署最長 10 分鐘。
- 版本狀態：`pending`、`deploying`、`ready`、`failed`、`published`、`retired`、`disabled`。
- 金鑰名稱：`^[A-Z][A-Z0-9_]*$`；`PORT` 與 `AGENTHUB_` 開頭保留。
- 所有使用者看得到的文字用繁體中文，語氣與既有編輯頁一致。
- `corepack pnpm`；本計畫不改 runtime、不需要 migration。
- 每個 Task 完成就在本機 commit；push 與正式環境操作先告知使用者。

## Review Focus

1. 創作者部署到一半離開頁面，回來時版本還在「部署中」→ 頁面要自動恢復每 5 秒更新，而不是停在舊狀態。→ Task 3 `pollingIds` 測試。
2. 選了超過 50 MB 或不是 zip 的檔案 → 在建立版本之前就擋下，不留下沒用的「等待上傳」版本。→ Task 3 `zipProblem` 測試。
3. 編輯範本其他欄位（名稱、prompt）後儲存 → 代管 MCP 的 `hosted: true` 不能在表單來回轉換時遺失，否則已發布的版本會變成孤兒、範本變成需要網址。→ Task 2 往返測試。
4. 金鑰列留了空白的值就按儲存 → 不能把既有金鑰覆寫成空字串。→ Task 1 伺服器檢查、Task 3 `secretRowsToSave` 測試。
5. 還有專案在用的版本 → 不顯示「下架」按鈕（伺服器也會擋）；部署失敗的版本可以下架以釋放名額。→ Task 3 `canRetire` 測試。

---

## 檔案結構

```text
apps/web/lib/services/hosted-mcp.ts                    listVersions 附 projects；新增 listHostedSecretKeys
apps/web/app/api/templates/[id]/hosted/[mcp]/secrets/route.ts   新增 GET；PUT 的值不能是空的
apps/web/lib/mcp-draft.ts                              編輯頁 MCP 表單草稿 ↔ McpServer（從 template-editor 搬出，加 hosted）
apps/web/lib/hosted-ui.ts                              版本狀態文字、可用動作、輪詢對象、zip 檢查、要儲存的金鑰列
apps/web/components/hosted-mcp-panel.tsx               代管區塊（金鑰、部署、版本列表）
apps/web/components/template-editor.tsx                改用 lib/mcp-draft；新增「交給平台代管」選項並放入代管區塊
docs/creator/hosted-mcp.md                             改寫成以頁面操作為主，API 移到附錄
README.md                                              已知限制更新
```

---

### Task 0：基準線

- [ ] 在分支 `feat/hosted-mcp-ui` 上跑 `cd apps/web && npx vitest run`，記錄結果（預期 160/160）。

### Task 1：後端補充（專案數、金鑰名稱、空值檢查）

**Files:** Modify `apps/web/lib/services/hosted-mcp.ts`、`apps/web/app/api/templates/[id]/hosted/[mcp]/secrets/route.ts`；Test `apps/web/test/hosted-mcp.test.ts`、`apps/web/test/hosted-mcp-routes.test.ts`

**Interfaces — Produces:**

```ts
export type HostedVersionView = HostedVersion & { projects: number };
export async function listVersions(db: Db, userId: string, templateId: string, mcpName: string): Promise<HostedVersionView[]>;
export async function listHostedSecretKeys(db: Db, userId: string, templateId: string, mcpName: string): Promise<string[]>;
// GET  /api/templates/:id/hosted/:mcp/secrets → { keys: string[] }
// PUT  /api/templates/:id/hosted/:mcp/secrets → 值是空字串時 400「金鑰的值不能是空的」
```

- [ ] **Step 1：測試**（加到 `test/hosted-mcp.test.ts` 的「代管版本：發布、下架、金鑰」describe）：

```ts
  it('版本列表附上使用中的專案數；金鑰只列名稱', async () => {
    const creator = await seedUser(db);
    const renter = await seedUser(db);
    const t = await hostedTemplate(creator.id);
    const v1 = await insertVersion(t.id, 1, 'published');
    await insertVersion(t.id, 2, 'ready');
    await publishTemplate(db, creator.id, t.id);
    const p = await createProject(db, renter.id, 'p');
    await hireAgent(db, renter.id, p.id, t.id, {});
    try {
      const list = await listVersions(db, creator.id, t.id, 'fin');
      expect(list.map((v) => [v.version, v.projects])).toEqual([[2, 0], [1, 1]]);
      expect(list.find((v) => v.id === v1)!.projects).toBe(1);

      const { ops } = fakeSprites();
      await setHostedSecrets(db, creator.id, t.id, 'fin', { ZETA: 'z', API_KEY: 'k' }, ops);
      expect(await listHostedSecretKeys(db, creator.id, t.id, 'fin')).toEqual(['API_KEY', 'ZETA']);
      await expectStatus(listHostedSecretKeys(db, renter.id, t.id, 'fin'), 404);
    } finally {
      await deleteOwnProject(db, renter.id, p.id);
    }
  });
```

  並在檔頭的 import 加入 `listHostedSecretKeys`。

  在 `test/hosted-mcp-routes.test.ts` 的「金鑰」測試加入：

```ts
    expect((await secretsRoute(req(creatorToken, 'PUT', { secrets: { API_KEY: '' } }), ctx(p))).status).toBe(400);
    const keys = await (await secretsGetRoute(req(creatorToken), ctx(p))).json();
    expect(keys).toEqual({ keys: ['API_KEY'] });
    expect((await secretsGetRoute(req(otherToken), ctx(p))).status).toBe(404);
```

  （放在既有的 `ok.status` 檢查之後；檔頭的 import 改成 `const { GET: secretsGetRoute, PUT: secretsRoute } = await import(...)`；401 測試的陣列也加入 `secretsGetRoute(req('bad'), ctx(v))`，預期 401 的個數改成 8。）

- [ ] **Step 2：** `npx vitest run test/hosted-mcp.test.ts test/hosted-mcp-routes.test.ts` → FAIL（`listHostedSecretKeys` 不存在、`projects` undefined、GET 不存在）。
- [ ] **Step 3：實作**

  `hosted-mcp.ts`：

```ts
export type HostedVersionView = HostedVersion & { projects: number };

export async function listVersions(db: Db, userId: string, templateId: string, mcpName: string): Promise<HostedVersionView[]> {
  await ownHostedMcp(db, userId, templateId, mcpName);
  const { data, error } = await db.from('hosted_mcp_versions').select('*')
    .eq('template_id', templateId).eq('mcp_name', mcpName).order('version', { ascending: false });
  if (error) throw error;
  const versions = data as HostedVersion[];
  if (versions.length === 0) return [];
  const { data: targets, error: targetError } = await db.from('remote_mcp_targets').select('hosted_version_id')
    .in('hosted_version_id', versions.map((v) => v.id));
  if (targetError) throw targetError;
  const counts = new Map<string, number>();
  for (const t of targets as { hosted_version_id: string }[]) counts.set(t.hosted_version_id, (counts.get(t.hosted_version_id) ?? 0) + 1);
  return versions.map((v) => ({ ...v, projects: counts.get(v.id) ?? 0 }));
}

/** 只回傳名稱：值寫入後不再顯示 */
export async function listHostedSecretKeys(db: Db, userId: string, templateId: string, mcpName: string): Promise<string[]> {
  await ownHostedMcp(db, userId, templateId, mcpName);
  const { data, error } = await db.from('hosted_mcp_secrets').select('key')
    .eq('template_id', templateId).eq('mcp_name', mcpName).order('key');
  if (error) throw error;
  return (data as { key: string }[]).map((r) => r.key);
}
```

  `secrets/route.ts`：Body 改成 `z.record(z.string(), z.string('金鑰的值必須是文字').min(1, '金鑰的值不能是空的'))`，新增：

```ts
export const GET = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(req);
  const { id, mcp } = await params;
  return { keys: await listHostedSecretKeys(adminDb(), user.id, id, mcp) };
});
```

- [ ] **Step 4：** 兩個測試檔通過；`npx tsc --noEmit -p .`、`npx eslint .` 乾淨。
- [ ] **Step 5：Commit** — `feat(web): 代管 MCP 版本列表附使用中的專案數，金鑰可讀取名稱`

### Task 2：MCP 表單草稿（含平台代管）

**Files:** Create `apps/web/lib/mcp-draft.ts`；Modify `apps/web/components/template-editor.tsx`（改 import，刪掉檔內的 `McpDraft`／`toDraft`／`fromDraft`／`emptyDraft`）；Test `apps/web/test/mcp-draft.test.ts`

**Interfaces — Produces:**

```ts
export type McpDraft = { name: string; transport: 'stdio' | 'http' | 'remote' | 'hosted'; command: string; args: string; url: string; headers: string; secrets: string };
export const emptyDraft: McpDraft;
export function toDraft(s: McpServer): McpDraft;
export function fromDraft(d: McpDraft): McpServer;
/** 這個名稱在已儲存的設定裡是平台代管（才能呼叫代管 API） */
export function isSavedHosted(saved: McpServer[], name: string): boolean;
```

- [ ] **Step 1：測試** `test/mcp-draft.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { emptyDraft, fromDraft, isSavedHosted, toDraft } from '@/lib/mcp-draft';
import type { McpServer } from '@/lib/schemas';

describe('MCP 表單草稿', () => {
  it('平台代管往返後仍是 hosted，不帶網址與金鑰', () => {
    const hosted: McpServer = { name: 'fin', transport: 'remote', hosted: true, required_secrets: [] };
    expect(toDraft(hosted).transport).toBe('hosted');
    expect(fromDraft(toDraft(hosted))).toEqual({ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] });
    expect(fromDraft({ ...emptyDraft, name: ' fin ', transport: 'hosted', url: 'https://x', secrets: 'A' }))
      .toEqual({ name: 'fin', transport: 'remote', hosted: true, required_secrets: [] });
  });

  it('自己架的 remote、stdio、http 照舊', () => {
    const remote: McpServer = { name: 'r', transport: 'remote', url: 'https://c.example/mcp', required_secrets: [] };
    expect(fromDraft(toDraft(remote))).toEqual(remote);
    const stdio: McpServer = { name: 's', transport: 'stdio', command: 'npx', args: ['-y', 'x'], required_secrets: [{ key: 'K' }] };
    expect(fromDraft(toDraft(stdio))).toEqual(stdio);
    const http: McpServer = { name: 'h', transport: 'http', url: 'https://h', headers: { Authorization: 'Bearer ${K}' }, required_secrets: [{ key: 'K' }] };
    expect(fromDraft(toDraft(http))).toEqual(http);
  });

  it('isSavedHosted：只有已儲存且為平台代管的名稱', () => {
    const saved: McpServer[] = [
      { name: 'fin', transport: 'remote', hosted: true, required_secrets: [] },
      { name: 'web', transport: 'remote', url: 'https://w', required_secrets: [] },
    ];
    expect(isSavedHosted(saved, 'fin')).toBe(true);
    expect(isSavedHosted(saved, 'web')).toBe(false);
    expect(isSavedHosted(saved, 'new')).toBe(false);
  });
});
```

- [ ] **Step 2：** `npx vitest run test/mcp-draft.test.ts` → FAIL（找不到模組）。
- [ ] **Step 3：實作** `lib/mcp-draft.ts`：把 `template-editor.tsx` 第 10–45 行的型別與函式搬過來並匯出，修改處：

```ts
export type McpDraft = {
  name: string;
  transport: 'stdio' | 'http' | 'remote' | 'hosted';
  command: string;
  args: string;
  url: string;
  headers: string;
  secrets: string;
};

export function toDraft(s: McpServer): McpDraft {
  return {
    name: s.name,
    transport: s.transport === 'remote' && s.hosted ? 'hosted' : s.transport,
    command: s.command ?? '',
    args: (s.args ?? []).join(' '),
    url: s.url ?? '',
    headers: Object.entries(s.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    secrets: (s.required_secrets ?? []).map((r) => r.key).join(', '),
  };
}

export function fromDraft(d: McpDraft): McpServer {
  const required_secrets = d.secrets.split(',').map((k) => k.trim()).filter(Boolean).map((key) => ({ key }));
  if (d.transport === 'stdio') {
    return { name: d.name.trim(), transport: 'stdio', command: d.command.trim(), args: d.args.split(/\s+/).filter(Boolean), required_secrets };
  }
  // 平台代管：金鑰在代管區塊設定，不放在範本設定裡
  if (d.transport === 'hosted') return { name: d.name.trim(), transport: 'remote', hosted: true, required_secrets: [] };
  if (d.transport === 'remote') return { name: d.name.trim(), transport: 'remote', url: d.url.trim(), required_secrets: [] };
  const headers = Object.fromEntries(
    d.headers.split('\n').map((line) => line.split(/:([\s\S]*)/).map((x) => x.trim())).filter(([k, v]) => k && v),
  );
  return { name: d.name.trim(), transport: 'http', url: d.url.trim(), headers, required_secrets };
}

export const emptyDraft: McpDraft = { name: '', transport: 'stdio', command: '', args: '', url: '', headers: '', secrets: '' };

export function isSavedHosted(saved: McpServer[], name: string): boolean {
  return saved.some((s) => s.name === name && s.transport === 'remote' && s.hosted === true);
}
```

  `template-editor.tsx`：刪掉搬走的部分，改成 `import { emptyDraft, fromDraft, toDraft, type McpDraft } from '@/lib/mcp-draft';`。連線方式的 `<select>` 加 `<option value="hosted">交給平台代管（上傳程式）</option>`（放在「你自己架的 MCP」之後）；「需要的金鑰名稱」欄位的條件從 `d.transport !== 'remote'` 改成 `d.transport !== 'remote' && d.transport !== 'hosted'`；`d.transport === 'remote'` 的網址區塊不變。代管區塊在 Task 4 加入，這一步在 `hosted` 時先顯示：

```tsx
                ) : d.transport === 'hosted' ? (
                  <p className="hint">儲存後就能在這裡設定金鑰、上傳程式並部署。</p>
```

  （插在 `d.transport === 'remote' ? (...)` 之前，三元式順序改成 stdio → hosted → remote → http。）
- [ ] **Step 4：** `npx vitest run test/mcp-draft.test.ts` 通過；typecheck、lint 乾淨。
- [ ] **Step 5：Commit** — `feat(web): 範本編輯頁的工具可以選「交給平台代管」`

### Task 3：代管區塊的純函式

**Files:** Create `apps/web/lib/hosted-ui.ts`；Test `apps/web/test/hosted-ui.test.ts`

**Interfaces — Consumes:** `HostedVersionView`（Task 1）。**Produces:**

```ts
export const POLL_MS = 5000;
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
export function statusLabel(status: string): string;
export function statusChip(status: string): '' | 'chip-sage' | 'chip-seal' | 'chip-brand';
export function canPublish(v: Pick<HostedVersionView, 'status'>): boolean;
export function canRetire(v: Pick<HostedVersionView, 'status' | 'projects'>): boolean;
/** 需要每 5 秒更新的版本 id（部署中） */
export function pollingIds(versions: Pick<HostedVersionView, 'id' | 'status'>[]): string[];
/** 頁面列出的版本：不含已下架，新的在前 */
export function visibleVersions<T extends Pick<HostedVersionView, 'status' | 'version'>>(versions: T[]): T[];
/** 檔案有問題回傳訊息，沒問題回傳 null */
export function zipProblem(file: { name: string; size: number }): string | null;
/** 金鑰表單要送出的內容：略過名稱或值空白的列；名稱去空白 */
export function secretRowsToSave(rows: { key: string; value: string }[]): Record<string, string>;
```

- [ ] **Step 1：測試** `test/hosted-ui.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  canPublish, canRetire, MAX_ZIP_BYTES, pollingIds, secretRowsToSave, statusChip, statusLabel, visibleVersions, zipProblem,
} from '@/lib/hosted-ui';

describe('代管區塊', () => {
  it('狀態文字與顏色', () => {
    expect(statusLabel('pending')).toBe('等待上傳');
    expect(statusLabel('deploying')).toBe('部署中');
    expect(statusLabel('ready')).toBe('部署成功，尚未發布');
    expect(statusLabel('failed')).toBe('部署失敗');
    expect(statusLabel('published')).toBe('已發布');
    expect(statusLabel('disabled')).toBe('已被平台停用');
    expect(statusLabel('weird')).toBe('weird');
    expect(statusChip('published')).toBe('chip-sage');
    expect(statusChip('failed')).toBe('chip-seal');
    expect(statusChip('disabled')).toBe('chip-seal');
    expect(statusChip('deploying')).toBe('chip-brand');
    expect(statusChip('pending')).toBe('');
  });

  it('只有部署成功的能發布；沒有專案在用、且不是部署中或停用的才能下架', () => {
    expect(canPublish({ status: 'ready' })).toBe(true);
    expect(canPublish({ status: 'published' })).toBe(false);
    for (const status of ['pending', 'ready', 'failed', 'published']) expect(canRetire({ status, projects: 0 })).toBe(true);
    expect(canRetire({ status: 'published', projects: 2 })).toBe(false);
    for (const status of ['deploying', 'retired', 'disabled']) expect(canRetire({ status, projects: 0 })).toBe(false);
  });

  it('離開頁面再回來時，部署中的版本要繼續更新', () => {
    expect(pollingIds([{ id: 'a', status: 'published' }, { id: 'b', status: 'deploying' }, { id: 'c', status: 'pending' }])).toEqual(['b']);
    expect(pollingIds([])).toEqual([]);
  });

  it('列表不含已下架，新的在前', () => {
    const vs = [{ version: 1, status: 'retired' }, { version: 3, status: 'ready' }, { version: 2, status: 'published' }];
    expect(visibleVersions(vs).map((v) => v.version)).toEqual([3, 2]);
  });

  it('zip 檢查在建立版本之前擋下', () => {
    expect(zipProblem({ name: 'mcp.zip', size: 1000 })).toBeNull();
    expect(zipProblem({ name: 'MCP.ZIP', size: MAX_ZIP_BYTES })).toBeNull();
    expect(zipProblem({ name: 'mcp.tar.gz', size: 1000 })).toBe('請上傳 .zip 檔');
    expect(zipProblem({ name: 'mcp.zip', size: MAX_ZIP_BYTES + 1 })).toBe('套件超過 50 MB');
    expect(zipProblem({ name: 'mcp.zip', size: 0 })).toBe('檔案是空的');
  });

  it('金鑰表單：略過空白列，不會把既有金鑰覆寫成空值', () => {
    expect(secretRowsToSave([
      { key: ' API_KEY ', value: 'v' }, { key: 'EMPTY', value: '' }, { key: '', value: 'orphan' }, { key: 'B', value: 'b' },
    ])).toEqual({ API_KEY: 'v', B: 'b' });
  });
});
```

- [ ] **Step 2：** `npx vitest run test/hosted-ui.test.ts` → FAIL（找不到模組）。
- [ ] **Step 3：實作** `lib/hosted-ui.ts`：

```ts
import type { HostedVersionView } from '@/lib/services/hosted-mcp';

export const POLL_MS = 5000;
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;

const LABELS: Record<string, string> = {
  pending: '等待上傳',
  deploying: '部署中',
  ready: '部署成功，尚未發布',
  failed: '部署失敗',
  published: '已發布',
  retired: '已下架',
  disabled: '已被平台停用',
};

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export function statusChip(status: string): '' | 'chip-sage' | 'chip-seal' | 'chip-brand' {
  if (status === 'published') return 'chip-sage';
  if (status === 'failed' || status === 'disabled') return 'chip-seal';
  if (status === 'deploying') return 'chip-brand';
  return '';
}

export function canPublish(v: Pick<HostedVersionView, 'status'>): boolean {
  return v.status === 'ready';
}

export function canRetire(v: Pick<HostedVersionView, 'status' | 'projects'>): boolean {
  return ['pending', 'ready', 'failed', 'published'].includes(v.status) && v.projects === 0;
}

export function pollingIds(versions: Pick<HostedVersionView, 'id' | 'status'>[]): string[] {
  return versions.filter((v) => v.status === 'deploying').map((v) => v.id);
}

export function visibleVersions<T extends Pick<HostedVersionView, 'status' | 'version'>>(versions: T[]): T[] {
  return versions.filter((v) => v.status !== 'retired').sort((a, b) => b.version - a.version);
}

export function zipProblem(file: { name: string; size: number }): string | null {
  if (!/\.zip$/i.test(file.name)) return '請上傳 .zip 檔';
  if (file.size === 0) return '檔案是空的';
  if (file.size > MAX_ZIP_BYTES) return '套件超過 50 MB';
  return null;
}

export function secretRowsToSave(rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key && r.value) out[key] = r.value;
  }
  return out;
}
```

- [ ] **Step 4：** 測試通過；typecheck、lint 乾淨。
- [ ] **Step 5：Commit** — `feat(web): 代管區塊的狀態文字、可用動作與檔案檢查`

### Task 4：代管區塊元件並放進編輯頁

**Files:** Create `apps/web/components/hosted-mcp-panel.tsx`；Modify `apps/web/components/template-editor.tsx`

**Interfaces — Consumes:** Task 1 的 API 回應（`HostedVersionView[]`、`{ keys }`）、Task 2 的 `isSavedHosted`、Task 3 的全部函式；既有 `api()`（`lib/client-api.ts`）、`FileButton`。**Produces:** `HostedMcpPanel({ templateId, mcpName }: { templateId: string; mcpName: string })`。

- [ ] **Step 1：元件** `components/hosted-mcp-panel.tsx`：

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileButton } from '@/components/file-button';
import { api } from '@/lib/client-api';
import {
  canPublish, canRetire, POLL_MS, pollingIds, secretRowsToSave, statusChip, statusLabel, visibleVersions, zipProblem,
} from '@/lib/hosted-ui';
import type { HostedVersionView } from '@/lib/services/hosted-mcp';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** 平台代管 MCP：金鑰、部署新版本、版本列表（發布、下架）。只在 MCP 已儲存為平台代管時使用。 */
export function HostedMcpPanel({ templateId, mcpName }: { templateId: string; mcpName: string }) {
  const base = `/api/templates/${templateId}/hosted/${encodeURIComponent(mcpName)}`;
  const [versions, setVersions] = useState<HostedVersionView[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [rows, setRows] = useState([{ key: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    const [vs, s] = await Promise.all([api<HostedVersionView[]>(`${base}/versions`), api<{ keys: string[] }>(`${base}/secrets`)]);
    setVersions(vs);
    setKeys(s.keys);
  }, [base]);

  useEffect(() => {
    load().catch((e) => setMessage({ kind: 'error', text: (e as Error).message }));
  }, [load]);

  // 部署中的版本每 5 秒讀一次；讀取本身會推進部署（離開頁面再回來也會繼續）
  const polling = pollingIds(versions).join(',');
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      for (const id of polling.split(',')) {
        api<HostedVersionView>(`${base}/versions/${id}`)
          .then((v) => setVersions((all) => all.map((x) => (x.id === v.id ? { ...v, projects: x.projects } : x))))
          .catch((e) => setMessage({ kind: 'error', text: (e as Error).message }));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, base]);

  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'ok', text: label });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      await load().catch(() => undefined);
      setBusy(false);
    }
  }

  const saveSecrets = () => {
    const secrets = secretRowsToSave(rows);
    if (Object.keys(secrets).length === 0) {
      setMessage({ kind: 'error', text: '請填寫金鑰名稱與值' });
      return;
    }
    void act('金鑰已儲存，執行中的版本會重新啟動', async () => {
      await api(`${base}/secrets`, { method: 'PUT', body: JSON.stringify({ secrets }) });
      setRows([{ key: '', value: '' }]);
    });
  };

  async function deploy(file: File) {
    const problem = zipProblem(file);
    if (problem) {
      setMessage({ kind: 'error', text: problem });
      return;
    }
    setUploading(true);
    await act('已開始部署，大約需要 1 分鐘', async () => {
      const { version, signedUrl } = await api<{ version: HostedVersionView; signedUrl: string }>(`${base}/versions`, { method: 'POST' });
      const res = await fetch(signedUrl, { method: 'PUT', body: file, headers: { 'content-type': 'application/zip', 'x-upsert': 'true' } });
      if (!res.ok) throw new Error(`上傳失敗（${res.status}），請下架這個等待上傳的版本後再試一次`);
      await api(`${base}/versions/${version.id}/deploy`, { method: 'POST' });
    });
    setUploading(false);
  }

  const publish = (v: HostedVersionView) =>
    void act(`版本 ${v.version} 已發布，之後新加入的專案會使用這個版本`, () => api(`${base}/versions/${v.id}/publish`, { method: 'POST' }));

  const retire = (v: HostedVersionView) => {
    if (!window.confirm(`確定下架版本 ${v.version}？下架後無法復原。`)) return;
    void act(`版本 ${v.version} 已下架`, () => api(`${base}/versions/${v.id}`, { method: 'DELETE' }));
  };

  const shown = visibleVersions(versions);
  return (
    <div className="space-y-5 rounded-xl bg-sunken p-4">
      <div>
        <div className="label">金鑰</div>
        <p className="hint">只會注入你的代管程式。值儲存後不會再顯示；同名稱再存一次就是覆寫。</p>
        {keys.length > 0 && <p className="mt-2 text-sm">已設定：{keys.map((k) => <span key={k} className="chip mr-1">{k}</span>)}</p>}
        <div className="mt-2 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-2">
              <input disabled={busy} className="field" placeholder="名稱，例如 API_KEY" value={r.key} aria-label="金鑰名稱"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              <input disabled={busy} className="field" type="password" autoComplete="off" placeholder="值" value={r.value} aria-label="金鑰的值"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="btn btn-sm btn-secondary" onClick={() => setRows([...rows, { key: '', value: '' }])}>再加一個</button>
          <button type="button" disabled={busy} className="btn btn-sm btn-secondary" onClick={saveSecrets}>儲存金鑰</button>
        </div>
      </div>

      <div>
        <div className="label">部署新版本</div>
        <p className="hint">上傳 zip（最大 50 MB），根目錄要有 mcp.json。格式與範本見創作者文件「交給平台代管」。</p>
        <FileButton label="上傳 zip 並部署" accept=".zip,application/zip" busy={busy} uploading={uploading} className="mt-2" onFile={(f) => void deploy(f)} />
      </div>

      <div>
        <div className="label">版本</div>
        {shown.length === 0 && <p className="hint">還沒有版本。</p>}
        <ul className="mt-2 space-y-3">
          {shown.map((v) => (
            <li key={v.id} className="panel space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">版本 {v.version}</span>
                <span className={`chip ${statusChip(v.status)}`}>{statusLabel(v.status)}</span>
                {v.projects > 0 && <span className="text-sm text-muted">{v.projects} 個專案使用中</span>}
              </div>
              {v.status === 'deploying' && <p className="hint">部署中，每 5 秒自動更新，最長 10 分鐘。</p>}
              {(v.status === 'ready' || v.status === 'published') && v.tools.length > 0 && (
                <p className="text-sm">工具：{(v.tools as { name: string }[]).map((t) => t.name).join('、')}</p>
              )}
              {(v.status === 'deploying' || v.status === 'failed') && v.log_tail && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-xs">{v.log_tail}</pre>
              )}
              <div className="flex flex-wrap gap-2">
                {canPublish(v) && <button type="button" disabled={busy} className="btn btn-sm btn-primary" onClick={() => publish(v)}>發布這個版本</button>}
                {canRetire(v) && <button type="button" disabled={busy} className="btn btn-sm text-seal hover:bg-seal/10" onClick={() => retire(v)}>下架</button>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`notice whitespace-pre-line ${message.kind === 'error' ? 'notice-error' : 'notice-info'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
```

  （`bg-surface`、`bg-sunken` 來自 `globals.css` 的 `--color-surface`、`--color-sunken`，深色模式已有對應值。）

- [ ] **Step 2：放進編輯頁** `template-editor.tsx`：import `HostedMcpPanel` 與 `isSavedHosted`；Task 2 的提示改成：

```tsx
                ) : d.transport === 'hosted' ? (
                  isSavedHosted(t.mcp_servers, d.name.trim())
                    ? <HostedMcpPanel templateId={t.id} mcpName={d.name.trim()} />
                    : <p className="hint">先按「儲存」，就能在這裡設定金鑰、上傳程式並部署。</p>
```

  「工具（MCP）」區塊的說明文字改成：`需要金鑰的工具，租用的人會在加入時填自己的金鑰；交給平台代管的工具，金鑰由你設定。`
- [ ] **Step 3：** `npx tsc --noEmit -p .`、`npx eslint .`、`npx vitest run` 全部通過（元件沒有單元測試，行為在 Task 6 用瀏覽器驗收）。
- [ ] **Step 4：Commit** — `feat(web): 範本編輯頁的平台代管區塊（金鑰、部署、發布、下架）`

### Task 5：文件

**Files:** Modify `docs/creator/hosted-mcp.md`、`README.md`

- [ ] **Step 1：** `docs/creator/hosted-mcp.md` 第 2、3 節改寫：
  - 第 2 節「在範本加入」：編輯頁「工具（MCP）」→ 新增工具 → 連線方式選「交給平台代管（上傳程式）」→ 儲存。
  - 第 3 節「部署、發布、下架」改成頁面步驟（對應 spec 2.2 的 1–7）：設定金鑰 → 上傳 zip 並部署 → 等狀態（每 5 秒更新，失敗看日誌）→ 發布這個版本 → 沒人用的舊版本可以下架 → 上架範本。
  - 原本的 API 表格移到最後的「附錄：用 API 操作」，加上 `GET /secrets`（只回傳名稱）。
- [ ] **Step 2：** `README.md`：
  - 「上架顧問的格式」裡 `hosted: true` 那段的「目前以 API 操作（創作者頁面尚未完成）」改成「在範本編輯頁操作」。
  - 「已知限制」的「目前只有 API，創作者頁面尚未完成；」刪除。
- [ ] **Step 3：Commit** — `docs: 創作者文件改成以頁面操作平台代管 MCP`

### Task 6：本機瀏覽器驗收與上線（對外動作先告知使用者）

**Files:** Create（不 commit）`apps/web/scripts/zz-seed-hosted-ui.mts`

- [ ] **Step 1：準備資料**（腳本，打正式資料庫，用完刪除）：
  - 建一個 `@test.local` 測試帳號（密碼由腳本隨機產生，寫進 scratchpad 的檔案，不在對話中顯示）。
  - 建一個範本 `代管頁面驗收`，MCP `fin` 為平台代管。
  - 直接插入四個版本：`published`（Sprite 名稱留空，`tools` 有 `echo`）、`ready`（`tools` 有 `echo`）、`failed`（`log_tail` 多行）、`retired`。
  - 再建一個租用專案並加入這位顧問，讓 `published` 版本「1 個專案使用中」。
- [ ] **Step 2：** 本機 `pnpm -F web dev`（localhost:3000），用 Playwright 以測試帳號登入、開 `/creator/<範本 id>`，逐項確認並截圖：
  1. 「工具」區塊顯示代管區塊；版本列出 `ready`、`published`、`failed` 三個，不含 `retired`，新的在前。
  2. `published` 顯示「1 個專案使用中」且沒有下架按鈕；`ready` 有「發布這個版本」與「下架」；`failed` 顯示日誌與「下架」。
  3. 填一組金鑰儲存 → 「已設定」出現名稱、欄位清空；值空白的列按儲存 → 錯誤訊息。
  4. 選一個非 zip 的檔案 → 錯誤訊息，版本列表沒有多出「等待上傳」。
  5. 新增一個 MCP 選「交給平台代管」但不儲存 → 顯示「先按「儲存」」提示。
  6. 下架 `failed` 版本 → 從列表消失。
  7. 手機寬度（390px）版面不爆版。
- [ ] **Step 3：** 清理：刪除租用專案、範本、測試帳號、seed 腳本與密碼檔；確認 `mcp-bundles` 沒有留下檔案。
- [ ] **Step 4：** 實際部署流程（上傳 → 部署中 → 部署成功）在本機無法跑完（本機沒有正式的 `MCP_SIGNING_KEY`），上線後請使用者在正式站用 `docs/creator/examples/hosted-python` 壓成的 zip 操作一次；或由我以 API 驗收腳本確認後端仍正常。
- [ ] **Step 5：** finishing-a-development-branch → 合併、push `main`、確認 Vercel 部署成功。

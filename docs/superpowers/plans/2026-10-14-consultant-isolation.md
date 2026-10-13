# 顧問之間隔離（子專案 2）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每位顧問以自己的 Linux 帳號執行，讀不到其他顧問的 skill 與工作目錄；主管（`agent`）只讀得到 `/shared`；每個帳號有私人 `/tmp`。

**Architecture:** 佈建時多安裝一支 root 腳本 `agenthub-sandbox-adduser`，runtime 每次 run 前以 sudo 呼叫它確保顧問帳號與目錄存在；沙盒腳本 `agenthub-sandbox` 降權前多掛一個私人 `/tmp`；runtime 依顧問 id 決定以哪個帳號執行。

**Tech Stack:** 同子專案 1-A（Node `child_process`、sudo、unshare、setpriv、`@fly/sprites`、Vitest）。

**Spec:** `docs/superpowers/specs/2026-10-13-consultant-isolation-design.md`；前提 `docs/superpowers/specs/2026-10-13-platform-key-isolation-design.md`；長期參考 `docs/security-model.md`。

## Global Constraints

- 顧問帳號 `agent-<顧問 id 去掉連字號後的前 12 個小寫十六進位字元>`；主管帳號 `agent`。
- `/workspace/agents` 改為 `sprite:workspace 0711`（只有 runtime 能在裡面建立項目；顧問只能進入自己的目錄）。`/workspace/agents/<id>` 為 `sprite:agent-<id12> 2770`。`/workspace/shared` 維持 `sprite:workspace 2770`。
- 私人 `/tmp` 的實體位置 `/var/lib/agenthub/tmp/<帳號>`（`700`，擁有者是該帳號）；父目錄 `/var/lib/agenthub/tmp` 是 `root:root 711`。不可放在 `/var/tmp`（人人可寫，會被搶先建立或換成 symlink）。
- 兩支 root 腳本開頭都重設 `PATH`、清掉 `LD_*`／`BASH_ENV`／`ENV`／`IFS`／`SHELLOPTS`，指令用絕對路徑，`set -eu`；參數不合格就失敗。
- adduser 腳本拒絕處理 symlink；`chgrp -R` 使用預設 `-P`（不跟隨 symlink）。
- 未設定 `SANDBOX_USER`（本機開發）時不建立帳號，行為與現在相同。
- 用 `corepack pnpm`；測試直接打雲端 Supabase；Windows 的既有基準失敗（runtime 6 個）照舊。
- 本分支每個 Task 在本機自動 commit（使用者已授權相同流程）；建立／刪除暫時 Sprite、push、`publish-runtime`、`redeploy-runtime` 執行前先取得使用者同意。

## Review Focus

1. **顧問在 `/workspace/agents` 先建立別人的目錄名稱（或 symlink）**：root 的 adduser 不可因此 chown 到別處，也不可讓顧問搶到別人的目錄。→ Task 3 的 `0711` 與 symlink 檢查；Task 4 驗收「顧問不能在 `/workspace/agents` 建立項目」。
2. **私人 `/tmp` 的位置被搶先建立**：→ 放在 root 專用的 `/var/lib/agenthub/tmp`；Task 4 驗收顧問 B 讀不到顧問 A 的私人 tmp 實體路徑。
3. **runtime 先發布、Sprite 還沒裝 adduser**：所有 run 都會失敗。→ 部署順序固定為 push（web）→ publish → 立即 redeploy；Task 6。
4. **1-A 時期留下的顧問目錄（`workspace` 群組）**：第一次 run 時要轉成顧問群組，裡面原本 `agent` 擁有的檔案不能讓主管再讀到。→ Task 4 驗收。
5. **主管與顧問用錯帳號**（例如單一顧問模式仍用 `agent`）：→ Task 2 的單元測試。

---

## 檔案結構

```text
packages/runtime/src/sandbox.ts        consultantUser、ensureConsultantSandboxes、SANDBOX_ADDUSER、runCommand
packages/runtime/src/run.ts            prepareRootAgent：同步 skill 前確保顧問帳號
packages/runtime/src/agents/build.ts   buildConsultant 用顧問帳號
apps/web/lib/sprites.ts                沙盒腳本加私人 /tmp 與帳號檢查；新增 adduser 腳本；佈建安裝；/workspace/agents 改 0711
apps/web/scripts/probe-sandbox.ts      加顧問 A／B 的驗收
docs/…                                 spec 修正、security-model、CLAUDE.md
```

---

## Task 0：基準線

- [ ] 確認分支 `feat/consultant-isolation`、工作區乾淨；跑 `corepack pnpm -F @agenthub/runtime test`、`corepack pnpm -F @agenthub/web test`、`corepack pnpm typecheck`。Expected：runtime 6 個 Windows 基準失敗，其餘通過。

## Task 1：顧問帳號工具函式

**Files:** Modify `packages/runtime/src/sandbox.ts`；Test `packages/runtime/test/sandbox.test.ts`

**Interfaces — Produces:**
- `SANDBOX_ADDUSER = '/usr/local/bin/agenthub-sandbox-adduser'`
- `consultantUser(instanceId: string): string`
- `type CommandRunner = (argv: string[]) => Promise<{ code: number | null; stderr: string }>`
- `ensureConsultantSandboxes(sandboxUser: string | undefined, agentsRoot: string, instanceIds: string[], run?: CommandRunner): Promise<void>`

- [ ] **Step 1：寫失敗的測試**（加在 `test/sandbox.test.ts`，import 補上新名稱）

```ts
describe('consultantUser', () => {
  it('agent- 加上去掉連字號後的前 12 個小寫十六進位字元', () => {
    expect(consultantUser('5F0C2A9B-31D4-4e5f-8a9b-0c1d2e3f4a5b')).toBe('agent-5f0c2a9b31d4');
  });
});

describe('ensureConsultantSandboxes', () => {
  it('本機模式（沒有 SANDBOX_USER）：不執行任何指令', async () => {
    const calls: string[][] = [];
    await ensureConsultantSandboxes(undefined, '/workspace/agents', ['11111111-1111-1111-1111-111111111111'], async (a) => { calls.push(a); return { code: 0, stderr: '' }; });
    expect(calls).toEqual([]);
  });

  it('以 sudo 呼叫 adduser；同一個 id 在同一個程序只呼叫一次', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (a) => { calls.push(a); return { code: 0, stderr: '' }; };
    const id = '22222222-2222-2222-2222-222222222222';
    await ensureConsultantSandboxes('agent', '/workspace/agents', [id], run);
    await ensureConsultantSandboxes('agent', '/workspace/agents', [id], run);
    expect(calls).toEqual([['sudo', '-n', SANDBOX_ADDUSER, 'agent-222222222222', `/workspace/agents/${id}`]]);
  });

  it('失敗時丟出錯誤，且下次會重試', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    await expect(ensureConsultantSandboxes('agent', '/workspace/agents', [id], async () => ({ code: 1, stderr: 'useradd: 失敗' })))
      .rejects.toThrow('useradd: 失敗');
    const calls: string[][] = [];
    await ensureConsultantSandboxes('agent', '/workspace/agents', [id], async (a) => { calls.push(a); return { code: 0, stderr: '' }; });
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2：跑測試確認失敗** — `corepack pnpm -F @agenthub/runtime exec vitest run test/sandbox.test.ts`，Expected FAIL（函式不存在）。
- [ ] **Step 3：實作**（`sandbox.ts`）

```ts
import path from 'node:path';

/** 佈建時安裝的顧問帳號腳本（內容在 apps/web/lib/sprites.ts 的 SANDBOX_ADDUSER_SCRIPT） */
export const SANDBOX_ADDUSER = '/usr/local/bin/agenthub-sandbox-adduser';

/** 每位顧問一個 Linux 帳號，以 uid 隔開彼此的 skill 與工作目錄 */
export function consultantUser(instanceId: string): string {
  return `agent-${instanceId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
}

export type CommandRunner = (argv: string[]) => Promise<{ code: number | null; stderr: string }>;

const runCommand: CommandRunner = (argv) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => resolve({ code: null, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });

/** 已在這個 runtime 程序確認過的顧問；帳號與目錄建立後不會消失，不用每次 run 都呼叫 sudo */
const ensured = new Set<string>();

/** 確保每位顧問的沙盒帳號與目錄存在且權限正確；本機開發（沒有 SANDBOX_USER）不處理 */
export async function ensureConsultantSandboxes(
  sandboxUser: string | undefined,
  agentsRoot: string,
  instanceIds: string[],
  run: CommandRunner = runCommand,
): Promise<void> {
  if (!sandboxUser) return;
  for (const id of instanceIds) {
    if (ensured.has(id)) continue;
    const r = await run(['sudo', '-n', SANDBOX_ADDUSER, consultantUser(id), path.posix.join(agentsRoot, id)]);
    if (r.code !== 0) throw new Error(`無法建立顧問的沙盒帳號：${r.stderr.trim() || `結束碼 ${r.code}`}`);
    ensured.add(id);
  }
}
```

- [ ] **Step 4：跑測試確認通過**；typecheck。
- [ ] **Step 5：Commit** — `feat(runtime): 顧問沙盒帳號的命名與建立`

## Task 2：runtime 依顧問帳號執行

**Files:** Modify `packages/runtime/src/run.ts`、`packages/runtime/src/agents/build.ts`；Test `packages/runtime/test/build.test.ts`、`packages/runtime/test/sandbox.test.ts`

**Interfaces — Produces:** `sandboxUserFor(config: { SANDBOX_USER?: string }, instanceId: string): string | undefined`（在 `sandbox.ts`）

- [ ] **Step 1：寫失敗的測試**

`test/sandbox.test.ts`：

```ts
describe('sandboxUserFor', () => {
  it('Sprite 上顧問用自己的帳號；本機不設定', () => {
    expect(sandboxUserFor({ SANDBOX_USER: 'agent' }, '44444444-4444-4444-4444-444444444444')).toBe('agent-444444444444');
    expect(sandboxUserFor({}, '44444444-4444-4444-4444-444444444444')).toBeUndefined();
  });
});
```

`test/build.test.ts` 既有的「依 config 的 SANDBOX_USER 建立沙盒」測試維持（帳號仍不存在 → 證明經過 sudo）。

- [ ] **Step 2：確認失敗** — `sandboxUserFor` 不存在。
- [ ] **Step 3：實作**
  - `sandbox.ts` 加：

```ts
/** 顧問以自己的帳號執行；主管與本機開發用 config.SANDBOX_USER（本機為 undefined） */
export function sandboxUserFor(config: { SANDBOX_USER?: string }, instanceId: string): string | undefined {
  return config.SANDBOX_USER ? consultantUser(instanceId) : undefined;
}
```

  - `agents/build.ts` 的 `buildConsultant`：`createSandbox(ctx.config.SANDBOX_USER)` 改成 `createSandbox(sandboxUserFor(ctx.config, ctx.instance.id))`。`buildManager` 不變。
  - `run.ts` 的 `prepareRootAgent`：在 `const sharedFiles = …` 之前加：

```ts
  // 每位顧問一個沙盒帳號；建立失敗就不執行（不在沒有隔離的狀態下替顧問跑指令）
  await ensureConsultantSandboxes(config.SANDBOX_USER, config.AGENTS_ROOT, consultants.map((c) => c.id));
```

- [ ] **Step 4：跑 runtime 全部測試與 typecheck** — Expected：6 個基準失敗以外全過。
- [ ] **Step 5：Commit** — `feat(runtime): 顧問以自己的沙盒帳號執行`

## Task 3：佈建腳本

**Files:** Modify `apps/web/lib/sprites.ts`；Test `apps/web/test/sprites.test.ts`

**Interfaces — Produces:** `SANDBOX_ADDUSER = '/usr/local/bin/agenthub-sandbox-adduser'`、`SANDBOX_ADDUSER_SCRIPT`；`SANDBOX_WRAPPER_SCRIPT` 修改

- [ ] **Step 1：寫失敗的測試**（`sandboxSetupScript` 測試內補）

```ts
    expect(s).toContain('/usr/local/bin/agenthub-sandbox-adduser');
    expect(s).toContain('sudo chmod 0711 /workspace/agents');
    expect(s).toContain('sudo install -d -m 711 -o root -g root /var/lib/agenthub/tmp');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain("grep -Eqx 'agent(-[0-9a-f]{12})?'");
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('/usr/bin/install -d -m 700 -o "$user" -g "$user" "/var/lib/agenthub/tmp/$user"');
    expect(SANDBOX_WRAPPER_SCRIPT).toContain('/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" /tmp');
    expect(SANDBOX_ADDUSER_SCRIPT).toContain("grep -Eqx 'agent-[0-9a-f]{12}'");
    expect(SANDBOX_ADDUSER_SCRIPT).toContain("grep -Eqx '/workspace/agents/[0-9a-f-]{36}'");
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('[ ! -L "$dir" ]');
    expect(SANDBOX_ADDUSER_SCRIPT).toContain('/usr/sbin/useradd --create-home --shell /bin/bash --groups workspace "$user"');
    expect(SANDBOX_ADDUSER_SCRIPT.split('\n')[2]).toBe('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH');
```

（import 補 `SANDBOX_ADDUSER_SCRIPT`。既有的 `chmod 2770 /workspace/agents /workspace/shared` 斷言改成 `chmod 2770 /workspace/shared`。）

- [ ] **Step 2：確認失敗**
- [ ] **Step 3：實作**
  - `SANDBOX_WRAPPER_SCRIPT` 在 `user="$1"; shift` 之後、蓋掉 api.sock 之前加：

```ts
  'echo "$user" | /usr/bin/grep -Eqx \'agent(-[0-9a-f]{12})?\' || { echo "不合格的帳號：$user" >&2; exit 2; }',
  // 每個帳號一份私人 /tmp；實體目錄放在只有 root 能寫的地方，不能被搶先建立或換成 symlink
  '/usr/bin/install -d -m 700 -o "$user" -g "$user" "/var/lib/agenthub/tmp/$user"',
  '/usr/bin/mount --bind "/var/lib/agenthub/tmp/$user" /tmp',
```

  - 新增：

```ts
export const SANDBOX_ADDUSER = '/usr/local/bin/agenthub-sandbox-adduser';

/**
 * runtime 以 `sudo agenthub-sandbox-adduser <帳號> <目錄>` 呼叫：確保顧問帳號與工作目錄存在且只有 runtime 與該顧問進得去。
 * 參數不合格、目錄是 symlink 就失敗；可重複執行（1-A 時期的目錄會轉成顧問群組）。
 */
export const SANDBOX_ADDUSER_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV IFS SHELLOPTS',
  'user="$1"; dir="$2"; owner="${SUDO_USER:?必須由 runtime 以 sudo 呼叫}"',
  'echo "$user" | /usr/bin/grep -Eqx \'agent-[0-9a-f]{12}\' || { echo "不合格的帳號：$user" >&2; exit 2; }',
  'echo "$dir" | /usr/bin/grep -Eqx \'/workspace/agents/[0-9a-f-]{36}\' || { echo "不合格的目錄：$dir" >&2; exit 2; }',
  '[ ! -L "$dir" ] || { echo "目錄不能是 symlink：$dir" >&2; exit 2; }',
  '/usr/bin/id -u "$user" >/dev/null 2>&1 || /usr/sbin/useradd --create-home --shell /bin/bash --groups workspace "$user"',
  '[ -d "$dir" ] || /usr/bin/mkdir "$dir"',
  '/usr/bin/chown "$owner:$user" "$dir"',
  '/usr/bin/chmod 2770 "$dir"',
  // 1-A 時期的目錄是 workspace 群組：轉成顧問群組（-R 預設不跟隨 symlink）
  'if [ -n "$(/usr/bin/find "$dir" -mindepth 1 ! -group "$user" -print -quit)" ]; then',
  '  /usr/bin/chgrp -R "$user" "$dir"',
  '  /usr/bin/chmod -R g+rwX,o-rwx "$dir"',
  '  /usr/bin/find "$dir" -type d -exec /usr/bin/chmod g+s {} +',
  'fi',
  '',
].join('\n');
```

  - `sandboxSetupScript`：
    - `sudo chmod 2770 ${WORKSPACE}/agents ${WORKSPACE}/shared` 改成兩行：`sudo chmod 0711 ${WORKSPACE}/agents`、`sudo chmod 2770 ${WORKSPACE}/shared`；`chmod -R g+rwX,o-rwx` 與 `find … g+s` 只套用在 `${WORKSPACE}/shared`（顧問目錄由 adduser 處理）。
    - 加 `sudo install -d -m 711 -o root -g root /var/lib/agenthub/tmp`。
    - 比照沙盒腳本，用 `printf | sudo tee` 安裝 `SANDBOX_ADDUSER_SCRIPT` 到 `${SANDBOX_ADDUSER}`，`root:root 755`。
- [ ] **Step 4：跑測試與 typecheck**
- [ ] **Step 5：Commit** — `feat(web): 佈建時安裝顧問帳號腳本並給每個沙盒帳號私人 /tmp`

## Task 4：暫時 Sprite 驗收

**Files:** Modify `apps/web/scripts/probe-sandbox.ts`

- [ ] **Step 1：擴充驗收腳本**：在既有 13 項之後（佈建已完成），加入：

```ts
  // 子專案 2：兩位顧問
  const idA = randomUUID();
  const idB = randomUUID();
  const userOf = (id: string) => `agent-${id.replace(/-/g, '').slice(0, 12)}`;
  const adduser = (u: string, d: string) => sh(sprite, `sudo -n ${SANDBOX_ADDUSER} ${u} ${d}`);
  for (const id of [idA, idB]) {
    const r = await adduser(userOf(id), `${WORKSPACE}/agents/${id}`);
    record(`adduser 建立顧問 ${id.slice(0, 4)}`, r.code === 0, r.out);
  }
  const asUser = (u: string, cmd: string) => `SANDBOX_PATH="$PATH" sudo -n -E -- unshare --mount --propagation private -- ${SANDBOX_WRAPPER} ${u} bash -c ${JSON.stringify(cmd)}`;
  const A = userOf(idA);
  const B = userOf(idB);
  const dirA = `${WORKSPACE}/agents/${idA}`;
  await sh(sprite, `umask 002 && mkdir -p ${dirA}/skills/s && echo sop > ${dirA}/skills/s/SKILL.md`); // runtime 同步 skill
  const aw = await sh(sprite, asUser(A, `echo a-secret > ${dirA}/work.txt && echo a-tmp > /tmp/a.txt && echo shared-a > ${WORKSPACE}/shared/from-a.txt`));
  record('顧問 A 能寫自己的目錄、/tmp、/shared', aw.code === 0, aw.out);
  const ar = await sh(sprite, asUser(A, `cat ${dirA}/skills/s/SKILL.md`));
  record('顧問 A 讀得到自己的 skill', ar.out === 'sop', ar.out);
  for (const [label, cmd] of [
    ['B 讀不到 A 的 skill', `cat ${dirA}/skills/s/SKILL.md`],
    ['B 讀不到 A 的工作檔', `cat ${dirA}/work.txt`],
    ['B 讀不到 A 的私人 /tmp', `cat /var/lib/agenthub/tmp/${A}/a.txt`],
    ['B 的 /tmp 裡沒有 A 的檔案', 'cat /tmp/a.txt'],
  ] as const) {
    const r = await sh(sprite, asUser(B, cmd));
    record(label, r.code !== 0 && !r.out.includes('sop') && !r.out.includes('a-'), r.out);
  }
  const mgr = await sh(sprite, asUser('agent', `cat ${dirA}/work.txt`));
  record('主管讀不到顧問的工作檔', mgr.code !== 0, mgr.out);
  const shared = await sh(sprite, asUser(B, `cat ${WORKSPACE}/shared/from-a.txt && echo b >> ${WORKSPACE}/shared/from-a.txt`));
  record('B 讀得到也改得了 A 放在 /shared 的檔案', shared.code === 0 && shared.out.startsWith('shared-a'), shared.out);
  const mk = await sh(sprite, asUser(B, `mkdir ${WORKSPACE}/agents/${randomUUID()}`));
  record('顧問不能在 /workspace/agents 建立項目', mk.code !== 0, mk.out);
  const killB = await sh(sprite, [
    `setsid ${asUser(A, 'sleep 300')} &`, 'pid=$!; sleep 1',
    `${asUser(B, 'kill -KILL -- -$pid')} ; sleep 1`,
    `pgrep -u ${A} sleep >/dev/null && echo a-alive || echo a-killed`,
    `sudo -n -u ${A} -- pkill sleep || true`,
  ].join('\n'));
  record('B 終止不了 A 的程序', killB.out.includes('a-alive'), killB.out);
  for (const [label, args] of [
    ['adduser 拒絕 root', `root ${dirA}`],
    ['adduser 拒絕 /etc', `${A} /etc`],
    ['adduser 拒絕 ../', `${A} ${WORKSPACE}/agents/../../etc`],
  ] as const) {
    const r = await sh(sprite, `sudo -n ${SANDBOX_ADDUSER} ${args}`);
    record(label, r.code !== 0, r.out);
  }
  // 1-A 時期的目錄：workspace 群組、agent 擁有的檔案 → 轉換後主管讀不到
  const idOld = randomUUID();
  await sh(sprite, `sudo mkdir ${WORKSPACE}/agents/${idOld} && sudo chown "$(id -un)":workspace ${WORKSPACE}/agents/${idOld} && sudo chmod 2770 ${WORKSPACE}/agents/${idOld} && sudo -u agent sh -c 'echo old > ${WORKSPACE}/agents/${idOld}/old.txt'`);
  const conv = await adduser(userOf(idOld), `${WORKSPACE}/agents/${idOld}`);
  const oldMgr = await sh(sprite, asUser('agent', `cat ${WORKSPACE}/agents/${idOld}/old.txt`));
  const oldOwner = await sh(sprite, asUser(userOf(idOld), `cat ${WORKSPACE}/agents/${idOld}/old.txt`));
  record('1-A 時期的目錄轉成顧問群組：主管讀不到、該顧問讀得到', conv.code === 0 && oldMgr.code !== 0 && oldOwner.out === 'old', `${conv.out} | ${oldMgr.out} | ${oldOwner.out}`);
```

（import 補 `SANDBOX_ADDUSER`。若 `sudo -u agent` 在第一個 1-A 情境因 `/workspace/agents` 已是 0711 無法建立檔案，改以 runtime 寫入後 `sudo chown agent` 模擬，並記 ledger。）

- [ ] **Step 2：typecheck、commit** — `test(web): 驗收顧問之間的隔離`
- [ ] **Step 3：上傳驗收用 runtime 並執行（對外動作，先取得使用者同意）**：`corepack pnpm -F @agenthub/runtime publish-runtime -- --versioned-only`，再 `cd apps/web && corepack pnpm exec tsx scripts/probe-sandbox.ts main-<sha>.js`。Expected：全部 PASS、exit 0。
- [ ] **Step 4：失敗項目用 systematic-debugging 處理，修正後重跑**；結果寫進 spec 並 commit。

## Task 5：文件

- [ ] spec 第 2、3 節改成本計畫 Global Constraints 的路徑與權限（`/workspace/agents 0711`、`/var/lib/agenthub/tmp`、adduser 拒絕 symlink），並記錄驗收結果。
- [ ] `docs/security-model.md`：「顧問之間讀不到彼此…」改為 🚧（上線後 ✅）；第 5 節目錄表更新；第 6 節子專案 2 狀態。
- [ ] `CLAUDE.md` 沙盒那一條補：顧問以 `agent-<id12>` 執行、主管以 `agent`、`agenthub-sandbox-adduser`。
- [ ] Commit — `docs: 記錄顧問之間隔離的實作與狀態`

## Task 6：上線（對外動作，先取得使用者同意）

- [ ] 完整驗證：`corepack pnpm test`、`corepack pnpm typecheck`、`corepack pnpm -F @agenthub/web lint`。
- [ ] 呼叫 `superpowers:finishing-a-development-branch`；合併到 `main` 並 push（web 部署新的佈建流程），確認 Vercel 成功。
- [ ] 立刻 `publish-runtime`，接著 `redeploy-runtime`（會重啟所有 Sprite，含展覽 Demo），逐台驗證：runtime 健康、`/usr/local/bin/agenthub-sandbox-adduser` 存在、`/workspace/agents` 是 `0711`。
- [ ] 以正式 `main.js` 再跑一次 `probe-sandbox.ts`。
- [ ] `docs/security-model.md` 改為 ✅，commit、push；更新記憶。

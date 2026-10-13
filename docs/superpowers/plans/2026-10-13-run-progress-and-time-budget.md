# 執行進度、工具紀錄與時間預算 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者看得到 agent 跑到哪一步、有沒有在跑；run 出問題時 DB 裡查得到每個工具做了什麼；快逾時時顧問與主管會收尾、交出部分結果，而不是整個失敗。

**Architecture:** 分三段，每段可以單獨上線。段 A（runtime）：工具呼叫記下描述、時間、截短的輸入輸出；顧問失敗也寫進 `messages`；主管／單一顧問的 `final` 在 run 開始就插入、執行中定期更新。段 B（web）：步驟列表、整體狀態列、輪詢時也顯示進度。段 C（runtime + web）：`RunClock` 定出收尾時間點，用 AI SDK `prepareStep` 設 `toolChoice: 'none'` 讓 agent 收尾，顧問到點強制停止並把部分結果交給主管。

**Tech Stack:** 同既有專案：`ai` v7（`ToolLoopAgent`、`prepareStep`、`readUIMessageStream`、`message-metadata` chunk）、Hono、Supabase、Next.js 16、Vitest、pgTAP。

**Spec:** `docs/superpowers/specs/2026-10-13-run-progress-and-time-budget-design.md`

## Global Constraints

- 時間點（從 run 開始算，依 `runTimeoutMs` 等比例縮放）：顧問收尾 11/15、顧問強制停止與主管收尾 13/15、單一顧問收尾 13/15、run 上限 15 分鐘（不變）。
- 進度存檔間隔 5 秒；心跳 20 秒；前端「可能卡住了」門檻 60 秒，只在輪詢模式判斷。
- 工具紀錄的 `input` / `output` 截到 2,000 字（沿用 `truncate()`）。
- 瀏覽器只收 `ToolEvent`（`tool`、`state`、`description`、`started_at`、`ended_at`），不收原始指令與輸出；完整的 `ToolRecord` 只寫進 `messages.tool_events`。
- `ToolEvent`、`DelegationOutput`、`Speech` 在 `packages/runtime` 與 `apps/web/lib/agent-output.ts` 各有一份，改形狀時兩邊一起改。
- 收尾一律用 `toolChoice: 'none'`，不清空工具定義。
- 測試直接打雲端 Supabase（ref `xrcyllzqionkwareukif`，即正式站）；Vitest teardown 會刪除所有 `@test.local` 帳號。不要用 `@test.local` 建人工帳號。
- 這台 Windows 電腦的 `pnpm` shim 壞掉，所有 `pnpm` 指令改用 `corepack pnpm`。
- 依使用者全域規則：每個 Task 結尾的 commit 步驟執行前先取得使用者同意；`git add` 只列具體檔案；訊息格式 `<type>(<scope>): <功能描述>`。
- `main` push 後會自動部署 production。開發在 `feat/run-progress` 分支，每段上線時才合併到 `main`；push 前依使用者規則先呼叫 `superpowers:finishing-a-development-branch`。
- 對外動作（`db:push`、`publish-runtime`、push `main`、`redeploy-runtime`）執行前都要使用者明確同意。`redeploy-runtime` 會重啟所有 Sprite（含展覽 Demo），本計畫不主動執行。

## Review Focus

1. **單一 bash 跑了 2 分鐘、沒有任何新快照**：不能被判定為卡住。→ Task 6 的心跳測試；Task 11 只在輪詢模式判斷卡住。
2. **runtime 在 run 中途崩潰，留下沒有內容的 `final` 佔位列**：下一次提問的對話歷史不能出現空白的 assistant 訊息，畫面也不能出現空白泡泡。→ Task 6 的 `loadHistory` 測試；web 既有的 `ui_message` 為 null 過濾。
3. **舊專案（舊 runtime）的訊息沒有 `description` 與 `tool_times`**：新前端照常顯示，只是少了描述與時間。→ Task 9 的 `stepOf` 測試。
4. **顧問被強制停止時還沒寫出任何文字、也沒有完成任何步驟**：交給主管的內容要明確寫「無」，主管不能拿到空字串。→ Task 15 測試。
5. **顧問剛好在強制停止前一刻正常完成**：不能被誤標成逾時。→ Task 15 的 `ConsultantRunner` 測試（只有串流以失敗收場、且停止計時器已觸發時才算逾時）。

---

## 檔案結構

```text
packages/runtime/src/
  ui-stream.ts        ToolEvent / ToolRecord / ToolTimes；toolEvents()、toolRecords()；consumeToEnd(stream, onSnapshot?)
  tool-clock.ts       新增：withToolTimes()，在 UI 串流裡記工具開始／結束時間（message-metadata）
  progress.ts         新增：progressSaver()，節流寫入進度＋心跳
  run-clock.ts        新增：RunClock、createRunClock()、TIME_UP
  run-store.ts        新增 updateMessage / touchMessage / deleteMessage；loadHistory 略過空白 final
  run.ts              final 先插入、定期存檔；建立 RunClock 並往下傳
  consultant.ts       ConsultantRunner 支援 wrapUpAt / stopAt，逾時丟 ConsultantStoppedError
  errors.ts           新增 ConsultantStoppedError
  agents/build.ts     wrapAgent 套 withToolTimes；prepareStep 收尾（wrapUpStep）
  tools/bash.ts       bash 加 description 欄位；DESCRIPTION_FIELD
  tools/files.ts      write_file 加 description 欄位
  tools/delegate.ts   失敗也記錄；acceptUntil、cutoff、逾時摘要
  tools/discuss.ts    失敗也記錄；acceptUntil、cutoff、逾時發言
supabase/migrations/20261013000001_message_updated_at.sql   messages.updated_at
supabase/tests/message_updated_at.test.sql
apps/web/
  lib/agent-output.ts              ToolEvent / ToolTimes / Cutoff
  lib/progress.ts                  新增：TOOL_LABELS、formatElapsed、foldSteps、stepOf、currentActivity、isStalled
  lib/services/threads.ts          ThreadMessages 加 startedAt / updatedAt
  components/workspace/use-now.ts  新增：每秒更新的目前時間
  components/workspace/tool-steps.tsx  新增：ToolStep、ToolSteps（取代 tool-list.tsx）
  components/workspace/tool-list.tsx   刪除
  components/workspace/delegation-card.tsx / discussion-view.tsx / message-view.tsx / chat.tsx
CLAUDE.md                          架構段落補上進度存檔與工具紀錄
```

---

## Task 0：基準線

**Files:** 無

- [ ] **Step 1：建立分支**

```bash
cd D:/AgentHub/eric-agenthub
git status --short          # 必須是乾淨的（spec 與本計畫若尚未 commit，先跟使用者確認要不要一起帶進分支）
git switch -c feat/run-progress
```

- [ ] **Step 2：跑既有測試，記錄基準**

```bash
corepack pnpm install
corepack pnpm -F @agenthub/runtime test
corepack pnpm -F @agenthub/web test
corepack pnpm typecheck
```

Expected：大多通過。把失敗的測試名稱記下來（`runBash` 相關測試在 Windows 上可能因為 `process.kill(-pid)` 本來就會失敗）。之後每個 Task 的「全部通過」都是指「除了這份基準清單以外全部通過」。

---

# 段 A：工具紀錄與進度存檔（runtime）

## Task 1：ToolEvent 擴充與 ToolRecord

**Files:**
- Modify: `packages/runtime/src/ui-stream.ts`
- Modify: `packages/runtime/src/run.ts`（`record` 與 final 的 `tool_events` 改用 `toolRecords`）
- Test: `packages/runtime/test/ui-stream.test.ts`、`packages/runtime/test/server.test.ts`

**Interfaces:**
- Produces:
  - `type ToolTimes = Record<string, { started_at: string; ended_at?: string }>`
  - `type ToolEvent = { tool: string; state: string; description?: string; started_at?: string; ended_at?: string }`
  - `type ToolRecord = ToolEvent & { tool_call_id: string; input?: string; output?: string }`
  - `const RECORD_TEXT_MAX = 2_000`
  - `toolEvents(m: UIMessage): ToolEvent[]`（既有，回傳形狀擴充）
  - `toolRecords(m: UIMessage): ToolRecord[]`

- [ ] **Step 1：寫失敗的測試**

在 `packages/runtime/test/ui-stream.test.ts` 的 import 加上 `toolRecords`，並在 `describe('ui-stream')` 內新增：

```ts
  it('toolEvents 帶出 description 與 metadata 裡的時間', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      metadata: { tool_times: { c1: { started_at: '2026-10-13T00:00:00.000Z', ended_at: '2026-10-13T00:00:12.000Z' } } },
      parts: [
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'python a.py', description: '計算評等' }, output: { exitCode: 0, output: 'ok', timedOut: false } },
        { type: 'tool-bash', toolCallId: 'c2', state: 'input-available', input: { command: 'ls' } },
      ],
    } as unknown as UIMessage;
    expect(toolEvents(m)).toEqual([
      { tool: 'bash', state: 'output-available', description: '計算評等', started_at: '2026-10-13T00:00:00.000Z', ended_at: '2026-10-13T00:00:12.000Z' },
      { tool: 'bash', state: 'input-available' },
    ]);
  });

  it('toolRecords 另外帶 tool_call_id、截短的輸入與輸出；錯誤時輸出是錯誤訊息', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      parts: [
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'cat big' }, output: { output: 'x'.repeat(5000) } },
        { type: 'tool-bash', toolCallId: 'c2', state: 'output-error', input: { command: 'boom' }, errorText: '指令失敗' },
        { type: 'tool-bash', toolCallId: 'c3', state: 'input-streaming' },
      ],
    } as unknown as UIMessage;
    const [a, b, c] = toolRecords(m);
    expect(a).toMatchObject({ tool: 'bash', state: 'output-available', tool_call_id: 'c1', input: '{"command":"cat big"}' });
    expect(a.output!.length).toBeLessThan(2_100);
    expect(a.output).toContain('已截斷');
    expect(b).toMatchObject({ tool_call_id: 'c2', input: '{"command":"boom"}', output: '指令失敗' });
    expect(c).toEqual({ tool: 'bash', state: 'input-streaming', tool_call_id: 'c3' });
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/ui-stream.test.ts`
Expected: FAIL（`toolRecords` 不存在；`toolEvents` 沒有 description）

- [ ] **Step 3：實作**

`packages/runtime/src/ui-stream.ts`：把 `import { errorText } from './errors';` 下面加一行 `import { truncate } from './tools/bash';`，並把既有的 `ToolEvent` 型別與 `toolEvents` 函式整段換成：

```ts
/** 每次工具呼叫的開始與結束時間，存在 UIMessage 的 metadata.tool_times（見 tool-clock.ts） */
export type ToolTimes = Record<string, { started_at: string; ended_at?: string }>;

/** 給前端看的工具摘要：不含原始輸入與輸出（web 端 lib/agent-output.ts 有一份相同的型別） */
export type ToolEvent = { tool: string; state: string; description?: string; started_at?: string; ended_at?: string };

/** 只寫進 messages.tool_events 的完整紀錄，事後除錯用 */
export type ToolRecord = ToolEvent & { tool_call_id: string; input?: string; output?: string };

export const RECORD_TEXT_MAX = 2_000;

type ToolPartLike = {
  type: string;
  toolName?: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function toolParts(m: UIMessage): ToolPartLike[] {
  return m.parts.filter((p) => p.type === 'dynamic-tool' || p.type.startsWith('tool-')) as unknown as ToolPartLike[];
}

function toolTimesOf(m: UIMessage): ToolTimes {
  return (m.metadata as { tool_times?: ToolTimes } | undefined)?.tool_times ?? {};
}

function eventOf(p: ToolPartLike, times: ToolTimes): ToolEvent {
  const tool = p.type === 'dynamic-tool' ? p.toolName ?? 'tool' : p.type.slice('tool-'.length);
  const description = (p.input as { description?: unknown } | undefined)?.description;
  const t = times[p.toolCallId];
  return {
    tool,
    state: p.state,
    ...(typeof description === 'string' && description ? { description } : {}),
    ...(t?.started_at ? { started_at: t.started_at } : {}),
    ...(t?.ended_at ? { ended_at: t.ended_at } : {}),
  };
}

export function toolEvents(m: UIMessage): ToolEvent[] {
  const times = toolTimesOf(m);
  return toolParts(m).map((p) => eventOf(p, times));
}

const clip = (v: unknown): string => truncate(typeof v === 'string' ? v : JSON.stringify(v), RECORD_TEXT_MAX);

export function toolRecords(m: UIMessage): ToolRecord[] {
  const times = toolTimesOf(m);
  return toolParts(m).map((p) => {
    const output = p.state === 'output-error' ? p.errorText ?? '' : p.output;
    return {
      ...eventOf(p, times),
      tool_call_id: p.toolCallId,
      ...(p.input !== undefined ? { input: clip(p.input) } : {}),
      ...(output !== undefined ? { output: clip(output) } : {}),
    };
  });
}
```

`packages/runtime/src/run.ts`：

- import 改成 `import { consumeToEnd, hasContent, textOf, toolRecords } from './ui-stream';`
- `record` 裡的 `tool_events: toolEvents(message),` 改成 `tool_events: toolRecords(message),`
- `settle()` 裡插入 final 的 `tool_events: toolEvents(final),` 改成 `tool_events: toolRecords(final),`

- [ ] **Step 4：更新 server 測試的期望值**

`packages/runtime/test/server.test.ts`：

「執行工具：寫檔成功，final 的 tool_events 有紀錄」中，把
```ts
    expect(final.tool_events).toEqual([{ tool: 'write_file', state: 'output-available' }]);
```
換成
```ts
    expect(final.tool_events).toMatchObject([{ tool: 'write_file', state: 'output-available', tool_call_id: 'call-1' }]);
    expect(final.tool_events[0].input).toContain('memo.md');
```

「派工：顧問發言即時串流…」中，把
```ts
    expect(msgs[1].tool_events).toEqual([{ tool: 'write_file', state: 'output-available' }]);
```
換成
```ts
    expect(msgs[1].tool_events).toMatchObject([{ tool: 'write_file', state: 'output-available', tool_call_id: 'call-c1' }]);
```

- [ ] **Step 5：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/ui-stream.test.ts test/server.test.ts test/delegate.test.ts test/discuss.test.ts`
Expected: PASS

- [ ] **Step 6：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/ui-stream.ts packages/runtime/src/run.ts packages/runtime/test/ui-stream.test.ts packages/runtime/test/server.test.ts
git commit -m "feat(runtime): 工具紀錄存下呼叫 id 與截短的輸入輸出，前端摘要帶描述與時間"
```

## Task 2：工具時間（withToolTimes）

**Files:**
- Create: `packages/runtime/src/tool-clock.ts`
- Modify: `packages/runtime/src/agents/build.ts`（`wrapAgent`）
- Test: `packages/runtime/test/tool-clock.test.ts`、`packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: `ToolTimes`（Task 1）
- Produces: `withToolTimes(stream: ReadableStream<UIMessageChunk>, now?: () => Date): ReadableStream<UIMessageChunk>`

- [ ] **Step 1：寫失敗的測試**

建立 `packages/runtime/test/tool-clock.test.ts`：

```ts
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { withToolTimes } from '../src/tool-clock';
import { toolEvents } from '../src/ui-stream';

function chunks(list: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of list) controller.enqueue(c);
      controller.close();
    },
  });
}

/** 依序回傳指定的時間，用完之後一直回傳最後一個 */
function clock(...times: string[]) {
  let i = 0;
  return () => new Date(times[Math.min(i++, times.length - 1)]);
}

async function lastMessage(stream: ReadableStream<UIMessageChunk>): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) last = m;
  return last!;
}

const T0 = '2026-10-13T00:00:00.000Z';
const T1 = '2026-10-13T00:00:12.000Z';

describe('withToolTimes', () => {
  it('記下開始與結束時間；preliminary 輸出不算結束', async () => {
    const stream = withToolTimes(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'bash' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls', description: '列出檔案' } },
      { type: 'tool-output-available', toolCallId: 'c1', output: { partial: true }, preliminary: true },
      { type: 'tool-output-available', toolCallId: 'c1', output: { done: true } },
      { type: 'finish' },
    ]), clock(T0, T1));
    const m = await lastMessage(stream);
    expect(m.metadata).toEqual({ tool_times: { c1: { started_at: T0, ended_at: T1 } } });
    expect(toolEvents(m)).toEqual([{ tool: 'bash', state: 'output-available', description: '列出檔案', started_at: T0, ended_at: T1 }]);
  });

  it('沒有 tool-input-start 時從 tool-input-available 開始計時；tool-output-error 也算結束', async () => {
    const stream = withToolTimes(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: { command: 'boom' } },
      { type: 'tool-output-error', toolCallId: 'c1', errorText: '失敗' },
      { type: 'finish' },
    ]), clock(T0, T1));
    const m = await lastMessage(stream);
    expect(m.metadata).toEqual({ tool_times: { c1: { started_at: T0, ended_at: T1 } } });
  });

  it('沒有工具呼叫：不送 message-metadata', async () => {
    const out: UIMessageChunk[] = [];
    const stream = withToolTimes(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '你好' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ]));
    for await (const c of stream) out.push(c);
    expect(out.some((c) => c.type === 'message-metadata')).toBe(false);
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tool-clock.test.ts`
Expected: FAIL（找不到 `../src/tool-clock`）

- [ ] **Step 3：實作**

建立 `packages/runtime/src/tool-clock.ts`：

```ts
import type { UIMessageChunk } from 'ai';
import type { ToolTimes } from './ui-stream';

/**
 * 在 UI 串流裡記下每次工具呼叫的開始與結束時間，以 message-metadata 送出。
 * 每次都送完整的 tool_times，不依賴 metadata 的合併行為；串流、存檔、輪詢讀回來的訊息都帶有時間。
 */
export function withToolTimes(
  stream: ReadableStream<UIMessageChunk>,
  now: () => Date = () => new Date(),
): ReadableStream<UIMessageChunk> {
  const times: ToolTimes = {};
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        let changed = false;
        if ((chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') && !times[chunk.toolCallId]) {
          times[chunk.toolCallId] = { started_at: now().toISOString() };
          changed = true;
        }
        const ended =
          (chunk.type === 'tool-output-available' && !chunk.preliminary) ||
          chunk.type === 'tool-output-error' ||
          chunk.type === 'tool-input-error' ||
          chunk.type === 'tool-output-denied';
        if (ended) {
          const t = (times[chunk.toolCallId] ??= { started_at: now().toISOString() });
          if (!t.ended_at) {
            t.ended_at = now().toISOString();
            changed = true;
          }
        }
        if (changed) controller.enqueue({ type: 'message-metadata', messageMetadata: { tool_times: structuredClone(times) } });
      },
    }),
  );
}
```

`packages/runtime/src/agents/build.ts`：加 `import { withToolTimes } from '../tool-clock';`，把 `wrapAgent` 裡的

```ts
      return withWarnings(result.toUIMessageStream({ generateMessageId: generateId, onError: errorText }), warnings);
```

換成

```ts
      const ui = result.toUIMessageStream({ generateMessageId: generateId, onError: errorText });
      return withWarnings(withToolTimes(ui), warnings);
```

- [ ] **Step 4：在整合測試確認接線**

`packages/runtime/test/server.test.ts`「執行工具：寫檔成功…」最後加：

```ts
    expect(final.ui_message.metadata.tool_times['call-1'].ended_at).toBeTruthy();
    expect(final.tool_events[0].started_at).toBeTruthy();
```

- [ ] **Step 5：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tool-clock.test.ts test/server.test.ts test/build.test.ts`
Expected: PASS

- [ ] **Step 6：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/tool-clock.ts packages/runtime/src/agents/build.ts packages/runtime/test/tool-clock.test.ts packages/runtime/test/server.test.ts
git commit -m "feat(runtime): 記錄每次工具呼叫的開始與結束時間"
```

## Task 3：工具輸入加 description

**Files:**
- Modify: `packages/runtime/src/tools/bash.ts`、`packages/runtime/src/tools/files.ts`
- Test: `packages/runtime/test/tools.test.ts`

**Interfaces:**
- Produces: `DESCRIPTION_FIELD`（zod schema，`z.string().optional()`）

- [ ] **Step 1：寫失敗的測試**

`packages/runtime/test/tools.test.ts`：import 改成 `import { bashTool, MAX_OUTPUT, runBash, truncate } from '../src/tools/bash';`，加 `import type { z } from 'zod';`，檔尾新增：

```ts
describe('工具的 description 欄位', () => {
  it('bash 與 write_file 可選填 description，欄位說明要求寫一句中文', async () => {
    const dir = await workDir();
    for (const t of [bashTool(dir), writeFileTool(dir)]) {
      const schema = t.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
      expect(schema.shape.description.description).toContain('一句中文');
      expect(schema.safeParse({ command: 'ls', path: 'a.md', content: 'b' }).success).toBe(true);
      expect(schema.safeParse({ command: 'ls', path: 'a.md', content: 'b', description: '列出檔案' }).success).toBe(true);
    }
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tools.test.ts -t "description"`
Expected: FAIL（`schema.shape.description` 是 undefined）

- [ ] **Step 3：實作**

`packages/runtime/src/tools/bash.ts`，在 `export const BASH_TIMEOUT_MS` 上方加：

```ts
/** 給使用者看的步驟說明；選填，模型漏填時工具照常執行 */
export const DESCRIPTION_FIELD = z
  .string()
  .optional()
  .describe('每次都要填：用一句中文說明這一步在做什麼，給使用者看進度用，不要包含指令或程式碼本身');
```

`bashTool` 的 `inputSchema` 改成：

```ts
    inputSchema: z.object({ command: z.string().describe('要執行的 bash 指令'), description: DESCRIPTION_FIELD }),
```

`packages/runtime/src/tools/files.ts`：import 改成 `import { DESCRIPTION_FIELD, truncate } from './bash';`，`writeFileTool` 的 `inputSchema` 改成：

```ts
    inputSchema: z.object({ path: z.string(), content: z.string(), description: DESCRIPTION_FIELD }),
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/tools.test.ts test/build.test.ts`
Expected: PASS（基準清單中的 `runBash` 失敗除外）

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/tools/bash.ts packages/runtime/src/tools/files.ts packages/runtime/test/tools.test.ts
git commit -m "feat(runtime): 執行指令與寫檔時附上一句給使用者看的步驟說明"
```

## Task 4：顧問失敗也寫入 messages

**Files:**
- Modify: `packages/runtime/src/tools/delegate.ts`、`packages/runtime/src/tools/discuss.ts`
- Test: `packages/runtime/test/delegate.test.ts`、`packages/runtime/test/discuss.test.ts`、`packages/runtime/test/server.test.ts`

**Interfaces:**
- `RecordSpeech` 簽名不變；行為改為「顧問產生過任何快照就呼叫」。

- [ ] **Step 1：寫失敗的測試**

`packages/runtime/test/delegate.test.ts`：加 `import { textOf } from '../src/ui-stream';`。把「顧問出錯：不丟例外，回傳錯誤給主管，不記錄發言」整段換成：

```ts
  it('顧問出錯：不丟例外，回傳錯誤給主管，已產生的內容仍記錄下來', async () => {
    const run: ConsultantRunner = async function* () {
      yield msg('寫到一半');
      throw new Error('MCP 斷線');
    };
    const recorded: string[] = [];
    const t = assignTaskTool({ consultants: [legal], run, record: async (_i, m) => { recorded.push(textOf(m)); }, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    const last = outputs.at(-1)!;
    expect(last).toMatchObject({ status: 'failed', error: 'MCP 斷線' });
    expect(recorded).toEqual(['寫到一半']);
    expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: 'x' }, output: last }))
      .toEqual({ type: 'error-text', value: '法務顧問 執行失敗：MCP 斷線' });
  });

  it('顧問一開始就出錯（沒有任何快照）：不記錄', async () => {
    const run: ConsultantRunner = async function* () {
      throw new Error('啟動失敗');
    };
    const recorded: unknown[] = [];
    const t = assignTaskTool({ consultants: [legal], run, record: async (...a) => { recorded.push(a); }, intervalMs: 0 });
    await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    expect(recorded).toEqual([]);
  });
```

`packages/runtime/test/discuss.test.ts`：加 `import { textOf } from '../src/ui-stream';`，在 `describe('runDiscussion')` 內新增：

```ts
  it('發言中途出錯：已產生的內容仍記錄，發言標成未發言', async () => {
    const run: ConsultantRunner = async function* (instance) {
      if (instance.id === 'c-legal') {
        yield msg('寫到一半');
        throw new Error('斷線');
      }
      yield msg('E1');
    };
    const recorded: string[] = [];
    const state = await finalState(runDiscussion({
      topic: 't', participants: [legal, eng], maxRounds: 1, run,
      record: async (i, m) => { recorded.push(`${i.id}:${textOf(m)}`); },
    }));
    expect(state.speeches.find((s) => s.consultant_id === 'c-legal')).toMatchObject({ status: 'failed', error: '斷線' });
    expect(recorded.sort()).toEqual(['c-eng:E1', 'c-legal:寫到一半']);
  });
```

`packages/runtime/test/server.test.ts` 的 `describe('POST /chat：多顧問')` 內新增：

```ts
  it('派工時顧問失敗：仍寫入 delegation，帶完整工具紀錄', async () => {
    const env = await seedTeam();
    const model = mockModel(
      toolTurn('assign_task', { consultant_id: env.legalId, task: '審查合約' }),
      toolTurn('write_file', { path: 'notes.md', content: '查到的條款', description: '記下查到的條款' }, 'call-c1'),
      errorAfterTextTurn('查到一半', '模型壞掉'),
      textTurn('總結：法務顧問沒有完成'),
    );
    await (await post(app(env, model), { thread_id: env.threadId, text: '幫我看合約' })).text();
    await waitForRunDone(db, env.threadId);
    const delegation = (await messagesOf(env.threadId)).find((m) => m.kind === 'delegation');
    expect(delegation).toMatchObject({ speaker_instance_id: env.legalId, content: '查到一半' });
    expect(delegation.tool_events[0]).toMatchObject({ tool: 'write_file', description: '記下查到的條款', tool_call_id: 'call-c1' });
    expect(delegation.tool_events[0].input).toContain('notes.md');
    expect(delegation.tool_events[0].output).toContain('notes.md');
    expect(delegation.tool_events[0].started_at).toBeTruthy();
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/delegate.test.ts test/discuss.test.ts test/server.test.ts`
Expected: FAIL（失敗的顧問沒有被記錄）

- [ ] **Step 3：實作**

`packages/runtime/src/tools/delegate.ts`，`execute` 裡從 `const base = ...` 到最後的 `yield { ...base, status: 'done', ...lastView() };` 換成：

```ts
      const base = { consultant_id, name: instance.name };
      let last: UIMessage | undefined;
      const lastView = () => (last ? viewOf(last) : { tools: [] });
      // 顧問只要產生過內容，不論成功或失敗都記錄下來，事後查得到它做了哪些步驟
      const save = async () => {
        if (!last) return;
        try {
          await opts.record(instance, last, null);
        } catch (e) {
          console.error(`記錄 ${instance.name} 的派工發言失敗：${errorText(e)}`);
        }
      };
      try {
        const views = changedViews(opts.run(instance, task, abortSignal), (m) => (last = m));
        for await (const view of throttle(views, opts.intervalMs ?? SNAPSHOT_INTERVAL_MS)) {
          yield { ...base, status: 'working', ...view };
        }
      } catch (e) {
        await save();
        yield { ...base, status: 'failed', ...lastView(), error: errorText(e) };
        return;
      }
      await save();
      yield { ...base, status: 'done', ...lastView() };
```

`packages/runtime/src/tools/discuss.ts`，`speakConcurrently` 裡把

```ts
      // 記錄失敗不影響這次發言的結果
      if (speech.status === 'done' && message) await record(instance, message, round);
```

換成

```ts
      // 只要產生過內容就記錄（含失敗），記錄失敗不影響這次發言的結果
      if (message) await record(instance, message, round);
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/delegate.test.ts test/discuss.test.ts test/server.test.ts`
Expected: PASS

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/tools/delegate.ts packages/runtime/src/tools/discuss.ts packages/runtime/test/delegate.test.ts packages/runtime/test/discuss.test.ts packages/runtime/test/server.test.ts
git commit -m "fix(runtime): 顧問失敗時仍保存已產生的內容與工具紀錄"
```

## Task 5：messages.updated_at migration

**Files:**
- Create: `supabase/migrations/20261013000001_message_updated_at.sql`
- Create: `supabase/tests/message_updated_at.test.sql`

**Interfaces:**
- Produces: `messages.updated_at timestamptz not null default now()`

- [ ] **Step 1：寫 pgTAP 測試**

建立 `supabase/tests/message_updated_at.test.sql`：

```sql
begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(3);

select has_column('public', 'messages', 'updated_at', 'messages 有 updated_at');
select col_not_null('public', 'messages', 'updated_at', 'updated_at 不可為 null');
select col_has_default('public', 'messages', 'updated_at', 'updated_at 有預設值');

select * from finish();
rollback;
```

- [ ] **Step 2：寫 migration**

建立 `supabase/migrations/20261013000001_message_updated_at.sql`：

```sql
-- 執行中的 final 會定期更新；前端用它判斷 runtime 是否還活著
alter table public.messages add column updated_at timestamptz not null default now();
```

- [ ] **Step 3：套用到雲端並驗證（對外動作，先取得使用者同意）**

這個 Supabase 專案就是正式站。加一個有預設值的欄位不影響現有程式，但仍然是正式資料庫的 schema 變更。

```bash
cd D:/AgentHub/eric-agenthub
supabase link --project-ref xrcyllzqionkwareukif   # 本機還沒 link 過；需要資料庫密碼（向 Eric 取得，或由使用者自己輸入）
corepack pnpm db:push
corepack pnpm db:test                                # 需要 Docker 在跑
```

Expected：`db:push` 套用 `20261013000001_message_updated_at.sql`；`db:test` 全部 ok（含新的 3 項）。

- [ ] **Step 4：Commit（先取得使用者同意）**

```bash
git add supabase/migrations/20261013000001_message_updated_at.sql supabase/tests/message_updated_at.test.sql
git commit -m "feat(db): 訊息加上最後更新時間"
```

## Task 6：執行中定期存進度

**Files:**
- Create: `packages/runtime/src/progress.ts`
- Modify: `packages/runtime/src/run-store.ts`、`packages/runtime/src/ui-stream.ts`、`packages/runtime/src/run.ts`、`CLAUDE.md`
- Test: `packages/runtime/test/progress.test.ts`、`packages/runtime/test/run-store.test.ts`、`packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: `toolRecords`（Task 1）、`messages.updated_at`（Task 5）
- Produces:
  - `progressSaver(opts: { save: (m: UIMessage) => Promise<void>; touch: () => Promise<void>; intervalMs?: number; heartbeatMs?: number }): ProgressSaver`
  - `type ProgressSaver = { offer(m: UIMessage): void; stop(): Promise<void>; readonly saved: boolean }`
  - `PROGRESS_INTERVAL_MS = 5_000`、`HEARTBEAT_MS = 20_000`
  - `updateMessage(db, id, patch: MessagePatch)`、`touchMessage(db, id)`、`deleteMessage(db, id)`；`type MessagePatch = { content: string; ui_message: unknown; tool_events: unknown[] }`
  - `consumeToEnd(stream, onSnapshot?: (m: UIMessage) => void)`
  - `RunDeps.progressIntervalMs?: number`（只給測試縮短）

- [ ] **Step 1：寫 progressSaver 的失敗測試**

建立 `packages/runtime/test/progress.test.ts`：

```ts
import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { progressSaver } from '../src/progress';
import { textOf } from '../src/ui-stream';

const msg = (text: string): UIMessage => ({ id: 'm', role: 'assistant', parts: [{ type: 'text', text }] });
const empty: UIMessage = { id: 'm', role: 'assistant', parts: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = async () => {};

describe('progressSaver', () => {
  it('第一份有內容的快照立刻存，之後依間隔節流；空白快照不存', async () => {
    const saved: string[] = [];
    const p = progressSaver({ save: async (m) => { saved.push(textOf(m)); }, touch: noop, intervalMs: 50, heartbeatMs: 10_000 });
    p.offer(empty);
    p.offer(msg('A'));
    p.offer(msg('AB'));
    await sleep(60);
    p.offer(msg('ABC'));
    await p.stop();
    expect(saved).toEqual(['A', 'ABC']);
    expect(p.saved).toBe(true);
  });

  it('依序寫入：前一筆還沒寫完不會並行', async () => {
    let active = 0;
    let maxActive = 0;
    const p = progressSaver({
      save: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; },
      touch: noop, intervalMs: 0, heartbeatMs: 10_000,
    });
    p.offer(msg('A'));
    p.offer(msg('B'));
    p.offer(msg('C'));
    await p.stop();
    expect(maxActive).toBe(1);
  });

  it('定期送心跳；stop 之後不再送，也不再接受快照', async () => {
    const touch = vi.fn(noop);
    const save = vi.fn(noop);
    const p = progressSaver({ save, touch, intervalMs: 0, heartbeatMs: 20 });
    await sleep(70);
    await p.stop();
    const n = touch.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    p.offer(msg('太晚了'));
    await sleep(50);
    expect(touch.mock.calls.length).toBe(n);
    expect(save).not.toHaveBeenCalled();
  });

  it('寫入失敗只記 log，不丟例外，saved 維持 false', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = progressSaver({ save: async () => { throw new Error('DB 斷線'); }, touch: noop, intervalMs: 0, heartbeatMs: 10_000 });
      p.offer(msg('A'));
      await p.stop();
      expect(p.saved).toBe(false);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/progress.test.ts`
Expected: FAIL（找不到 `../src/progress`）

- [ ] **Step 3：實作 progressSaver**

建立 `packages/runtime/src/progress.ts`：

```ts
import type { UIMessage } from 'ai';
import { errorText } from './errors';
import { hasContent } from './ui-stream';

export const PROGRESS_INTERVAL_MS = 5_000;
/** 一個 bash 可能跑 2 分鐘都沒有新快照；心跳讓前端知道 runtime 還活著 */
export const HEARTBEAT_MS = 20_000;

export type ProgressSaver = {
  /** 交給它最新的快照：依間隔節流，有內容才存 */
  offer(m: UIMessage): void;
  /** 停止心跳與接受快照，並等已排入的寫入完成 */
  stop(): Promise<void>;
  /** 是否至少成功存過一次快照 */
  readonly saved: boolean;
};

export function progressSaver(opts: {
  save: (m: UIMessage) => Promise<void>;
  touch: () => Promise<void>;
  intervalMs?: number;
  heartbeatMs?: number;
}): ProgressSaver {
  const intervalMs = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
  let lastSave = -Infinity;
  let saved = false;
  let stopped = false;
  // 所有寫入排成一條鏈，避免較舊的快照晚一步寫入、蓋掉較新的
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch((e) => console.error('[run] 無法儲存進度', errorText(e)));
  };
  const heartbeat = setInterval(() => enqueue(opts.touch), opts.heartbeatMs ?? HEARTBEAT_MS);

  return {
    get saved() {
      return saved;
    },
    offer(m) {
      if (stopped || !hasContent(m)) return;
      const now = Date.now();
      if (now - lastSave < intervalMs) return;
      lastSave = now;
      const snapshot = structuredClone(m);
      enqueue(async () => {
        await opts.save(snapshot);
        saved = true;
      });
    },
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      await chain;
    },
  };
}
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/progress.test.ts`
Expected: PASS

- [ ] **Step 5：寫 run-store 的失敗測試**

`packages/runtime/test/run-store.test.ts`：把 `../src/run-store` 的 import 改成

```ts
import {
  assertThreadInProject, createRun, deleteMessage, failRunningRuns, finishRun, insertMessage, loadHistory, touchMessage,
  updateMessage,
} from '../src/run-store';
```

檔尾新增：

```ts
describe('進度存檔', () => {
  async function newRun() {
    const threadId = await seedThread(db, await seedProject(db, await seedUser(db)));
    return { threadId, runId: await createRun(db, threadId) };
  }

  it('updateMessage 更新內容；touchMessage 只推進 updated_at；deleteMessage 刪除', async () => {
    const { threadId, runId } = await newRun();
    const id = await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '' });
    const read = async () => (await db.from('messages').select('content, ui_message, tool_events, updated_at').eq('id', id).single()).data!;

    await updateMessage(db, id, { content: '進行中', ui_message: { id: 'm', role: 'assistant', parts: [] }, tool_events: [{ tool: 'bash' }] });
    const updated = await read();
    expect(updated).toMatchObject({ content: '進行中', ui_message: { id: 'm' }, tool_events: [{ tool: 'bash' }] });

    await new Promise((r) => setTimeout(r, 20));
    await touchMessage(db, id);
    const touched = await read();
    expect(touched.content).toBe('進行中');
    expect(Date.parse(touched.updated_at)).toBeGreaterThan(Date.parse(updated.updated_at));

    await deleteMessage(db, id);
    expect((await db.from('messages').select('id').eq('id', id)).data).toEqual([]);
  });

  it('loadHistory 略過沒有內容的 final（runtime 崩潰時留下的佔位列）', async () => {
    const { threadId, runId } = await newRun();
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'user', content: '問題' });
    await insertMessage(db, { thread_id: threadId, run_id: runId, speaker_instance_id: null, kind: 'final', content: '' });
    expect(await loadHistory(db, threadId)).toEqual([{ role: 'user', content: '問題' }]);
  });
});
```

- [ ] **Step 6：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/run-store.test.ts`
Expected: FAIL（`updateMessage` 等不存在）

- [ ] **Step 7：實作 run-store**

`packages/runtime/src/run-store.ts`，在 `insertMessage` 之後加：

```ts
export type MessagePatch = { content: string; ui_message: unknown; tool_events: unknown[] };

export async function updateMessage(db: Db, id: string, patch: MessagePatch): Promise<void> {
  const { error } = await db.from('messages').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

/** 只推進 updated_at，當作 runtime 還活著的心跳 */
export async function touchMessage(db: Db, id: string): Promise<void> {
  const { error } = await db.from('messages').update({ updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function deleteMessage(db: Db, id: string): Promise<void> {
  const { error } = await db.from('messages').delete().eq('id', id);
  if (error) throw error;
}
```

`loadHistory` 的 `return rows` 那段改成：

```ts
  // 沒有內容的 final 是 runtime 中途崩潰留下的佔位列，不放進對話歷史
  return rows
    .slice(firstUser === -1 ? rows.length : firstUser)
    .filter((m) => m.kind === 'user' || m.content !== '')
    .map((m): ModelMessage => (m.kind === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }));
```

- [ ] **Step 8：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/run-store.test.ts`
Expected: PASS

- [ ] **Step 9：寫 run 的失敗整合測試**

`packages/runtime/test/server.test.ts`：

`app()` 改成可以帶進度間隔：

```ts
function app(env: Awaited<ReturnType<typeof seedEnv>>, model: LanguageModel, runTimeoutMs?: number, progressIntervalMs?: number) {
  return createApp({ db, model, config: env.config, runTimeoutMs, progressIntervalMs });
}
```

在 `describe('POST /chat')` 內新增：

```ts
  it('執行中定期把進度存進 final，結束時寫入完整回覆', async () => {
    const env = await seedEnv();
    const text = '這是一段會慢慢串出來的回答'.repeat(2);
    const res = await post(app(env, mockModel(textTurn(text, 100)), undefined, 200), { thread_id: env.threadId, text: '問題' });
    const partial = await waitFor(async () => {
      const { data } = await db.from('messages').select('content').eq('thread_id', env.threadId).eq('kind', 'final').maybeSingle();
      return data && data.content.length > 0 && data.content.length < text.length ? data.content : undefined;
    });
    expect(text.startsWith(partial)).toBe(true);
    await res.text();
    expect((await waitForRunDone(db, env.threadId)).status).toBe('succeeded');
    const finals = (await messagesOf(env.threadId)).filter((m) => m.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(text);
  });
```

「模型卡住不回應」那一則最後加：

```ts
    expect((await messagesOf(env.threadId)).map((m) => m.kind)).toEqual(['user']);
```

`final` 現在在 run 開始就插入，`created_at` 會排在同一個 run 的 `delegation` / `discussion` 之前。修改以下既有期望值：

「派工：顧問發言即時串流…」中：

```ts
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'delegation', 'final']);
    expect(msgs[1]).toMatchObject({ speaker_instance_id: env.legalId, content: '法務意見：第 5 條有違約金風險', round: null });
    expect(msgs[2]).toMatchObject({ speaker_instance_id: env.managerId, content: '總結：第 5 條要修改' });
    expect(msgs[1].tool_events).toMatchObject([{ tool: 'write_file', state: 'output-available', tool_call_id: 'call-c1' }]);
```

換成

```ts
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'final', 'delegation']);
    const delegation = msgs.find((m) => m.kind === 'delegation');
    const managerFinal = msgs.find((m) => m.kind === 'final');
    expect(delegation).toMatchObject({ speaker_instance_id: env.legalId, content: '法務意見：第 5 條有違約金風險', round: null });
    expect(managerFinal).toMatchObject({ speaker_instance_id: env.managerId, content: '總結：第 5 條要修改' });
    expect(delegation.tool_events).toMatchObject([{ tool: 'write_file', state: 'output-available', tool_call_id: 'call-c1' }]);
```

同一則測試後面的 `const final = msgs[2].ui_message;` 改成 `const final = managerFinal.ui_message;`。

「討論：第 1 輪平行…」中，三處 `msgs.at(-1)` 改成 `msgs.find((m) => m.kind === 'final')`。

- [ ] **Step 10：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/server.test.ts`
Expected: FAIL（執行中讀不到 final；`progressIntervalMs` 不是 RunDeps 的欄位）

- [ ] **Step 11：實作 run**

`packages/runtime/src/ui-stream.ts`，`consumeToEnd` 換成：

```ts
export async function consumeToEnd(
  stream: ReadableStream<UIMessageChunk>,
  onSnapshot?: (m: UIMessage) => void,
): Promise<StreamOutcome> {
  const it = readSnapshots(stream);
  let r = await it.next();
  while (!r.done) {
    onSnapshot?.(r.value);
    r = await it.next();
  }
  return r.value;
}
```

`packages/runtime/src/run.ts`：

import 改成：

```ts
import { createUIMessageStreamResponse, generateId, type LanguageModel, type UIMessage, type UIMessageChunk } from 'ai';
...
import { progressSaver, PROGRESS_INTERVAL_MS } from './progress';
import {
  assertThreadInProject, createRun, deleteMessage, finishRun, insertMessage, loadHistory, touchMessage, updateMessage,
  type RunResult,
} from './run-store';
import { consumeToEnd, hasContent, textOf, toolRecords } from './ui-stream';
```

`RunDeps` 改成：

```ts
/** runTimeoutMs、progressIntervalMs 只給測試縮短時間用，正式環境一律用預設值 */
export type RunDeps = { db: Db; model: LanguageModel; config: Config; runTimeoutMs?: number; progressIntervalMs?: number };
```

`startRun` 裡：

1. `let rootId: string;` 下面加 `let finalId: string;`
2. try 區塊中 `rootId = root.rootId;` 之後加：

```ts
    // final 先插入，執行中定期更新，輪詢的前端隨時看得到進度
    finalId = await insertMessage(db, {
      thread_id: req.threadId, run_id: runId, speaker_instance_id: rootId, kind: 'final', content: '',
    });
```

3. `const [forClient, forServer] = stream.tee();` 之後加：

```ts
  const saveFinal = (m: UIMessage) => updateMessage(db, finalId, { content: textOf(m), ui_message: m, tool_events: toolRecords(m) });
  const dropFinal = () => deleteMessage(db, finalId).catch((e) => console.error('[run] 無法刪除空白回覆', errorText(e)));
  const progress = progressSaver({
    save: saveFinal,
    touch: () => touchMessage(db, finalId),
    intervalMs: deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
  });
```

4. `settle` 整個換成：

```ts
  const settle = async (): Promise<RunResult> => {
    const deadline = new Promise<'deadline'>((resolve) => {
      hardTimer = setTimeout(() => resolve('deadline'), hardDeadlineMs);
    });
    const outcome = await Promise.race([consumeToEnd(forServer, (m) => progress.offer(m)), deadline]);
    // 串流結束當下就判定是否逾時，不受之後寫入資料庫花的時間影響
    const timedOut = abort.signal.aborted;
    await progress.stop();
    if (outcome === 'deadline') {
      stop();
      if (!progress.saved) await dropFinal();
      return { status: 'failed', error: TIMEOUT_ERROR };
    }
    const { final, failure } = outcome;
    let saveError: string | undefined;
    if (hasContent(final)) {
      await saveFinal(final).catch((e) => { saveError = `無法儲存回覆：${errorText(e)}`; });
    } else {
      await dropFinal();
    }
    const error = timedOut
      ? TIMEOUT_ERROR
      : failure ?? saveError ?? (hasContent(final) ? undefined : NO_REPLY_ERROR);
    return error ? { status: 'failed', error } : { status: 'succeeded' };
  };
```

5. 收尾的 IIFE 的 `finally` 改成：

```ts
    } finally {
      // 無論收尾成功與否都要停掉心跳並釋放 run，否則這串對話會一直卡在 running
      await progress.stop();
      await finish(result);
    }
```

- [ ] **Step 12：跑 runtime 全部測試與型別檢查**

Run: `corepack pnpm -F @agenthub/runtime test` 與 `corepack pnpm -F @agenthub/runtime typecheck`
Expected: 全部通過（基準清單除外）

- [ ] **Step 13：更新 CLAUDE.md**

`CLAUDE.md`「架構」段落，「對話串流：…」那一條之後加一條：

```markdown
- 主管（或單一顧問）的 `final` 在 run 開始就插入，執行中每 5 秒更新一次、每 20 秒更新 `updated_at` 當心跳（`packages/runtime/src/progress.ts`），所以輪詢時看得到進度；`messages` 裡 `final` 會排在同一個 run 的 `delegation` / `discussion` 之前。`messages.tool_events` 存完整工具紀錄（`toolRecords`，含截短的輸入輸出）；送給瀏覽器的只有 `toolEvents` 摘要。
```

- [ ] **Step 14：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/progress.ts packages/runtime/src/run-store.ts packages/runtime/src/ui-stream.ts packages/runtime/src/run.ts packages/runtime/test/progress.test.ts packages/runtime/test/run-store.test.ts packages/runtime/test/server.test.ts CLAUDE.md
git commit -m "feat(runtime): 執行中定期儲存回覆進度並送出心跳"
```

## Task 7：段 A 上線

**Files:** 無

- [ ] **Step 1：完整驗證**

```bash
corepack pnpm test
corepack pnpm typecheck
```

Expected：通過（基準清單除外）。

- [ ] **Step 2：合併與發布（對外動作，先取得使用者同意）**

依使用者規則先呼叫 `superpowers:finishing-a-development-branch`。使用者選擇合併到 `main` 並 push 後：

```bash
corepack pnpm -F @agenthub/runtime publish-runtime
```

段 A 不動 `apps/web`，push 觸發的 Vercel 部署內容不變。**不執行** `redeploy-runtime`：只有之後新開的專案會用新 runtime。

- [ ] **Step 3：在正式站驗證**

請使用者新開一個專案、啟用至少 2 位顧問，問一個會派工的問題。run 進行中與結束後，用唯讀查詢確認：
- 執行中 `kind = 'final'` 的列 `content` / `ui_message` 有在更新，`updated_at` 至少每 20 秒前進。
- `delegation` 列的 `tool_events` 有 `tool_call_id`、`input`、`output`、`description`、`started_at`、`ended_at`。

---

# 段 B：前端進度顯示（web）

## Task 8：共用型別與 ThreadMessages 時間欄位

**Files:**
- Modify: `apps/web/lib/agent-output.ts`、`apps/web/lib/services/threads.ts`
- Test: `apps/web/test/threads.test.ts`

**Interfaces:**
- Produces:
  - web 端 `ToolEvent`（同 runtime）、`ToolTimes`、`type Cutoff = 'wrap-up' | 'stopped'`；`DelegationOutput.cutoff?`、`Speech.cutoff?`
  - `ThreadMessages = { messages; running; error; startedAt: string | null; updatedAt: string | null }`

- [ ] **Step 1：寫失敗的測試**

`apps/web/test/threads.test.ts`：

「messages 只回 user 與 final 的 ui_message…」中，

```ts
    expect(r).toEqual({ messages: [ui('u1', 'user', 'Q')], running: true, error: null });
```

換成

```ts
    expect(r).toMatchObject({ messages: [ui('u1', 'user', 'Q')], running: true, error: null });
    expect(r.startedAt).toBeTruthy();
    expect(r.updatedAt).toBeTruthy();
```

新增：

```ts
  it('startedAt 是最新 run 的開始時間；updatedAt 是該 run 訊息中最新的 updated_at（含還沒有內容的 final）', async () => {
    const { owner, thread } = await setup();
    const ui = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', text }] });
    const { data: old } = await db.from('runs')
      .insert({ thread_id: thread.id, status: 'succeeded', started_at: '2026-10-13T00:00:00Z' }).select('id').single();
    await db.from('messages').insert({
      thread_id: thread.id, run_id: old!.id, kind: 'final', content: 'A', ui_message: ui('a0', 'assistant', 'A'), updated_at: '2026-10-13T00:09:00Z',
    });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const { data: run } = await db.from('runs').insert({ thread_id: thread.id, started_at: startedAt }).select('id').single();
    await db.from('messages').insert([
      { thread_id: thread.id, run_id: run!.id, kind: 'user', content: 'Q', ui_message: ui('u1', 'user', 'Q'), updated_at: '2026-10-13T01:00:00Z' },
      { thread_id: thread.id, run_id: run!.id, kind: 'final', content: '', updated_at: '2026-10-13T01:00:30Z' },
    ]);
    const r = await getThreadMessages(db, owner.id, thread.id);
    expect(r.running).toBe(true);
    expect(Date.parse(r.startedAt!)).toBe(Date.parse(startedAt));
    expect(Date.parse(r.updatedAt!)).toBe(Date.parse('2026-10-13T01:00:30Z'));
    expect(r.messages.map((m) => m.id)).toEqual(['a0', 'u1']);
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/web exec vitest run test/threads.test.ts`
Expected: FAIL（沒有 `startedAt` / `updatedAt`）

- [ ] **Step 3：實作**

`apps/web/lib/agent-output.ts` 整個換成：

```ts
import type { UIMessage } from 'ai';

/** 與 packages/runtime/src/ui-stream.ts 的 ToolEvent 相同，改形狀時兩邊一起改 */
export type ToolEvent = { tool: string; state: string; description?: string; started_at?: string; ended_at?: string };

/** UIMessage.metadata.tool_times：每次工具呼叫的開始與結束時間 */
export type ToolTimes = Record<string, { started_at: string; ended_at?: string }>;

/** 時間預算：wrap-up = 過了收尾時間才完成；stopped = 逾時被強制停止 */
export type Cutoff = 'wrap-up' | 'stopped';

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  message?: UIMessage; // 只含文字片段
  tools?: ToolEvent[];
  error?: string;
  cutoff?: Cutoff;
};

export type Speech = {
  consultant_id: string;
  name: string;
  round: number;
  status: 'speaking' | 'done' | 'failed';
  text: string;
  stance?: 'agree' | 'reserve';
  tools?: ToolEvent[];
  error?: string;
  cutoff?: Cutoff;
};

export type DiscussionState = { topic: string; round: number; finished: boolean; error?: string; speeches: Speech[] };
```

`apps/web/lib/services/threads.ts`：`ThreadMessages` 型別換成：

```ts
export type ThreadMessages = {
  messages: UIMessage[];
  running: boolean;
  error: string | null;
  /** 最新一次 run 的開始時間 */
  startedAt: string | null;
  /** 最新一次 run 的訊息最後更新時間（含 runtime 每 20 秒的心跳） */
  updatedAt: string | null;
};
```

`getThreadMessages` 整個換成：

```ts
export async function getThreadMessages(db: Db, userId: string, threadId: string): Promise<ThreadMessages> {
  await getOwnThread(db, userId, threadId);
  const [messagesResult, runResult] = await Promise.all([
    db.from('messages').select('ui_message, run_id, updated_at').eq('thread_id', threadId).in('kind', ['user', 'final']).order('created_at'),
    db.from('runs').select('id, status, error, started_at').eq('thread_id', threadId).order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (messagesResult.error) throw messagesResult.error;
  if (runResult.error) throw runResult.error;

  const rows = messagesResult.data;
  const messages = rows.map((m) => m.ui_message as UIMessage | null).filter((m): m is UIMessage => !!m);
  const run = runResult.data;
  if (!run) return { messages, running: false, error: null, startedAt: null, updatedAt: null };

  const updatedAt = rows
    .filter((m) => m.run_id === run.id)
    .reduce<string | null>((max, m) => (max === null || Date.parse(m.updated_at) > Date.parse(max) ? m.updated_at : max), null);
  const times = { startedAt: run.started_at as string, updatedAt };
  if (run.status === 'running') {
    const stale = Date.now() - new Date(run.started_at).getTime() > STALE_RUN_MS;
    return { messages, running: !stale, error: stale ? '這次回覆超過 20 分鐘沒有完成' : null, ...times };
  }
  return { messages, running: false, error: run.status === 'failed' ? run.error : null, ...times };
}
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/web exec vitest run test/threads.test.ts` 與 `corepack pnpm -F @agenthub/web typecheck`
Expected: PASS

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add apps/web/lib/agent-output.ts apps/web/lib/services/threads.ts apps/web/test/threads.test.ts
git commit -m "feat(web): 對話狀態回傳 run 開始時間與最後更新時間"
```

## Task 9：進度顯示的純函式

**Files:**
- Create: `apps/web/lib/progress.ts`
- Test: `apps/web/test/progress.test.ts`

**Interfaces:**
- Consumes: `ToolEvent`、`ToolTimes`、`DelegationOutput`、`DiscussionState`（Task 8）
- Produces:
  - `TOOL_LABELS: Record<string, string>`、`toolLabel(tool: string): string`
  - `STALL_MS = 60_000`
  - `formatElapsed(ms: number): string`
  - `elapsedOf(step: ToolEvent, now: number): number | undefined`
  - `isRunningState(state: string): boolean`
  - `foldSteps<T>(steps: T[], max?: number, keep?: number): { hidden: number; visible: T[] }`
  - `type ToolPartLike`、`isToolPart(p: { type: string }): boolean`、`toolNameOf(p: ToolPartLike): string`、`isRunningPart(p: ToolPartLike): boolean`
  - `stepOf(part: ToolPartLike, metadata: unknown): ToolEvent`
  - `currentActivity(message: UIMessage | undefined): string`
  - `isStalled(updatedAt: string | null, now: number, thresholdMs?: number): boolean`

- [ ] **Step 1：寫失敗的測試**

建立 `apps/web/test/progress.test.ts`：

```ts
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { currentActivity, elapsedOf, foldSteps, formatElapsed, isStalled, stepOf } from '@/lib/progress';

const assistant = (parts: unknown[], metadata?: unknown) => ({ id: 'a', role: 'assistant', parts, metadata }) as unknown as UIMessage;

describe('formatElapsed', () => {
  it('10 秒內一位小數、1 分鐘內整數秒、之後 分:秒', () => {
    expect(formatElapsed(200)).toBe('0.2s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(105_000)).toBe('1:45');
    expect(formatElapsed(-50)).toBe('0.0s');
  });
});

describe('elapsedOf', () => {
  it('結束的步驟用結束時間；執行中用現在；沒有開始時間回傳 undefined', () => {
    const t0 = '2026-10-13T00:00:00.000Z';
    expect(elapsedOf({ tool: 'bash', state: 'output-available', started_at: t0, ended_at: '2026-10-13T00:00:12.000Z' }, 0)).toBe(12_000);
    expect(elapsedOf({ tool: 'bash', state: 'input-available', started_at: t0 }, Date.parse(t0) + 3_000)).toBe(3_000);
    expect(elapsedOf({ tool: 'bash', state: 'output-available' }, 0)).toBeUndefined();
  });
});

describe('foldSteps', () => {
  it('8 步以內全顯示；超過時只留最新 5 步', () => {
    expect(foldSteps([1, 2, 3])).toEqual({ hidden: 0, visible: [1, 2, 3] });
    expect(foldSteps([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ hidden: 4, visible: [5, 6, 7, 8, 9] });
  });
});

describe('stepOf', () => {
  it('從 tool part 與 metadata 組出步驟', () => {
    const part = { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'x', description: '計算評等' } };
    const metadata = { tool_times: { c1: { started_at: 'S', ended_at: 'E' } } };
    expect(stepOf(part, metadata)).toEqual({ tool: 'bash', state: 'output-available', description: '計算評等', started_at: 'S', ended_at: 'E' });
  });

  it('舊資料沒有描述與時間：只有動作名稱與狀態', () => {
    expect(stepOf({ type: 'dynamic-tool', toolName: 'finmind__price', toolCallId: 'c1', state: 'input-available', input: {} }, undefined))
      .toEqual({ tool: 'finmind__price', state: 'input-available' });
  });
});

describe('currentActivity', () => {
  it('沒有訊息或沒有在跑的工具：思考中；最後一段是文字：正在撰寫回覆', () => {
    expect(currentActivity(undefined)).toBe('思考中');
    expect(currentActivity(assistant([{ type: 'step-start' }]))).toBe('思考中');
    expect(currentActivity(assistant([{ type: 'text', text: '結論' }]))).toBe('正在撰寫回覆');
  });

  it('派工中：正在等顧問；討論中：第幾輪', () => {
    expect(currentActivity(assistant([
      { type: 'tool-assign_task', toolCallId: 'c1', state: 'output-available', preliminary: true, output: { name: 'ETF 資金流顧問', status: 'working' } },
    ]))).toBe('正在等ETF 資金流顧問');
    expect(currentActivity(assistant([
      { type: 'tool-convene_discussion', toolCallId: 'c1', state: 'output-available', preliminary: true, output: { round: 2, speeches: [] } },
    ]))).toBe('第 2 輪討論');
  });

  it('一般工具：有描述用描述，沒有就用動作名稱', () => {
    expect(currentActivity(assistant([
      { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'a' } },
      { type: 'tool-bash', toolCallId: 'c2', state: 'input-available', input: { command: 'b', description: '安裝數值計算套件' } },
    ]))).toBe('安裝數值計算套件');
    expect(currentActivity(assistant([
      { type: 'tool-read_file', toolCallId: 'c1', state: 'input-available', input: { path: 'a' } },
    ]))).toBe('正在讀取檔案');
  });
});

describe('isStalled', () => {
  it('超過門檻才算卡住；沒有更新時間不判斷', () => {
    const now = Date.parse('2026-10-13T00:02:00Z');
    expect(isStalled('2026-10-13T00:00:30Z', now)).toBe(true);
    expect(isStalled('2026-10-13T00:01:30Z', now)).toBe(false);
    expect(isStalled(null, now)).toBe(false);
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/web exec vitest run test/progress.test.ts`
Expected: FAIL（找不到 `@/lib/progress`）

- [ ] **Step 3：實作**

建立 `apps/web/lib/progress.ts`：

```ts
import type { UIMessage } from 'ai';
import type { DelegationOutput, DiscussionState, ToolEvent, ToolTimes } from './agent-output';

export const TOOL_LABELS: Record<string, string> = {
  bash: '執行指令', read_file: '讀取檔案', write_file: '寫入檔案', remember: '記下重點', recall: '查詢記憶',
};

/** 輪詢模式下超過這段時間沒有任何更新（含心跳），就提示可能卡住 */
export const STALL_MS = 60_000;

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function isRunningState(state: string): boolean {
  return state === 'input-streaming' || state === 'input-available';
}

export function elapsedOf(step: ToolEvent, now: number): number | undefined {
  if (!step.started_at) return undefined;
  const end = step.ended_at ? Date.parse(step.ended_at) : now;
  return end - Date.parse(step.started_at);
}

export function foldSteps<T>(steps: T[], max = 8, keep = 5): { hidden: number; visible: T[] } {
  if (steps.length <= max) return { hidden: 0, visible: steps };
  return { hidden: steps.length - keep, visible: steps.slice(-keep) };
}

export type ToolPartLike = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  preliminary?: boolean;
};

export function isToolPart(p: { type: string }): boolean {
  return p.type === 'dynamic-tool' || p.type.startsWith('tool-');
}

export function toolNameOf(p: ToolPartLike): string {
  return p.type === 'dynamic-tool' ? p.toolName ?? '工具' : p.type.slice('tool-'.length);
}

/** 派工與討論用 preliminary 輸出回報進度，所以 preliminary 也算還在跑 */
export function isRunningPart(p: ToolPartLike): boolean {
  return isRunningState(p.state) || p.preliminary === true;
}

export function stepOf(part: ToolPartLike, metadata: unknown): ToolEvent {
  const times = (metadata as { tool_times?: ToolTimes } | undefined)?.tool_times ?? {};
  const t = part.toolCallId ? times[part.toolCallId] : undefined;
  const description = (part.input as { description?: unknown } | undefined)?.description;
  return {
    tool: toolNameOf(part),
    state: part.state,
    ...(typeof description === 'string' && description ? { description } : {}),
    ...(t?.started_at ? { started_at: t.started_at } : {}),
    ...(t?.ended_at ? { ended_at: t.ended_at } : {}),
  };
}

/** 狀態列「目前在做什麼」：取最後一個還沒結束的工具 */
export function currentActivity(message: UIMessage | undefined): string {
  const parts = (message?.parts ?? []) as unknown as ToolPartLike[];
  const running = parts.filter(isToolPart).filter(isRunningPart).at(-1);
  if (!running) return parts.at(-1)?.type === 'text' ? '正在撰寫回覆' : '思考中';
  const name = toolNameOf(running);
  if (name === 'assign_task') return `正在等${(running.output as DelegationOutput | undefined)?.name ?? '顧問'}`;
  if (name === 'convene_discussion') return `第 ${(running.output as DiscussionState | undefined)?.round || 1} 輪討論`;
  return stepOf(running, message?.metadata).description ?? `正在${toolLabel(name)}`;
}

export function isStalled(updatedAt: string | null, now: number, thresholdMs = STALL_MS): boolean {
  return updatedAt !== null && now - Date.parse(updatedAt) > thresholdMs;
}
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/web exec vitest run test/progress.test.ts`
Expected: PASS

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add apps/web/lib/progress.ts apps/web/test/progress.test.ts
git commit -m "feat(web): 進度顯示用的時間格式、步驟摺疊與目前動作判斷"
```

## Task 10：步驟列表元件

**Files:**
- Create: `apps/web/components/workspace/use-now.ts`、`apps/web/components/workspace/tool-steps.tsx`
- Modify: `apps/web/components/workspace/delegation-card.tsx`、`discussion-view.tsx`、`message-view.tsx`
- Delete: `apps/web/components/workspace/tool-list.tsx`

**Interfaces:**
- Consumes: `lib/progress.ts`（Task 9）
- Produces: `useNow(active: boolean, intervalMs?: number): number`；`<ToolStep step now />`；`<ToolSteps tools />`

這個 repo 沒有元件測試環境，元件保持只做呈現，邏輯都在 Task 9 測過的純函式裡；這個 Task 用型別檢查、lint 與手動畫面確認。

- [ ] **Step 1：建立 useNow**

建立 `apps/web/components/workspace/use-now.ts`：

```ts
import { useEffect, useState } from 'react';

/** active 時每秒更新一次目前時間，用來顯示經過時間；不在跑的時候不更新 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
```

- [ ] **Step 2：建立 ToolStep / ToolSteps**

建立 `apps/web/components/workspace/tool-steps.tsx`：

```tsx
'use client';

import { useState } from 'react';
import type { ToolEvent } from '@/lib/agent-output';
import { elapsedOf, foldSteps, formatElapsed, isRunningState, toolLabel } from '@/lib/progress';
import { useNow } from './use-now';

export function ToolStep({ step, now }: { step: ToolEvent; now: number }) {
  const running = isRunningState(step.state);
  const failed = step.state === 'output-error';
  const ms = elapsedOf(step, now);
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span aria-hidden className={`w-4 shrink-0 text-center ${failed ? 'text-seal' : running ? '' : 'text-sage'}`}>
        {running ? <span className="dot-busy" /> : failed ? '✕' : '✓'}
      </span>
      <span className="sr-only">{running ? '執行中：' : failed ? '失敗：' : '完成：'}</span>
      <span className="shrink-0 font-medium">{toolLabel(step.tool)}</span>
      {step.description && <span className="min-w-0 flex-1 truncate text-muted">{step.description}</span>}
      {ms !== undefined && (
        <span className="ml-auto shrink-0 tabular-nums text-muted">{formatElapsed(ms)}{running ? '…' : ''}</span>
      )}
    </li>
  );
}

/** 顧問的工具步驟：每次呼叫一行，超過 8 步只顯示最新 5 步 */
export function ToolSteps({ tools }: { tools?: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const now = useNow(!!tools?.some((t) => isRunningState(t.state)));
  if (!tools?.length) return null;
  const { hidden, visible } = expanded ? { hidden: 0, visible: tools } : foldSteps(tools);
  return (
    <div className="mt-3">
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="mb-1 text-sm text-link hover:underline">
          前面還有 {hidden} 步
        </button>
      )}
      <ol className="space-y-1">
        {visible.map((step, i) => <ToolStep key={hidden + i} step={step} now={now} />)}
      </ol>
    </div>
  );
}
```

- [ ] **Step 3：套用到派工卡片與討論發言**

`apps/web/components/workspace/delegation-card.tsx`：`import { ToolList } from './tool-list';` 改成 `import { ToolSteps } from './tool-steps';`，`<ToolList tools={output?.tools} />` 改成 `<ToolSteps tools={output?.tools} />`。

`apps/web/components/workspace/discussion-view.tsx`：同樣把 `ToolList` 的 import 與 `<ToolList tools={speech.tools} />` 換成 `ToolSteps`。

- [ ] **Step 4：套用到主管／單一顧問自己的工具**

`apps/web/components/workspace/message-view.tsx`：

- 移除 `import { TOOL_LABELS } from './tool-list';` 與檔案內的 `type ToolPart = ...`
- 加上：

```tsx
import { isRunningPart, isToolPart, stepOf, toolNameOf, type ToolPartLike } from '@/lib/progress';
import { ToolStep } from './tool-steps';
import { useNow } from './use-now';
```

- 在 `MessageView` 函式最前面（`if (message.role === 'user')` 之前）加：

```tsx
  const now = useNow(message.parts.some((p) => isToolPart(p) && isRunningPart(p as unknown as ToolPartLike)));
```

- `if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return null;` 之後到該分支結尾換成：

```tsx
        if (!isToolPart(part)) return null;
        const tool = part as unknown as ToolPartLike;
        const name = toolNameOf(tool);
        if (name === 'assign_task') {
          const output = tool.output as DelegationOutput | undefined;
          const consultantId = output?.consultant_id ?? ((tool.input as { consultant_id?: string } | undefined)?.consultant_id) ?? '';
          return <DelegationCard key={i} output={output} task={(tool.input as { task?: string } | undefined)?.task} color={colorOf(consultantId)}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '顧問沒有完成這項工作' : undefined} />;
        }
        if (name === 'convene_discussion') {
          return <DiscussionView key={i} state={tool.output as DiscussionState | undefined} colorOf={colorOf}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '主管沒能召集顧問' : undefined} />;
        }
        return <ul key={i} className="my-2"><ToolStep step={stepOf(tool, message.metadata)} now={now} /></ul>;
```

- [ ] **Step 5：刪除 tool-list.tsx 並檢查**

```bash
git rm apps/web/components/workspace/tool-list.tsx
corepack pnpm -F @agenthub/web typecheck
corepack pnpm -F @agenthub/web lint
```

Expected：沒有錯誤；沒有任何檔案再引用 `tool-list`。

- [ ] **Step 6：手動畫面確認**

`corepack pnpm -F @agenthub/web dev`，打開一個段 A 上線後新開的專案問問題（本機 dev 連雲端 Supabase、會建立真的 Sprite），確認：派工卡片每個工具一行、有描述與經過時間、執行中那行每秒跳動；開一個舊專案確認舊訊息照常顯示（沒有時間）。暗色模式也看一次。

- [ ] **Step 7：Commit（先取得使用者同意）**

```bash
git add apps/web/components/workspace/use-now.ts apps/web/components/workspace/tool-steps.tsx apps/web/components/workspace/delegation-card.tsx apps/web/components/workspace/discussion-view.tsx apps/web/components/workspace/message-view.tsx
git commit -m "feat(web): 工具改成逐步列出，顯示步驟說明與經過時間"
```

（`tool-list.tsx` 的刪除已由 `git rm` 暫存，會一起進這個 commit。）

## Task 11：整體狀態列與輪詢進度

**Files:**
- Modify: `apps/web/components/workspace/chat.tsx`

**Interfaces:**
- Consumes: `ThreadMessages.startedAt / updatedAt`（Task 8）、`currentActivity`、`formatElapsed`、`isStalled`（Task 9）、`useNow`（Task 10）

- [ ] **Step 1：型別與狀態**

`chat.tsx`：

- 本地型別改成 `type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null; startedAt: string | null; updatedAt: string | null };`
- import 加上 `import { currentActivity, formatElapsed, isStalled } from '@/lib/progress';` 與 `import { useNow } from './use-now';`
- `const [waiting, setWaiting] = useState(false);` 下面加：

```tsx
  // 這次回覆的開始時間（送出當下，或輪詢時伺服器回報的 run 開始時間）與伺服器最後更新時間
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
```

- [ ] **Step 2：輪詢時顯示進度**

`pollUntilDone` 迴圈中，`if (!data.running) { ... return; }` 區塊之後、`await sleep(POLL_INTERVAL_MS);` 之前加：

```tsx
        if (data.startedAt) setStartedAt(Date.parse(data.startedAt));
        setUpdatedAt(data.updatedAt);
        // runtime 每 5 秒把進度存進 final：伺服器上已經有這次的回覆就直接顯示
        if (data.messages.at(-1)?.role === 'assistant') {
          markKnown(data.messages);
          setMessages(data.messages);
        }
```

初次載入的 effect 中，`if (data.running) void pollUntilDone();` 改成：

```tsx
        if (data.running) {
          if (data.startedAt) setStartedAt(Date.parse(data.startedAt));
          void pollUntilDone();
        }
```

`submit()` 中 `setNotice(null);` 之後加：

```tsx
    setStartedAt(Date.now());
    setUpdatedAt(null);
```

- [ ] **Step 3：狀態列**

`const busy = ...` 之後加：

```tsx
  const now = useNow(busy);
  const reply = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined;
  // 串流連線還在就表示 runtime 活著；只有輪詢時才用更新時間判斷是否卡住
  const stalled = waiting && isStalled(updatedAt, now);
```

把整個

```tsx
        <p role="status" className="flex items-center gap-2 text-sm text-muted empty:hidden">
          ...
        </p>
```

換成

```tsx
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted empty:hidden">
          {busy && (
            <>
              <span className="dot-busy" aria-hidden />
              <span>{speaker}處理中</span>
              {startedAt !== null && <span aria-hidden className="tabular-nums">· {formatElapsed(now - startedAt)}</span>}
              <span role="status">· {currentActivity(reply)}</span>
            </>
          )}
          {stalled && <span role="alert" className="text-ochre">已經 1 分鐘沒有新進度，可能卡住了</span>}
        </div>
```

經過時間放在 live region 外面，避免螢幕閱讀器每秒唸一次。

- [ ] **Step 4：檢查**

```bash
corepack pnpm -F @agenthub/web typecheck
corepack pnpm -F @agenthub/web lint
corepack pnpm -F @agenthub/web test
```

Expected：通過。

- [ ] **Step 5：手動畫面確認**

本機 dev，在新專案問一個會跑超過 5 分鐘的問題（例如 10/7 那題），確認：狀態列顯示「主管處理中 · 經過時間 · 正在等X」；串流中斷改輪詢後，畫面上的派工卡片仍持續前進（每 3 秒）；重新整理頁面後進度也還在。

- [ ] **Step 6：Commit（先取得使用者同意）**

```bash
git add apps/web/components/workspace/chat.tsx
git commit -m "feat(web): 狀態列顯示經過時間與目前動作，輪詢時也看得到進度"
```

## Task 12：段 B 上線

- [ ] **Step 1：完整驗證**：`corepack pnpm test`、`corepack pnpm typecheck`、`corepack pnpm -F @agenthub/web lint`
- [ ] **Step 2：合併與 push（對外動作，先取得使用者同意）**：依使用者規則呼叫 `superpowers:finishing-a-development-branch`；合併到 `main` push 後 Vercel 自動部署。用 `vercel ls agenthub` 或 GitHub commit status 確認部署成功。
- [ ] **Step 3：正式站確認**：舊專案的對話照常顯示；段 A 之後新開的專案看得到步驟說明、時間與輪詢進度。

---

# 段 C：時間預算與收尾

## Task 13：RunClock

**Files:**
- Create: `packages/runtime/src/run-clock.ts`
- Test: `packages/runtime/test/run-clock.test.ts`

**Interfaces:**
- Produces:
  - `type RunClock = { startedAt: number; consultantWrapUpAt: number; consultantStopAt: number; soloWrapUpAt: number; runTimeoutAt: number }`
  - `createRunClock(startedAt: number, runTimeoutMs: number): RunClock`
  - `TIME_UP = '剩餘時間不足，請用已有的結果彙整'`

- [ ] **Step 1：寫失敗的測試**

建立 `packages/runtime/test/run-clock.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createRunClock } from '../src/run-clock';
import { RUN_TIMEOUT_MS } from '../src/run';

describe('createRunClock', () => {
  it('正式環境：11 分顧問收尾、13 分強制停止與主管收尾、15 分上限', () => {
    expect(createRunClock(0, RUN_TIMEOUT_MS)).toEqual({
      startedAt: 0, consultantWrapUpAt: 660_000, consultantStopAt: 780_000, soloWrapUpAt: 780_000, runTimeoutAt: 900_000,
    });
  });

  it('測試用的短時間依比例縮放', () => {
    expect(createRunClock(1_000, 1_500)).toEqual({
      startedAt: 1_000, consultantWrapUpAt: 2_100, consultantStopAt: 2_300, soloWrapUpAt: 2_300, runTimeoutAt: 2_500,
    });
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/run-clock.test.ts`
Expected: FAIL

- [ ] **Step 3：實作**

建立 `packages/runtime/src/run-clock.ts`：

```ts
/** 一次 run 的時間點（epoch 毫秒）。正式環境 15 分鐘；測試傳入較短的 runTimeoutMs 時等比例縮放 */
export type RunClock = {
  startedAt: number;
  /** 顧問停止用工具、主管不再派新工作 */
  consultantWrapUpAt: number;
  /** 顧問強制停止、主管停止用工具 */
  consultantStopAt: number;
  /** 單一顧問模式：顧問本身停止用工具 */
  soloWrapUpAt: number;
  runTimeoutAt: number;
};

export const TIME_UP = '剩餘時間不足，請用已有的結果彙整';

export function createRunClock(startedAt: number, runTimeoutMs: number): RunClock {
  const at = (fraction: number) => startedAt + Math.round(runTimeoutMs * fraction);
  return {
    startedAt,
    consultantWrapUpAt: at(11 / 15),
    consultantStopAt: at(13 / 15),
    soloWrapUpAt: at(13 / 15),
    runTimeoutAt: startedAt + runTimeoutMs,
  };
}
```

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/run-clock.test.ts`
Expected: PASS

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/run-clock.ts packages/runtime/test/run-clock.test.ts
git commit -m "feat(runtime): 定出 run 的收尾與強制停止時間點"
```

## Task 14：收尾 prepareStep

**Files:**
- Modify: `packages/runtime/src/agents/build.ts`
- Test: `packages/runtime/test/build.test.ts`

**Interfaces:**
- Consumes: `RunClock`（Task 13）
- Produces:
  - `CONSULTANT_WRAP_UP`、`MANAGER_WRAP_UP`（收尾指示文字）
  - `wrapUpStep(at: number | undefined, instructions: string, note: string)`
  - `ConsultantContext.wrapUpAt?: number`
  - `ManagerContext.clock?: Pick<RunClock, 'consultantWrapUpAt' | 'consultantStopAt'>`（本 Task 只用 `consultantStopAt`，`consultantWrapUpAt` 在 Task 17 接到工具）

- [ ] **Step 1：寫失敗的測試**

`packages/runtime/test/build.test.ts` 的 `describe('buildConsultant')` 內新增：

```ts
  it('過了收尾時間：不准再用工具，指示帶收尾說明；還沒到則照常', async () => {
    const projectId = await seedProject(db, await seedUser(db));
    const id = await seedConsultant(db, projectId);
    const roots = await tmpRoots();
    const config = { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot };
    for (const [wrapUpAt, expectNone] of [[Date.now() - 1, true], [Date.now() + 60_000, false]] as const) {
      const model = mockModel(textTurn('結論'));
      const built = await buildConsultant({ db, model, config, instance: instance({ id, project_id: projectId }), sharedFiles: [], secrets: {}, wrapUpAt });
      try {
        for await (const _ of readUIMessageStream({ stream: await built.streamUI({ messages: [{ role: 'user', content: '你好' }] }) })) { /* drain */ }
      } finally {
        await built.close();
      }
      expect(model.doStreamCalls[0].toolChoice?.type === 'none').toBe(expectNone);
      expect(promptText(model).includes('時間已到，不能再使用工具')).toBe(expectNone);
    }
  });
```

`describe('buildManager')` 內新增：

```ts
  it('過了 consultantStopAt：主管不准再用工具，要彙整已有結果', async () => {
    const projectId = await seedProject(db, await seedUser(db));
    const managerId = await seedManager(db, projectId);
    const roots = await tmpRoots();
    const model = mockModel(textTurn('總結'));
    const built = await buildManager({
      db, model,
      config: { PROJECT_ID: projectId, SHARED_ROOT: roots.sharedRoot },
      manager: instance({ id: managerId, project_id: projectId, role: 'manager', name: '主管' }),
      consultants: [instance({ id: 'c-1', name: 'A' }), instance({ id: 'c-2', name: 'B' })],
      sharedFiles: [],
      runner: async function* () {},
      record: async () => {},
      clock: { consultantWrapUpAt: Date.now() - 2, consultantStopAt: Date.now() - 1 },
    });
    for await (const _ of readUIMessageStream({ stream: await built.streamUI({ messages: [{ role: 'user', content: '嗨' }] }) })) { /* drain */ }
    expect(model.doStreamCalls[0].toolChoice).toEqual({ type: 'none' });
    expect(promptText(model)).toContain('彙整各顧問已交回的內容');
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/build.test.ts`
Expected: FAIL（`wrapUpAt` / `clock` 不是 context 的欄位）

- [ ] **Step 3：實作**

`packages/runtime/src/agents/build.ts`：

- 加 `import type { RunClock } from '../run-clock';`
- 在 `export const MAX_STEPS = 30;` 之後加：

```ts
export const CONSULTANT_WRAP_UP =
  '時間已到，不能再使用工具。請根據目前已取得的結果直接回覆，並明確列出哪些部分沒有完成、原因是時間不足。';
export const MANAGER_WRAP_UP =
  '時間已到，不能再使用工具。請彙整各顧問已交回的內容直接回覆使用者；缺漏或沒有完成的部分要明講，不要自行補數字。';

/**
 * 過了 at 之後的每一步都不准呼叫工具，並在指示最後補上收尾說明。
 * 用 toolChoice 而不是清空工具：對話歷史裡已有工具呼叫，Gemini 需要看到工具定義。
 */
export function wrapUpStep(at: number | undefined, instructions: string, note: string) {
  if (at === undefined) return undefined;
  const wrapped = `${instructions}\n\n## 時間到\n${note}`;
  return () => (Date.now() >= at ? { toolChoice: 'none' as const, instructions: wrapped } : {});
}
```

- `ConsultantContext` 加欄位：

```ts
  /** 過了這個時間就收尾（不准再用工具） */
  wrapUpAt?: number;
```

- `buildConsultant` 的 `new ToolLoopAgent({...})` 加上 `prepareStep: wrapUpStep(ctx.wrapUpAt, instructions, CONSULTANT_WRAP_UP),`
- `ManagerContext` 加欄位：

```ts
  clock?: Pick<RunClock, 'consultantWrapUpAt' | 'consultantStopAt'>;
```

- `buildManager` 的 `new ToolLoopAgent({...})` 加上 `prepareStep: wrapUpStep(ctx.clock?.consultantStopAt, instructions, MANAGER_WRAP_UP),`

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/build.test.ts` 與 `corepack pnpm -F @agenthub/runtime typecheck`
Expected: PASS（若 `prepareStep` 的回傳型別推論不過，把 `wrapUpStep` 的回傳型別標成 `PrepareStepFunction<ToolSet> | undefined`，從 `ai` import）

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/agents/build.ts packages/runtime/test/build.test.ts
git commit -m "feat(runtime): 到了收尾時間後顧問與主管不再使用工具，改為整理已有結果"
```

## Task 15：顧問強制停止與派工的逾時處理

**Files:**
- Modify: `packages/runtime/src/errors.ts`、`packages/runtime/src/consultant.ts`、`packages/runtime/src/tools/delegate.ts`
- Test: `packages/runtime/test/consultant.test.ts`、`packages/runtime/test/delegate.test.ts`

**Interfaces:**
- Consumes: `TIME_UP`（Task 13）、`ConsultantContext.wrapUpAt`（Task 14）
- Produces:
  - `class ConsultantStoppedError extends Error`
  - `ConsultantRunnerDeps.wrapUpAt?: number`、`ConsultantRunnerDeps.stopAt?: number`
  - `DelegationOutput.cutoff?: 'wrap-up' | 'stopped'`、`STOPPED_ERROR = '逾時，只交回部分結果'`、`stoppedSummary(o: DelegationOutput): string`
  - `assignTaskTool` 的 opts 加 `acceptUntil?: number`

- [ ] **Step 1：寫 ConsultantRunner 的失敗測試**

`packages/runtime/test/consultant.test.ts`：

- import 加 `import { ConsultantStoppedError } from '../src/errors';` 與 `import { createConsultantRunner, type ConsultantRunnerDeps } from '../src/consultant';`（取代原本只 import `createConsultantRunner` 那行）
- `setup` 改成回傳可以再建 runner 的工廠：

```ts
async function setup(model: LanguageModel) {
  const projectId = await seedProject(db, await seedUser(db));
  const threadId = await seedThread(db, projectId);
  const runId = await createRun(db, threadId);
  const consultantId = await seedConsultant(db, projectId, { system_prompt: '你是稅務顧問。' });
  const roots = await tmpRoots();
  const [instance] = await loadInstances(db, projectId);
  const makeRunner = (extra: Partial<ConsultantRunnerDeps> = {}) => createConsultantRunner({
    db, model, runId, sharedFiles: [], secrets: [],
    config: { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot },
    ...extra,
  });
  return { run: makeRunner(), makeRunner, instance, runId, consultantId };
}
```

- 新增：

```ts
  it('超過 stopAt：中止顧問並丟出 ConsultantStoppedError', async () => {
    const { makeRunner, instance } = await setup(mockModel(textTurn('一段要講很久很久很久很久很久的回答', 100)));
    const run = makeRunner({ stopAt: Date.now() + 300 });
    const consume = async () => {
      for await (const _ of run(instance, '任務')) { /* drain */ }
    };
    await expect(consume()).rejects.toBeInstanceOf(ConsultantStoppedError);
  });

  it('在 stopAt 之前正常完成：不算逾時', async () => {
    const { makeRunner, instance } = await setup(mockModel(textTurn('很快的回答')));
    const run = makeRunner({ stopAt: Date.now() + 5_000 });
    let last;
    for await (const m of run(instance, '任務')) last = m;
    expect(textOf(last)).toBe('很快的回答');
  });
```

- [ ] **Step 2：寫派工的失敗測試**

`packages/runtime/test/delegate.test.ts`：import 加 `import { ConsultantStoppedError } from '../src/errors';` 與 `import { TIME_UP } from '../src/run-clock';`，在 `describe('assign_task')` 內新增：

```ts
  it('過了受理時間：不啟動顧問，直接回報時間不足', async () => {
    let called = false;
    const run: ConsultantRunner = async function* () {
      called = true;
      yield msg('不該被呼叫');
    };
    const t = assignTaskTool({ consultants: [legal], run, record: async () => {}, intervalMs: 0, acceptUntil: Date.now() - 1 });
    const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    expect(outputs).toEqual([{ consultant_id: 'c-legal', name: '法務顧問', status: 'failed', error: TIME_UP }]);
    expect(called).toBe(false);
  });

  it('顧問被強制停止：標成 stopped，交給主管已完成的步驟與已寫出的內容', async () => {
    const step = (state: string, description: string, toolCallId: string) =>
      ({ type: 'tool-bash', toolCallId, state, input: { command: 'x', description } });
    const partial = {
      id: 'm', role: 'assistant',
      parts: [step('output-available', '計算評等', 'c1'), step('input-available', '安裝套件', 'c2'), { type: 'text', text: '初步結果：0050 流入最多' }],
    } as unknown as UIMessage;
    const run: ConsultantRunner = async function* () {
      yield partial;
      throw new ConsultantStoppedError('法務顧問 超過時間上限');
    };
    const recorded: UIMessage[] = [];
    const t = assignTaskTool({ consultants: [legal], run, record: async (_i, m) => { recorded.push(m); }, intervalMs: 0 });
    const last = (await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>)).at(-1)!;
    expect(last).toMatchObject({ status: 'failed', cutoff: 'stopped', error: '逾時，只交回部分結果' });
    expect(recorded).toHaveLength(1);
    expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: 'x' }, output: last })).toEqual({
      type: 'text',
      value: '法務顧問 逾時，只完成部分工作。已完成的步驟：計算評等。已寫出的內容：初步結果：0050 流入最多',
    });
  });

  it('被強制停止時什麼都還沒做：交給主管的內容寫「無」', async () => {
    const run: ConsultantRunner = async function* () {
      throw new ConsultantStoppedError('x');
    };
    const t = assignTaskTool({ consultants: [legal], run, record: async () => {}, intervalMs: 0 });
    const last = (await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>)).at(-1)!;
    expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: 'x' }, output: last })).toEqual({
      type: 'text', value: '法務顧問 逾時，只完成部分工作。已完成的步驟：無。已寫出的內容：無',
    });
  });

  it('過了受理時間才完成：標成 wrap-up，結果照常交給主管', async () => {
    const run: ConsultantRunner = async function* () {
      await new Promise((r) => setTimeout(r, 30));
      yield msg('收尾結論');
    };
    const t = assignTaskTool({ consultants: [legal], run, record: async () => {}, intervalMs: 0, acceptUntil: Date.now() + 10 });
    const last = (await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>)).at(-1)!;
    expect(last).toMatchObject({ status: 'done', cutoff: 'wrap-up' });
    expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: 'x' }, output: last }))
      .toEqual({ type: 'text', value: '收尾結論' });
  });
```

- [ ] **Step 3：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/consultant.test.ts test/delegate.test.ts`
Expected: FAIL

- [ ] **Step 4：實作**

`packages/runtime/src/errors.ts` 加：

```ts
/** 顧問超過 RunClock.consultantStopAt 被強制停止 */
export class ConsultantStoppedError extends Error {}
```

`packages/runtime/src/consultant.ts`：

- import 加 `import { ConsultantStoppedError } from './errors';`
- `ConsultantRunnerDeps` 加：

```ts
  /** 過了這個時間顧問收尾（不准再用工具） */
  wrapUpAt?: number;
  /** 過了這個時間強制停止顧問 */
  stopAt?: number;
```

- `runConsultant` 換成：

```ts
  return async function* runConsultant(instance, task, abortSignal) {
    const stopSignal = deps.stopAt === undefined ? undefined : AbortSignal.timeout(Math.max(0, deps.stopAt - Date.now()));
    const signal = stopSignal && abortSignal ? AbortSignal.any([abortSignal, stopSignal]) : stopSignal ?? abortSignal;
    const built = await buildConsultant({
      db: deps.db,
      model: deps.model,
      config: deps.config,
      instance,
      sharedFiles: deps.sharedFiles,
      secrets: groupSecrets(deps.secrets, instance.id),
      onStepEnd: usageRecorder({ db: deps.db, projectId: deps.config.PROJECT_ID, runId: deps.runId, instance }),
      wrapUpAt: deps.wrapUpAt,
    });
    try {
      const snapshots = readSnapshots(await built.streamUI({ messages: [{ role: 'user', content: task }], abortSignal: signal }));
      let r = await snapshots.next();
      while (!r.done) {
        yield r.value;
        r = await snapshots.next();
      }
      if (r.value.failure) {
        // 只有串流以失敗收場、且是停止計時器造成的，才算逾時；正常完成後計時器才觸發不算
        if (stopSignal?.aborted && !abortSignal?.aborted) throw new ConsultantStoppedError(`${instance.name} 超過時間上限`);
        throw new Error(r.value.failure);
      }
      if (!hasContent(r.value.final)) throw new Error(`${instance.name} 沒有產生任何回覆`);
    } finally {
      await built.close();
    }
  };
```

`packages/runtime/src/tools/delegate.ts`：

- import 改成 `import { ConsultantStoppedError, errorText } from '../errors';`，加 `import { TIME_UP } from '../run-clock';`
- `DelegationOutput` 加 `cutoff?: 'wrap-up' | 'stopped';`
- 在 `DelegationOutput` 型別之後加：

```ts
export const STOPPED_ERROR = '逾時，只交回部分結果';

/** 顧問被強制停止時交給主管的內容：已完成的步驟與已寫出的文字 */
export function stoppedSummary(o: DelegationOutput): string {
  const steps = (o.tools ?? []).filter((t) => t.state === 'output-available').map((t) => t.description ?? t.tool);
  return `${o.name} 逾時，只完成部分工作。已完成的步驟：${steps.length ? steps.join('；') : '無'}。已寫出的內容：${textOf(o.message) || '無'}`;
}
```

- `assignTaskTool` 的 opts 型別加：

```ts
  /** 過了這個時間就不再啟動顧問（RunClock.consultantWrapUpAt） */
  acceptUntil?: number;
```

- `execute` 中，`if (!instance) { ... }` 之後加：

```ts
      if (opts.acceptUntil !== undefined && Date.now() >= opts.acceptUntil) {
        yield { consultant_id, name: instance.name, status: 'failed', error: TIME_UP };
        return;
      }
```

- Task 4 寫的 `catch` 區塊與最後的 `yield` 換成：

```ts
      } catch (e) {
        await save();
        if (e instanceof ConsultantStoppedError) {
          yield { ...base, status: 'failed', cutoff: 'stopped', ...lastView(), error: STOPPED_ERROR };
        } else {
          yield { ...base, status: 'failed', ...lastView(), error: errorText(e) };
        }
        return;
      }
      await save();
      const wrappedUp = opts.acceptUntil !== undefined && Date.now() >= opts.acceptUntil;
      yield { ...base, status: 'done', ...(wrappedUp ? { cutoff: 'wrap-up' as const } : {}), ...lastView() };
```

- `toModelOutput` 換成：

```ts
    toModelOutput: ({ output }) => {
      if (output.cutoff === 'stopped') return { type: 'text', value: stoppedSummary(output) };
      return output.status === 'failed'
        ? { type: 'error-text', value: `${output.name} 執行失敗：${output.error}` }
        : { type: 'text', value: textOf(output.message) || '（顧問沒有回覆內容）' };
    },
```

- [ ] **Step 5：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/consultant.test.ts test/delegate.test.ts` 與 `corepack pnpm -F @agenthub/runtime typecheck`
Expected: PASS

- [ ] **Step 6：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/errors.ts packages/runtime/src/consultant.ts packages/runtime/src/tools/delegate.ts packages/runtime/test/consultant.test.ts packages/runtime/test/delegate.test.ts
git commit -m "feat(runtime): 顧問逾時強制停止並把部分結果交給主管，時間不足時不再派工"
```

## Task 16：討論的逾時處理

**Files:**
- Modify: `packages/runtime/src/tools/discuss.ts`
- Test: `packages/runtime/test/discuss.test.ts`

**Interfaces:**
- Consumes: `ConsultantStoppedError`（Task 15）、`TIME_UP`（Task 13）
- Produces:
  - `Speech.cutoff?: 'wrap-up' | 'stopped'`
  - `TIME_UP_DISCUSSION = '時間不足，提前結束討論'`、`STOPPED_SPEECH = '逾時，只完成部分發言'`
  - `runDiscussion` 與 `conveneDiscussionTool` 的 opts 加 `acceptUntil?: number`

- [ ] **Step 1：寫失敗的測試**

`packages/runtime/test/discuss.test.ts`：import 加 `import { ConsultantStoppedError } from '../src/errors';` 與 `import { TIME_UP } from '../src/run-clock';`，在 `describe('runDiscussion')` 內新增：

```ts
  it('過了受理時間：不開下一輪，帶「時間不足」錯誤；跨過時間才完成的發言標成 wrap-up', async () => {
    const { run, calls } = scriptedRunner({ 'c-legal': ['L1', 'L2'], 'c-eng': ['E1', 'E2'] }, 30);
    const state = await finalState(runDiscussion({
      topic: 't', participants: [legal, eng], maxRounds: 3, run, record: noRecord, acceptUntil: Date.now() + 10,
    }));
    expect(calls.map((c) => c.id).sort()).toEqual(['c-eng', 'c-legal']);
    expect(state).toMatchObject({ finished: true, round: 1, error: '時間不足，提前結束討論' });
    expect(state.speeches.every((s) => s.cutoff === 'wrap-up')).toBe(true);
  });

  it('發言被強制停止：保留已寫出的內容，紀錄裡標明逾時', async () => {
    const run: ConsultantRunner = async function* (instance) {
      if (instance.id === 'c-legal') {
        yield msg('寫到一半的意見');
        throw new ConsultantStoppedError('x');
      }
      yield msg('E1');
    };
    const state = await finalState(runDiscussion({ topic: 't', participants: [legal, eng], maxRounds: 1, run, record: noRecord }));
    expect(state.speeches.find((s) => s.consultant_id === 'c-legal')).toMatchObject({
      status: 'failed', cutoff: 'stopped', text: '寫到一半的意見', error: '逾時，只完成部分發言',
    });
    expect(formatTranscript(state)).toContain('【第 1 輪｜法務】（逾時，只完成部分發言）\n寫到一半的意見');
  });
```

在 `convene_discussion` 的 describe 內新增：

```ts
  it('過了受理時間：不召集，直接回報時間不足', async () => {
    const { run, calls } = scriptedRunner({ 'c-legal': ['L1'], 'c-eng': ['E1'] });
    const t = conveneDiscussionTool({ consultants: [legal, eng], run, record: noRecord, intervalMs: 0, acceptUntil: Date.now() - 1 });
    const states = await allStates(t.execute!({ topic: 't', participant_ids: ['c-legal', 'c-eng'], max_rounds: 3 }, opts) as AsyncIterable<DiscussionState>);
    expect(states).toEqual([{ topic: 't', round: 0, finished: true, error: TIME_UP, speeches: [] }]);
    expect(calls).toEqual([]);
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/discuss.test.ts`
Expected: FAIL

- [ ] **Step 3：實作**

`packages/runtime/src/tools/discuss.ts`：

- import 改成 `import { ConsultantStoppedError, errorText } from '../errors';`，加 `import { TIME_UP } from '../run-clock';`
- `Speech` 加 `cutoff?: 'wrap-up' | 'stopped';`
- `export const MAX_ROUNDS = 3;` 之後加：

```ts
export const TIME_UP_DISCUSSION = '時間不足，提前結束討論';
export const STOPPED_SPEECH = '逾時，只完成部分發言';
```

- `formatTranscript` 換成：

```ts
export function formatTranscript(state: DiscussionState): string {
  return state.speeches
    .filter((s) => s.status !== 'speaking')
    .map((s) => {
      if (s.status === 'done') return `【第 ${s.round} 輪｜${s.name}】\n${s.text}`;
      if (s.cutoff === 'stopped' && s.text) return `【第 ${s.round} 輪｜${s.name}】（${STOPPED_SPEECH}）\n${s.text}`;
      return `【第 ${s.round} 輪｜${s.name}】（未發言：${s.error}）`;
    })
    .join('\n\n');
}
```

- `speakConcurrently` 參數最後加 `acceptUntil?: number`，`try` / `catch` 換成：

```ts
    try {
      for await (const m of run(instance, prompt, abortSignal)) {
        message = m;
        const text = textOf(m);
        const tools = toolEvents(m);
        if (text === speech.text && JSON.stringify(tools) === JSON.stringify(speech.tools)) continue;
        speech.text = text;
        speech.tools = tools;
        feed.mark();
      }
      speech.status = 'done';
      speech.stance = parseStance(speech.text);
      if (acceptUntil !== undefined && Date.now() >= acceptUntil) speech.cutoff = 'wrap-up';
    } catch (e) {
      speech.status = 'failed';
      if (e instanceof ConsultantStoppedError) {
        speech.cutoff = 'stopped';
        speech.error = STOPPED_SPEECH;
      } else {
        speech.error = errorText(e);
      }
    }
```

- `runDiscussion` 的 opts 型別加 `acceptUntil?: number;`；`stopIfAborted` 之後加：

```ts
  const timeUp = () => {
    if (opts.acceptUntil === undefined || Date.now() < opts.acceptUntil) return false;
    state.error ??= TIME_UP_DISCUSSION;
    return true;
  };
```

- 迴圈開頭 `if (stopIfAborted()) break;` 改成 `if (stopIfAborted() || (round > 1 && timeUp())) break;`
- 第 2 輪起逐一發言的 `if (stopIfAborted()) break;` 改成 `if (stopIfAborted() || timeUp()) break;`
- 兩處 `speakConcurrently(...)` 呼叫最後都多傳 `opts.acceptUntil`
- `conveneDiscussionTool` 的 opts 型別加 `acceptUntil?: number;`；`execute` 一開頭加：

```ts
      if (opts.acceptUntil !== undefined && Date.now() >= opts.acceptUntil) {
        yield { topic, round: 0, finished: true, error: TIME_UP, speeches: [] };
        return;
      }
```

並把 `runDiscussion({ topic, participants, maxRounds: max_rounds, run: opts.run, record: opts.record, abortSignal })` 改成多傳 `acceptUntil: opts.acceptUntil`。

- [ ] **Step 4：跑測試確認通過**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/discuss.test.ts`
Expected: PASS

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/tools/discuss.ts packages/runtime/test/discuss.test.ts
git commit -m "feat(runtime): 討論在時間不足時不再開新一輪，逾時的發言保留已寫出的內容"
```

## Task 17：把 RunClock 接進 run

**Files:**
- Modify: `packages/runtime/src/run.ts`、`packages/runtime/src/agents/build.ts`
- Test: `packages/runtime/test/server.test.ts`

**Interfaces:**
- Consumes: Task 13–16 的全部介面

- [ ] **Step 1：寫失敗的整合測試**

`packages/runtime/test/server.test.ts` 的 `describe('POST /chat：多顧問')` 內新增：

```ts
  it('時間預算：顧問逾時被停下，主管不能再用工具、改用已有結果彙整，run 成功', async () => {
    const env = await seedTeam();
    const model = mockModel(
      toolTurn('assign_task', { consultant_id: env.legalId, task: '審查合約' }),
      textTurn('法務意見：這份合約有很多條款需要逐條檢查'.repeat(4), 100),
      textTurn('總結：法務顧問逾時，只拿到部分意見'),
    );
    // runTimeoutMs 7500：顧問 5500ms 收尾、6500ms 強制停止，主管有 1 秒收尾（中間要寫雲端 DB）；顧問那段文字要 8 秒才講完
    await (await post(app(env, model, 7_500), { thread_id: env.threadId, text: '幫我看合約' })).text();
    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');

    const msgs = await messagesOf(env.threadId);
    const delegation = msgs.find((m) => m.kind === 'delegation');
    const final = msgs.find((m) => m.kind === 'final');
    expect(delegation.content.startsWith('法務意見')).toBe(true);
    expect(final.content).toBe('總結：法務顧問逾時，只拿到部分意見');
    expect(model.doStreamCalls[2].toolChoice).toEqual({ type: 'none' });
    expect(promptText(model, 2)).toContain('逾時，只完成部分工作');
    const assign = final.ui_message.parts.find((p: { type: string }) => p.type === 'tool-assign_task');
    expect(assign.output).toMatchObject({ status: 'failed', cutoff: 'stopped' });
  });
```

- [ ] **Step 2：跑測試確認失敗**

Run: `corepack pnpm -F @agenthub/runtime exec vitest run test/server.test.ts -t "時間預算"`
Expected: FAIL（顧問沒有被停下，整個 run 在 7.5 秒時逾時失敗）

- [ ] **Step 3：實作**

`packages/runtime/src/agents/build.ts`，`buildManager` 的工具改成把受理時間傳下去：

```ts
    assign_task: assignTaskTool({
      consultants: ctx.consultants, run: ctx.runner, record: ctx.record, acceptUntil: ctx.clock?.consultantWrapUpAt,
    }),
    convene_discussion: conveneDiscussionTool({
      consultants: ctx.consultants, run: ctx.runner, record: ctx.record, acceptUntil: ctx.clock?.consultantWrapUpAt,
    }),
```

`packages/runtime/src/run.ts`：

- 加 `import { createRunClock, type RunClock } from './run-clock';`
- `prepareRootAgent` 簽名改成 `prepareRootAgent(deps: RunDeps, runId: string, threadId: string, clock: RunClock)`
- 單一顧問分支的 `buildConsultant({...})` 加 `wrapUpAt: clock.soloWrapUpAt,`
- 多顧問分支：

```ts
  const built = await buildManager({
    db, model, config, manager, consultants, sharedFiles, record, clock,
    runner: createConsultantRunner({
      db, model, config, runId, sharedFiles, secrets,
      wrapUpAt: clock.consultantWrapUpAt, stopAt: clock.consultantStopAt,
    }),
    onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: manager }),
  });
```

- `startRun` 中 `const runTimeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;` 之後加 `const clock = createRunClock(Date.now(), runTimeoutMs);`，並把 `prepareRootAgent(deps, runId, req.threadId)` 改成 `prepareRootAgent(deps, runId, req.threadId, clock)`

- [ ] **Step 4：跑 runtime 全部測試與型別檢查**

Run: `corepack pnpm -F @agenthub/runtime test` 與 `corepack pnpm -F @agenthub/runtime typecheck`
Expected: 全部通過（基準清單除外）

- [ ] **Step 5：Commit（先取得使用者同意）**

```bash
git add packages/runtime/src/run.ts packages/runtime/src/agents/build.ts packages/runtime/test/server.test.ts
git commit -m "feat(runtime): run 依時間預算讓顧問與主管收尾"
```

## Task 18：前端標示逾時與提前收尾

**Files:**
- Modify: `apps/web/components/workspace/delegation-card.tsx`、`apps/web/components/workspace/discussion-view.tsx`

**Interfaces:**
- Consumes: `DelegationOutput.cutoff`、`Speech.cutoff`（Task 8 已加型別）

- [ ] **Step 1：派工卡片**

`delegation-card.tsx`，右上角狀態 chip 那段換成：

```tsx
        {output?.cutoff === 'stopped'
          ? <span className="chip chip-seal">逾時</span>
          : failedText !== undefined || output?.status === 'failed'
            ? <span className="chip chip-seal">失敗</span>
            : !output || output.status === 'working'
              ? <span className="chip chip-brand"><span className="dot-busy" aria-hidden />處理中</span>
              : <span className="chip chip-sage">完成</span>}
```

`<ToolSteps tools={output?.tools} />` 之後加：

```tsx
        {output?.cutoff === 'wrap-up' && <p className="notice notice-warn mt-3">時間到，已提前收尾</p>}
```

（逾時的說明由既有的 `output.status === 'failed'` 錯誤提示顯示，內容是 runtime 的「逾時，只交回部分結果」；已寫出的文字由既有的 `output.message` 區塊顯示。）

- [ ] **Step 2：討論發言**

`discussion-view.tsx` 的 `SpeechBlock`：

右上角加逾時 chip：

```tsx
        {speech.status === 'speaking' && <span className="chip chip-brand"><span className="dot-busy" aria-hidden />發言中</span>}
        {speech.cutoff === 'stopped' && <span className="chip chip-seal">逾時</span>}
        {speech.status === 'done' && speech.stance && <Seal stance={speech.stance} />}
```

內容區換成：

```tsx
      <ToolSteps tools={speech.tools} />
      {speech.status === 'failed' && speech.cutoff !== 'stopped' ? (
        <p className="notice notice-error mt-3">未發言：{speech.error}</p>
      ) : (
        body && (
          <div className="mt-3">
            {speech.status === 'done' ? <Collapsible><Markdown compact text={body} /></Collapsible> : <Markdown compact text={body} />}
          </div>
        )
      )}
      {speech.cutoff === 'stopped' && <p className="notice notice-error mt-3">{speech.error}</p>}
      {speech.cutoff === 'wrap-up' && <p className="notice notice-warn mt-3">時間到，已提前收尾</p>}
```

- [ ] **Step 3：檢查**

```bash
corepack pnpm -F @agenthub/web typecheck
corepack pnpm -F @agenthub/web lint
```

- [ ] **Step 4：Commit（先取得使用者同意）**

```bash
git add apps/web/components/workspace/delegation-card.tsx apps/web/components/workspace/discussion-view.tsx
git commit -m "feat(web): 標示顧問逾時與提前收尾"
```

## Task 19：段 C 上線與真實驗證

- [ ] **Step 1：完整驗證**：`corepack pnpm test`、`corepack pnpm typecheck`、`corepack pnpm -F @agenthub/web lint`
- [ ] **Step 2：合併、push、發布（對外動作，先取得使用者同意）**：呼叫 `superpowers:finishing-a-development-branch`；合併到 `main` push（web 自動部署）後執行 `corepack pnpm -F @agenthub/runtime publish-runtime`。
- [ ] **Step 3：真實驗證**：請使用者新開專案、啟用 ETF 資金流與投組最佳化兩位顧問，重問 10/7 的問題「你可以根據 etf flow，挑選最好的股票、債券、主動式 etf 去做投資組合最佳化的回測嗎」。確認：步驟列表即時更新；超過 5 分鐘輪詢時進度仍前進；最終有一份回覆（可以是部分結果），run 為 `succeeded`；DB 的 `delegation` 列有完整工具紀錄。
- [ ] **Step 4：展覽 Demo 決策**：把結果回報使用者，由使用者（與 Eric）決定 10/23 前要開新的 Demo 專案，還是執行 `redeploy-runtime`。

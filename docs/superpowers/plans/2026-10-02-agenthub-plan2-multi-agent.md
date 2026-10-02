# AgentHub 計畫 2：多 agent 協作實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 專案裡有 2 位以上顧問時，由平台內建的主管面對使用者：主管可以用 `assign_task` 派工給某位顧問，或用 `convene_discussion` 召開主持人式討論（第 1 輪平行、之後輪流、最多 3 輪），顧問的發言即時串流給前端，討論後主管依固定格式總結。

**Architecture:** 延續計畫 1 的 runtime（`packages/runtime`）。顧問的執行包成 `ConsultantRunner`（每次呼叫都重新組一個顧問 agent，產生 UIMessage 快照）。派工與討論都是 AI SDK 的 generator 工具：`execute` 每 200ms 最多 `yield` 一次目前快照（前端即時顯示），`toModelOutput` 只把結論／討論紀錄文字交給主管。每次顧問發言寫入 `messages`（`kind = 'delegation' | 'discussion'`）。

**Tech Stack:** 同計畫 1（`ai` v7 的 `ToolLoopAgent`、`tool()` async generator、`readUIMessageStream`）。

**Spec:** `docs/superpowers/specs/2026-10-02-agenthub-mvp-design.md`（§5.5、§5.6、§6.1–§6.4、§7）

**前置條件：** 計畫 1 已完成（`docs/superpowers/plans/2026-10-02-agenthub-plan1-foundation-runtime.md`）。本計畫直接修改計畫 1 建立的檔案。

## Global Constraints

- 計畫 1 的 Global Constraints 全部沿用（雲端 Supabase 只用 `--linked`、`.env` 不可印出或 commit、測試只用 mock 模型、pgTAP 檔案需要 `set local role postgres; set local search_path to public, extensions;` 前言、commit 訊息結尾加 `Claude-Session: https://claude.ai/code/session_019gWKBjFHT2VamSLeQeXEqj`）。
- 討論最多 3 輪；第 1 輪所有參與者平行發言、互相看不到；第 2 輪起依參與者順序輪流發言，看得到完整討論紀錄。
- 結束條件：某一輪（第 2 輪起）所有成功發言的人立場都是「同意」，或達到最大輪數。某一輪所有參與者都失敗時中止討論。
- 立場標記格式：發言最後一行 `立場：同意` 或 `立場：有保留`（全形或半形冒號都接受）。
- 工具快照節流：每 200ms 最多 `yield` 一次，最後一個快照一定送出。
- 主管的討論後總結必須依序包含 `## 各面向建議`、`## 共識方案`、`## 仍有分歧` 三段；沒有分歧寫「無」。
- 討論與派工的內容不寫入任何 agent 的記憶。
- 主管只有 `read_file`（以 `/shared` 為基準）、`remember`、`recall`、`assign_task`、`convene_discussion`。
- 單一顧問專案的行為與計畫 1 完全相同。

## Review Focus

1. **討論中某位顧問出錯**：該輪標成「未發言」，討論繼續，紀錄裡看得到原因；全部失敗才中止。→ Task 5 測試。
2. **主管派工給不存在的顧問 id**：不可讓 run 崩潰；inputSchema 用 enum 限制，模型仍給錯時回傳錯誤給主管。→ Task 4 測試。
3. **顧問串流中出錯**：派工工具回傳錯誤說明給主管，主管 run 不因此失敗。→ Task 4 測試。
4. **第 1 輪真的平行**：兩位顧問同時開始，不是一個做完才換下一個。→ Task 5 測試。
5. **專案有 2 位顧問但缺主管資料列**（例如直接寫 DB 而非走 `hire_agent`）：回傳明確錯誤「找不到主管」。→ Task 7 測試。

---

## 檔案結構

```
supabase/migrations/20261002000003_instance_description.sql   agent_instances.description + hire_agent 複製
supabase/tests/instance_description.test.sql
packages/runtime/src/
  types.ts            （改）AgentInstance 加 description
  project-store.ts    （改）select description
  ui-stream.ts        （新）textOf / toolEvents / hasContent / readSnapshots / consumeToEnd
  throttle.ts         （新）快照節流
  run.ts              （改）改用 ui-stream；多顧問時組主管
  consultant.ts       （新）ConsultantRunner、RecordSpeech
  tools/delegate.ts   （新）assign_task
  tools/discuss.ts    （新）討論引擎 + convene_discussion
  agents/prompts.ts   （改）共用片段、主管 prompt
  agents/build.ts     （改）wrapAgent、buildManager
packages/runtime/test/
  helpers.ts          （改）seedConsultant 預設 description、seedManager
  ui-stream.test.ts、throttle.test.ts、consultant.test.ts、delegate.test.ts、discuss.test.ts
  build.test.ts       （改）主管 prompt 測試
  server.test.ts      （改）派工、討論、缺主管
```

---

### Task 1: 顧問介紹欄位（description）

**Files:**
- Create: `supabase/migrations/20261002000003_instance_description.sql`
- Test: `supabase/tests/instance_description.test.sql`
- Modify: `packages/runtime/src/types.ts`、`packages/runtime/src/project-store.ts`、`packages/runtime/test/helpers.ts`、`packages/runtime/test/project-store.test.ts`

**Interfaces:**
- Consumes: 計畫 1 的 `agent_instances`、`hire_agent`、`loadInstances`、`seedConsultant`
- Produces: `agent_instances.description text not null default ''`；`hire_agent` 從範本複製 `description`，並在開頭以 `for update` 鎖住專案列（計畫 1 最終審查的並行啟用競態修正；專案不存在時丟 `P0002`）；`AgentInstance.description: string`；`seedManager(db, projectId): Promise<string>`；`seedConsultant` 的 `ConsultantFields` 多一個 `description?: string`（預設 `'處理法律問題'`）

- [ ] **Step 1: 寫 pgTAP 測試**

建立 `supabase/tests/instance_description.test.sql`：

```sql
begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(2);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'creator-d@test.local'),
  ('00000000-0000-0000-0000-0000000000d2', 'renter-d@test.local');
insert into public.agent_templates (id, creator_id, name, description, status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', '財務顧問', '擅長財報分析與估值', 'published');
insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d2', 'p');

select public.hire_agent('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', '{}'::jsonb);

select is(
  (select description from public.agent_instances where project_id = '00000000-0000-0000-0000-0000000000f1'),
  '擅長財報分析與估值',
  '啟用時複製範本的介紹');

select ok(
  not has_function_privilege('anon', 'public.hire_agent(uuid, uuid, jsonb)', 'execute'),
  '重新定義後 anon 仍不能執行 hire_agent');

select * from finish();
rollback;
```

- [ ] **Step 2: 確認測試失敗**

```bash
supabase test db --linked
```

Expected: `instance_description.test.sql` FAIL，錯誤類似 `column "description" does not exist`。

- [ ] **Step 3: 寫 migration**

建立 `supabase/migrations/20261002000003_instance_description.sql`：

```sql
alter table public.agent_instances add column description text not null default '';

create or replace function public.hire_agent(p_project_id uuid, p_template_id uuid, p_secrets jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.agent_templates%rowtype;
  v_instance_id uuid;
  v_server jsonb;
  v_required jsonb;
  v_value text;
  v_secret_id uuid;
  v_consultants int;
begin
  -- 鎖住專案列，讓同一專案的並行啟用依序執行（避免兩個顧問同時加入卻沒有建立主管）
  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'project % not found', p_project_id using errcode = 'P0002';
  end if;

  select * into t from public.agent_templates
   where id = p_template_id and status = 'published';
  if not found then
    raise exception 'template % not found or not published', p_template_id using errcode = 'P0002';
  end if;

  insert into public.agent_instances
    (project_id, template_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers)
  values
    (p_project_id, t.id, 'consultant', t.name, t.description, t.system_prompt, t.skills_zip_path, t.skills, t.mcp_servers)
  returning id into v_instance_id;

  for v_server in select * from jsonb_array_elements(t.mcp_servers) loop
    for v_required in select * from jsonb_array_elements(coalesce(v_server -> 'required_secrets', '[]'::jsonb)) loop
      v_value := p_secrets -> (v_server ->> 'name') ->> (v_required ->> 'key');
      if v_value is null or v_value = '' then
        raise exception 'missing secret %.%', v_server ->> 'name', v_required ->> 'key' using errcode = '22023';
      end if;
      v_secret_id := vault.create_secret(
        v_value,
        v_instance_id::text || ':' || (v_server ->> 'name') || ':' || (v_required ->> 'key'));
      insert into public.instance_secrets (instance_id, mcp_name, key, vault_secret_id)
      values (v_instance_id, v_server ->> 'name', v_required ->> 'key', v_secret_id);
    end loop;
  end loop;

  select count(*) into v_consultants
    from public.agent_instances
   where project_id = p_project_id and role = 'consultant';
  if v_consultants >= 2 then
    insert into public.agent_instances (project_id, role, name, description)
    values (p_project_id, 'manager', '主管', '平台內建主管，負責分工與整合')
    on conflict (project_id) where role = 'manager' do nothing;
  end if;

  return v_instance_id;
end $$;

revoke execute on function public.hire_agent(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hire_agent(uuid, uuid, jsonb) to service_role;
```

- [ ] **Step 4: 推上去並確認 pgTAP 全部通過**

```bash
supabase db push --linked --yes
supabase test db --linked
```

Expected: `schema.test.sql`、`hire_agent.test.sql`、`instance_description.test.sql` 全部 ok。

- [ ] **Step 5: 更新 runtime 型別、查詢與測試工具**

`packages/runtime/src/types.ts`：在 `AgentInstance` 的 `name: string;` 下一行加入：

```ts
  description: string;
```

`packages/runtime/src/project-store.ts`：`loadInstances` 的 select 字串改成：

```ts
    .select('id, project_id, template_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers, template:agent_templates(creator_id)')
```

`packages/runtime/test/helpers.ts`：

1. `ConsultantFields` 加一行 `description?: string;`
2. `seedConsultant` 的 insert 物件改成：

```ts
    .insert({
      project_id: projectId, role: 'consultant', name: '法務顧問', description: '處理法律問題',
      system_prompt: '你是法務顧問。', ...fields,
    })
```

3. 在 `seedConsultant` 後面新增：

```ts
export async function seedManager(db: Db, projectId: string): Promise<string> {
  const { data, error } = await db
    .from('agent_instances')
    .insert({ project_id: projectId, role: 'manager', name: '主管', description: '平台內建主管' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}
```

`packages/runtime/test/build.test.ts` 的 `instance()` 預設值加上 `description: '處理法律問題',`（放在 `name` 後面），讓型別通過。

`packages/runtime/test/project-store.test.ts`：第一個測試的 `seedTemplate` 欄位加上 `description: '估值專家',`，並在 `expect(instances[0]).toMatchObject({...})` 裡加上 `description: '估值專家',`。

- [ ] **Step 6: 跑 runtime 測試與型別檢查**

```bash
pnpm -F @agenthub/runtime test test/project-store.test.ts
pnpm -F @agenthub/runtime typecheck
```

Expected: PASS；typecheck 沒有錯誤。

- [ ] **Step 7: Commit**

```bash
git add supabase packages/runtime
git commit -m "feat: 顧問介紹欄位"
```

---

### Task 2: UI 串流工具與快照節流

**Files:**
- Create: `packages/runtime/src/ui-stream.ts`、`packages/runtime/src/throttle.ts`
- Modify: `packages/runtime/src/run.ts`（刪除檔內的 `textOf`、`toolEvents`、`hasContent`、`consumeToEnd`，改從 `ui-stream.ts` 引入）
- Test: `packages/runtime/test/ui-stream.test.ts`、`packages/runtime/test/throttle.test.ts`

**Interfaces:**
- Consumes: 計畫 1 的 `errorText`
- Produces:
  - `textOf(m: UIMessage | undefined): string`
  - `toolEvents(m: UIMessage): { tool: string; state: string }[]`
  - `hasContent(m: UIMessage | undefined): m is UIMessage`
  - `type StreamOutcome = { final: UIMessage | undefined; failure: string | undefined }`
  - `readSnapshots(stream: ReadableStream<UIMessageChunk>): AsyncGenerator<UIMessage, StreamOutcome>`
  - `consumeToEnd(stream: ReadableStream<UIMessageChunk>): Promise<StreamOutcome>`
  - `SNAPSHOT_INTERVAL_MS = 200`；`throttle<T>(source: AsyncIterable<T>, intervalMs?: number): AsyncGenerator<T>`（每次送出都是 `structuredClone` 過的副本）

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/ui-stream.test.ts`：

```ts
import type { UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { consumeToEnd, hasContent, readSnapshots, textOf, toolEvents } from '../src/ui-stream';

function chunks(list: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of list) controller.enqueue(c);
      controller.close();
    },
  });
}

const textChunks: UIMessageChunk[] = [
  { type: 'start', messageId: 'm1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: '你' },
  { type: 'text-delta', id: 't1', delta: '好' },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

describe('ui-stream', () => {
  it('readSnapshots 逐步產生快照，最後回傳完整訊息', async () => {
    const it = readSnapshots(chunks(textChunks));
    const seen: string[] = [];
    let r = await it.next();
    while (!r.done) {
      seen.push(textOf(r.value));
      r = await it.next();
    }
    expect(seen.at(-1)).toBe('你好');
    expect(r.value.failure).toBeUndefined();
    expect(textOf(r.value.final)).toBe('你好');
  });

  it('error chunk 會變成 failure', async () => {
    const outcome = await consumeToEnd(chunks([
      { type: 'start', messageId: 'm1' },
      { type: 'error', errorText: '模型掛了' },
    ]));
    expect(outcome.failure).toBe('模型掛了');
  });

  it('textOf / toolEvents / hasContent', () => {
    const m = {
      id: 'x',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'A' },
        { type: 'tool-write_file', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
        { type: 'text', text: 'B' },
      ],
    } as unknown as UIMessage;
    expect(textOf(m)).toBe('AB');
    expect(textOf(undefined)).toBe('');
    expect(toolEvents(m)).toEqual([{ tool: 'write_file', state: 'output-available' }]);
    expect(hasContent(m)).toBe(true);
    expect(hasContent({ id: 'y', role: 'assistant', parts: [] } as UIMessage)).toBe(false);
    expect(hasContent(undefined)).toBe(false);
  });
});
```

建立 `packages/runtime/test/throttle.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { throttle } from '../src/throttle';

async function* source(values: number[], delayMs: number) {
  for (const v of values) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield v;
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('throttle', () => {
  it('快速連續的值會被合併，最後一個值一定送出', async () => {
    const out = await collect(throttle(source([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), 40));
    expect(out.length).toBeLessThan(10);
    expect(out[0]).toBe(1);
    expect(out.at(-1)).toBe(10);
  });

  it('間隔夠長時每個值都送出', async () => {
    expect(await collect(throttle(source([1, 2, 3], 30), 10))).toEqual([1, 2, 3]);
  });

  it('送出的是副本，之後修改來源物件不影響已送出的值', async () => {
    const shared = { n: 0 };
    async function* mutating() {
      shared.n = 1;
      yield shared;
      await new Promise((r) => setTimeout(r, 20));
      shared.n = 2;
      yield shared;
    }
    const out = await collect(throttle(mutating(), 5));
    expect(out.map((o) => o.n)).toEqual([1, 2]);
  });

  it('來源丟錯時往外拋', async () => {
    async function* failing() {
      yield 1;
      throw new Error('壞了');
    }
    await expect(collect(throttle(failing(), 5))).rejects.toThrow('壞了');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/ui-stream.test.ts test/throttle.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/ui-stream"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/ui-stream.ts`：

```ts
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { errorText } from './errors';

export type StreamOutcome = { final: UIMessage | undefined; failure: string | undefined };

export function textOf(m: UIMessage | undefined): string {
  if (!m) return '';
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function toolEvents(m: UIMessage): { tool: string; state: string }[] {
  return m.parts.flatMap((p) => {
    if (p.type === 'dynamic-tool') return [{ tool: p.toolName, state: p.state }];
    if (p.type.startsWith('tool-')) return [{ tool: p.type.slice('tool-'.length), state: (p as { state: string }).state }];
    return [];
  });
}

export function hasContent(m: UIMessage | undefined): m is UIMessage {
  return !!m && m.parts.some((p) => p.type === 'text' || p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
}

export async function* readSnapshots(
  stream: ReadableStream<UIMessageChunk>,
): AsyncGenerator<UIMessage, StreamOutcome> {
  let failure: string | undefined;
  const watched = stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'error') failure = chunk.errorText;
        if (chunk.type === 'abort') failure ??= 'run 已中止';
        controller.enqueue(chunk);
      },
    }),
  );
  let final: UIMessage | undefined;
  try {
    for await (const m of readUIMessageStream({ stream: watched })) {
      final = m;
      yield m;
    }
  } catch (e) {
    failure ??= errorText(e);
  }
  return { final, failure };
}

export async function consumeToEnd(stream: ReadableStream<UIMessageChunk>): Promise<StreamOutcome> {
  const it = readSnapshots(stream);
  let r = await it.next();
  while (!r.done) r = await it.next();
  return r.value;
}
```

建立 `packages/runtime/src/throttle.ts`：

```ts
export const SNAPSHOT_INTERVAL_MS = 200;

export async function* throttle<T>(source: AsyncIterable<T>, intervalMs = SNAPSHOT_INTERVAL_MS): AsyncGenerator<T> {
  let lastEmit = 0;
  let pending: { value: T } | undefined;
  for await (const value of source) {
    const now = Date.now();
    if (now - lastEmit >= intervalMs) {
      lastEmit = now;
      pending = undefined;
      yield structuredClone(value);
    } else {
      pending = { value };
    }
  }
  if (pending) yield structuredClone(pending.value);
}
```

修改 `packages/runtime/src/run.ts`：

1. 刪除檔內的 `textOf`、`toolEvents`、`hasContent`、`consumeToEnd` 四個函式定義。
2. 刪除對 `readUIMessageStream`、`UIMessage` 的 import（若不再使用）。
3. 加入 `import { consumeToEnd, hasContent, textOf, toolEvents } from './ui-stream';`
4. 計畫 1 的 Interfaces 曾說 `textOf`、`toolEvents` 由 `run.ts` 匯出；改成由 `ui-stream.ts` 匯出，`run.ts` 不再重新匯出（沒有其他檔案從 `run.ts` 引入它們）。

- [ ] **Step 4: 確認新測試與既有測試都通過**

```bash
pnpm -F @agenthub/runtime test
pnpm -F @agenthub/runtime typecheck
```

Expected: 所有測試檔 PASS（包含計畫 1 的 `server.test.ts`）；typecheck 沒有錯誤。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "refactor(runtime): UI 串流工具與快照節流"
```

---

### Task 3: 顧問執行器（ConsultantRunner）

**Files:**
- Create: `packages/runtime/src/consultant.ts`
- Test: `packages/runtime/test/consultant.test.ts`

**Interfaces:**
- Consumes: `buildConsultant`（計畫 1 Task 8）、`groupSecrets`、`usageRecorder`、`readSnapshots`、`hasContent`、`SecretRow`、`AgentInstance`
- Produces:
  - `type ConsultantRunner = (instance: AgentInstance, task: string, abortSignal?: AbortSignal) => AsyncGenerator<UIMessage>`：產生顧問發言的快照；顧問串流出錯或完全沒有內容時丟 `Error`
  - `type RecordSpeech = (instance: AgentInstance, message: UIMessage, round: number | null) => Promise<void>`：`round` 為 `null` 代表派工
  - `type ConsultantRunnerDeps = { db: Db; model: LanguageModel; config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>; runId: string; sharedFiles: string[]; secrets: SecretRow[] }`
  - `createConsultantRunner(deps: ConsultantRunnerDeps): ConsultantRunner`

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/consultant.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createConsultantRunner } from '../src/consultant';
import { createRun } from '../src/run-store';
import { loadInstances } from '../src/project-store';
import { textOf } from '../src/ui-stream';
import { seedConsultant, seedProject, seedThread, seedUser, testDb, tmpRoots, waitFor } from './helpers';
import { failingModel, mockModel, promptText, textTurn } from './mock-model';
import type { LanguageModel } from 'ai';

const db = testDb();

async function setup(model: LanguageModel) {
  const projectId = await seedProject(db, await seedUser(db));
  const threadId = await seedThread(db, projectId);
  const runId = await createRun(db, threadId);
  const consultantId = await seedConsultant(db, projectId, { system_prompt: '你是稅務顧問。' });
  const roots = await tmpRoots();
  const [instance] = await loadInstances(db, projectId);
  const run = createConsultantRunner({
    db, model, runId, sharedFiles: [], secrets: [],
    config: { PROJECT_ID: projectId, AGENTS_ROOT: roots.agentsRoot, SHARED_ROOT: roots.sharedRoot },
  });
  return { run, instance, runId, consultantId };
}

describe('createConsultantRunner', () => {
  it('產生快照，最後一個快照是完整回覆；任務當作使用者訊息、記錄用量', async () => {
    const model = mockModel(textTurn('稅務建議如下'));
    const { run, instance, runId, consultantId } = await setup(model);
    const snapshots = [];
    for await (const m of run(instance, '幫我看節稅方案')) snapshots.push(m);
    expect(textOf(snapshots.at(-1))).toBe('稅務建議如下');
    expect(promptText(model)).toContain('幫我看節稅方案');
    expect(promptText(model)).toContain('你是稅務顧問。');
    const rows = await waitFor(async () => {
      const { data } = await db.from('usage_events').select('instance_id').eq('run_id', runId);
      return data?.length ? data : undefined;
    });
    expect(rows[0].instance_id).toBe(consultantId);
  });

  it('模型出錯時丟出錯誤', async () => {
    const { run, instance } = await setup(failingModel('顧問掛了'));
    const consume = async () => {
      for await (const _ of run(instance, '任務')) { /* drain */ }
    };
    await expect(consume()).rejects.toThrow('顧問掛了');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/consultant.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/consultant"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/consultant.ts`：

```ts
import type { LanguageModel, UIMessage } from 'ai';
import { buildConsultant } from './agents/build';
import type { Config } from './config';
import type { Db } from './db';
import { groupSecrets } from './project-store';
import type { AgentInstance, SecretRow } from './types';
import { hasContent, readSnapshots } from './ui-stream';
import { usageRecorder } from './usage';

export type ConsultantRunner = (instance: AgentInstance, task: string, abortSignal?: AbortSignal) => AsyncGenerator<UIMessage>;

export type RecordSpeech = (instance: AgentInstance, message: UIMessage, round: number | null) => Promise<void>;

export type ConsultantRunnerDeps = {
  db: Db;
  model: LanguageModel;
  config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>;
  runId: string;
  sharedFiles: string[];
  secrets: SecretRow[];
};

export function createConsultantRunner(deps: ConsultantRunnerDeps): ConsultantRunner {
  return async function* runConsultant(instance, task, abortSignal) {
    const built = await buildConsultant({
      db: deps.db,
      model: deps.model,
      config: deps.config,
      instance,
      sharedFiles: deps.sharedFiles,
      secrets: groupSecrets(deps.secrets, instance.id),
      onStepEnd: usageRecorder({ db: deps.db, projectId: deps.config.PROJECT_ID, runId: deps.runId, instance }),
    });
    try {
      const snapshots = readSnapshots(await built.streamUI({ messages: [{ role: 'user', content: task }], abortSignal }));
      let r = await snapshots.next();
      while (!r.done) {
        yield r.value;
        r = await snapshots.next();
      }
      if (r.value.failure) throw new Error(r.value.failure);
      if (!hasContent(r.value.final)) throw new Error(`${instance.name} 沒有產生任何回覆`);
    } finally {
      await built.close();
    }
  };
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/consultant.test.ts
```

Expected: 2 個測試 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 顧問執行器"
```

---

### Task 4: 派工工具 `assign_task`

**Files:**
- Create: `packages/runtime/src/tools/delegate.ts`
- Test: `packages/runtime/test/delegate.test.ts`

**Interfaces:**
- Consumes: `ConsultantRunner`、`RecordSpeech`（Task 3）、`throttle`、`textOf`（Task 2）、`errorText`
- Produces:
  - `type DelegationOutput = { consultant_id: string; name: string; status: 'working' | 'done' | 'failed'; message?: UIMessage; error?: string }`
  - `assignTaskTool(opts: { consultants: AgentInstance[]; run: ConsultantRunner; record: RecordSpeech; intervalMs?: number })`：`consultants` 至少 1 位；inputSchema `{ consultant_id: enum(顧問 id), task: string }`

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/delegate.test.ts`：

```ts
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ConsultantRunner, RecordSpeech } from '../src/consultant';
import { assignTaskTool, type DelegationOutput } from '../src/tools/delegate';
import type { AgentInstance } from '../src/types';

const opts = { toolCallId: 't', messages: [] } as never;

function consultant(id: string, name: string): AgentInstance {
  return {
    id, name, description: '', project_id: 'p', template_id: null, creator_id: null, role: 'consultant',
    system_prompt: '', skills_zip_path: null, skills: [], mcp_servers: [],
  };
}

const msg = (text: string): UIMessage => ({ id: 'm', role: 'assistant', parts: [{ type: 'text', text }] });

async function drain(it: AsyncIterable<DelegationOutput>): Promise<DelegationOutput[]> {
  const out: DelegationOutput[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const legal = consultant('c-legal', '法務顧問');

describe('assign_task', () => {
  it('串流顧問快照，完成後記錄發言，交給主管的是最後的文字', async () => {
    const run: ConsultantRunner = async function* () {
      yield msg('初步');
      yield msg('初步看法：有風險');
    };
    const recorded: Array<[string, string, number | null]> = [];
    const record: RecordSpeech = async (i, m, round) => {
      recorded.push([i.id, (m.parts[0] as { text: string }).text, round]);
    };
    const t = assignTaskTool({ consultants: [legal], run, record, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: '審合約' }, opts) as AsyncIterable<DelegationOutput>);

    expect(outputs.at(-1)).toMatchObject({ consultant_id: 'c-legal', name: '法務顧問', status: 'done' });
    expect(outputs.some((o) => o.status === 'working')).toBe(true);
    expect(recorded).toEqual([['c-legal', '初步看法：有風險', null]]);
    expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: '審合約' }, output: outputs.at(-1)! }))
      .toEqual({ type: 'text', value: '初步看法：有風險' });
  });

  it('顧問出錯：不丟例外，回傳錯誤給主管，不記錄發言', async () => {
    const run: ConsultantRunner = async function* () {
      yield msg('寫到一半');
      throw new Error('MCP 斷線');
    };
    const recorded: unknown[] = [];
    const t = assignTaskTool({ consultants: [legal], run, record: async (...a) => { recorded.push(a); }, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    const last = outputs.at(-1)!;
    expect(last).toMatchObject({ status: 'failed', error: 'MCP 斷線' });
    expect(recorded).toEqual([]);
    expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: 'x' }, output: last }))
      .toEqual({ type: 'error-text', value: '法務顧問 執行失敗：MCP 斷線' });
  });

  it('顧問 id 不存在：回傳錯誤而不是崩潰', async () => {
    const run: ConsultantRunner = async function* () {
      yield msg('不該被呼叫');
    };
    const t = assignTaskTool({ consultants: [legal], run, record: async () => {}, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'nope', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    expect(outputs).toEqual([{ consultant_id: 'nope', name: 'nope', status: 'failed', error: '找不到這位顧問' }]);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/delegate.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/tools/delegate"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/tools/delegate.ts`：

```ts
import { tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { errorText } from '../errors';
import { SNAPSHOT_INTERVAL_MS, throttle } from '../throttle';
import type { AgentInstance } from '../types';
import { textOf } from '../ui-stream';

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  message?: UIMessage;
  error?: string;
};

export function assignTaskTool(opts: {
  consultants: AgentInstance[];
  run: ConsultantRunner;
  record: RecordSpeech;
  intervalMs?: number;
}) {
  const byId = new Map(opts.consultants.map((c) => [c.id, c]));
  const ids = opts.consultants.map((c) => c.id) as [string, ...string[]];

  return tool({
    description: '把任務交給一位顧問執行，拿回他的結果。任務說明要寫清楚背景與要交付的內容。',
    inputSchema: z.object({
      consultant_id: z.enum(ids).describe('顧問的 id'),
      task: z.string().min(1).describe('交給顧問的任務說明'),
    }),
    async *execute({ consultant_id, task }, { abortSignal }): AsyncGenerator<DelegationOutput> {
      const instance = byId.get(consultant_id);
      if (!instance) {
        yield { consultant_id, name: consultant_id, status: 'failed', error: '找不到這位顧問' };
        return;
      }
      const base = { consultant_id, name: instance.name };
      let last: UIMessage | undefined;
      try {
        for await (const message of throttle(opts.run(instance, task, abortSignal), opts.intervalMs ?? SNAPSHOT_INTERVAL_MS)) {
          last = message;
          yield { ...base, status: 'working', message };
        }
        if (last) await opts.record(instance, last, null);
        yield { ...base, status: 'done', message: last };
      } catch (e) {
        yield { ...base, status: 'failed', message: last, error: errorText(e) };
      }
    },
    toModelOutput: ({ output }) =>
      output.status === 'failed'
        ? { type: 'error-text', value: `${output.name} 執行失敗：${output.error}` }
        : { type: 'text', value: textOf(output.message) || '（顧問沒有回覆內容）' },
  });
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/delegate.test.ts
pnpm -F @agenthub/runtime typecheck
```

Expected: 3 個測試 PASS；typecheck 沒有錯誤。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 派工工具 assign_task"
```

---

### Task 5: 主持人式討論 `convene_discussion`

**Files:**
- Create: `packages/runtime/src/tools/discuss.ts`
- Test: `packages/runtime/test/discuss.test.ts`

**Interfaces:**
- Consumes: `ConsultantRunner`、`RecordSpeech`、`throttle`、`textOf`、`errorText`
- Produces:
  - `MAX_ROUNDS = 3`
  - `type Stance = 'agree' | 'reserve'`
  - `type Speech = { consultant_id: string; name: string; round: number; status: 'speaking' | 'done' | 'failed'; text: string; stance?: Stance; message?: UIMessage; error?: string }`
  - `type DiscussionState = { topic: string; round: number; finished: boolean; error?: string; speeches: Speech[] }`
  - `parseStance(text: string): Stance | undefined`
  - `formatTranscript(state: DiscussionState): string`
  - `roundPrompt(topic: string, round: number, transcript: string): string`
  - `runDiscussion(opts: { topic: string; participants: AgentInstance[]; maxRounds: number; run: ConsultantRunner; record: RecordSpeech; abortSignal?: AbortSignal }): AsyncGenerator<DiscussionState>`：狀態改變就產生一份（未節流）
  - `conveneDiscussionTool(opts: { consultants: AgentInstance[]; run: ConsultantRunner; record: RecordSpeech; intervalMs?: number })`：inputSchema `{ topic, participant_ids: enum[] (至少 2 位), max_rounds?: 1–3，預設 3 }`

- [ ] **Step 1: 寫測試**

建立 `packages/runtime/test/discuss.test.ts`：

```ts
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ConsultantRunner, RecordSpeech } from '../src/consultant';
import {
  conveneDiscussionTool, formatTranscript, parseStance, roundPrompt, runDiscussion, type DiscussionState,
} from '../src/tools/discuss';
import type { AgentInstance } from '../src/types';

const opts = { toolCallId: 't', messages: [] } as never;

function consultant(id: string, name: string): AgentInstance {
  return {
    id, name, description: '', project_id: 'p', template_id: null, creator_id: null, role: 'consultant',
    system_prompt: '', skills_zip_path: null, skills: [], mcp_servers: [],
  };
}
const legal = consultant('c-legal', '法務');
const eng = consultant('c-eng', '工程');
const msg = (text: string): UIMessage => ({ id: 'm', role: 'assistant', parts: [{ type: 'text', text }] });

async function finalState(it: AsyncIterable<DiscussionState>): Promise<DiscussionState> {
  let last: DiscussionState | undefined;
  for await (const s of it) last = s;
  return last!;
}

/** 依 (顧問 id, 第幾次被呼叫) 決定回覆；記錄每次呼叫收到的任務 */
function scriptedRunner(script: Record<string, string[]>, delayMs = 0) {
  const calls: Array<{ id: string; task: string; startedAt: number }> = [];
  const counts: Record<string, number> = {};
  const run: ConsultantRunner = async function* (instance, task) {
    calls.push({ id: instance.id, task, startedAt: Date.now() });
    const n = (counts[instance.id] = (counts[instance.id] ?? 0) + 1);
    const reply = script[instance.id][n - 1];
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (reply.startsWith('ERROR:')) throw new Error(reply.slice('ERROR:'.length));
    yield msg(reply);
  };
  return { run, calls };
}

const noRecord: RecordSpeech = async () => {};

describe('parseStance', () => {
  it('讀最後一個立場標記，全形半形冒號都接受', () => {
    expect(parseStance('意見\n立場：同意')).toBe('agree');
    expect(parseStance('意見\n立場: 有保留')).toBe('reserve');
    expect(parseStance('先寫立場：同意\n後來改成\n立場：有保留')).toBe('reserve');
    expect(parseStance('沒有標記')).toBeUndefined();
  });
});

describe('runDiscussion', () => {
  it('第 1 輪平行：兩位顧問同時開始', async () => {
    const { run, calls } = scriptedRunner({ 'c-legal': ['L1'], 'c-eng': ['E1'] }, 50);
    await finalState(runDiscussion({ topic: '題目', participants: [legal, eng], maxRounds: 1, run, record: noRecord }));
    expect(calls).toHaveLength(2);
    expect(Math.abs(calls[0].startedAt - calls[1].startedAt)).toBeLessThan(40);
  });

  it('第 2 輪所有人同意就結束；第 2 輪的任務帶有第 1 輪紀錄', async () => {
    const { run, calls } = scriptedRunner({
      'c-legal': ['L1', 'L2\n立場：同意', 'L3'],
      'c-eng': ['E1', 'E2\n立場：同意', 'E3'],
    });
    const state = await finalState(runDiscussion({ topic: '要不要上線', participants: [legal, eng], maxRounds: 3, run, record: noRecord }));
    expect(state.finished).toBe(true);
    expect(state.round).toBe(2);
    expect(state.speeches.map((s) => [s.consultant_id, s.round])).toEqual([
      ['c-legal', 1], ['c-eng', 1], ['c-legal', 2], ['c-eng', 2],
    ]);
    const round2Legal = calls.find((c) => c.id === 'c-legal' && c.task.includes('第 2 輪'))!;
    expect(round2Legal.task).toContain('L1');
    expect(round2Legal.task).toContain('E1');
    expect(round2Legal.task).toContain('立場：同意');
    const round2Eng = calls.find((c) => c.id === 'c-eng' && c.task.includes('第 2 輪'))!;
    expect(round2Eng.task).toContain('L2');
  });

  it('有人保留就跑到最大輪數', async () => {
    const { run } = scriptedRunner({
      'c-legal': ['L1', 'L2\n立場：有保留', 'L3\n立場：有保留'],
      'c-eng': ['E1', 'E2\n立場：同意', 'E3\n立場：同意'],
    });
    const state = await finalState(runDiscussion({ topic: 't', participants: [legal, eng], maxRounds: 3, run, record: noRecord }));
    expect(state.round).toBe(3);
    expect(state.speeches).toHaveLength(6);
    expect(state.finished).toBe(true);
  });

  it('某位顧問失敗：標成未發言，討論繼續，紀錄裡看得到原因', async () => {
    const { run } = scriptedRunner({
      'c-legal': ['ERROR:逾時', 'L2\n立場：同意'],
      'c-eng': ['E1', 'E2\n立場：同意'],
    });
    const state = await finalState(runDiscussion({ topic: 't', participants: [legal, eng], maxRounds: 2, run, record: noRecord }));
    expect(state.speeches[0]).toMatchObject({ consultant_id: 'c-legal', status: 'failed', error: '逾時' });
    expect(state.speeches).toHaveLength(4);
    expect(formatTranscript(state)).toContain('【第 1 輪｜法務】（未發言：逾時）');
  });

  it('某一輪全部失敗：中止並帶錯誤', async () => {
    const { run } = scriptedRunner({ 'c-legal': ['ERROR:a'], 'c-eng': ['ERROR:b'] });
    const state = await finalState(runDiscussion({ topic: 't', participants: [legal, eng], maxRounds: 3, run, record: noRecord }));
    expect(state.finished).toBe(true);
    expect(state.error).toBe('第 1 輪所有顧問都無法發言');
    expect(state.speeches).toHaveLength(2);
  });

  it('每次成功發言都記錄，帶第幾輪', async () => {
    const recorded: Array<[string, number | null]> = [];
    const { run } = scriptedRunner({ 'c-legal': ['L1', 'L2\n立場：同意'], 'c-eng': ['E1', 'ERROR:x'] });
    await finalState(runDiscussion({
      topic: 't', participants: [legal, eng], maxRounds: 2, run,
      record: async (i, _m, round) => { recorded.push([i.id, round]); },
    }));
    expect(recorded.sort()).toEqual([['c-eng', 1], ['c-legal', 1], ['c-legal', 2]]);
  });
});

describe('roundPrompt / formatTranscript', () => {
  it('第 1 輪不帶紀錄；之後要求立場標記', () => {
    expect(roundPrompt('題目A', 1, '')).not.toContain('目前的討論紀錄');
    const p = roundPrompt('題目A', 2, '【第 1 輪｜法務】\nL1');
    expect(p).toContain('題目A');
    expect(p).toContain('L1');
    expect(p).toContain('立場：同意');
  });
});

describe('convene_discussion 工具', () => {
  it('產生節流後的快照；交給主管的是完整討論紀錄', async () => {
    const { run } = scriptedRunner({ 'c-legal': ['L1', 'L2\n立場：同意'], 'c-eng': ['E1', 'E2\n立場：同意'] });
    const t = conveneDiscussionTool({ consultants: [legal, eng], run, record: noRecord, intervalMs: 0 });
    const outputs: DiscussionState[] = [];
    for await (const s of t.execute!({ topic: '題目', participant_ids: ['c-legal', 'c-eng'], max_rounds: 3 }, opts) as AsyncIterable<DiscussionState>) {
      outputs.push(s);
    }
    const last = outputs.at(-1)!;
    expect(last.finished).toBe(true);
    const out = t.toModelOutput!({ toolCallId: 't', input: { topic: '題目', participant_ids: ['c-legal', 'c-eng'], max_rounds: 3 }, output: last });
    expect(out.type).toBe('text');
    expect((out as { value: string }).value).toContain('【第 2 輪｜工程】');
    expect((out as { value: string }).value).toContain('E2');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/discuss.test.ts
```

Expected: FAIL，`Failed to resolve import "../src/tools/discuss"`。

- [ ] **Step 3: 實作**

建立 `packages/runtime/src/tools/discuss.ts`：

```ts
import { tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { errorText } from '../errors';
import { SNAPSHOT_INTERVAL_MS, throttle } from '../throttle';
import type { AgentInstance } from '../types';
import { textOf } from '../ui-stream';

export const MAX_ROUNDS = 3;

export type Stance = 'agree' | 'reserve';

export type Speech = {
  consultant_id: string;
  name: string;
  round: number;
  status: 'speaking' | 'done' | 'failed';
  text: string;
  stance?: Stance;
  message?: UIMessage;
  error?: string;
};

export type DiscussionState = { topic: string; round: number; finished: boolean; error?: string; speeches: Speech[] };

export function parseStance(text: string): Stance | undefined {
  const matches = [...text.matchAll(/立場\s*[:：]\s*(同意|有保留)/g)];
  const last = matches.at(-1)?.[1];
  if (last === '同意') return 'agree';
  if (last === '有保留') return 'reserve';
  return undefined;
}

export function formatTranscript(state: DiscussionState): string {
  return state.speeches
    .filter((s) => s.status !== 'speaking')
    .map((s) =>
      s.status === 'failed'
        ? `【第 ${s.round} 輪｜${s.name}】（未發言：${s.error}）`
        : `【第 ${s.round} 輪｜${s.name}】\n${s.text}`,
    )
    .join('\n\n');
}

export function roundPrompt(topic: string, round: number, transcript: string): string {
  if (round === 1) {
    return `你正在參加一場專案討論。\n題目：${topic}\n\n請從你的專業角度提出獨立意見：重點、風險與建議。`;
  }
  return [
    `你正在參加一場專案討論（第 ${round} 輪）。`,
    `題目：${topic}`,
    '',
    '目前的討論紀錄：',
    transcript,
    '',
    '請回應其他人的意見：同意的地方、反對或補充的地方，必要時修正你的看法。',
    '最後一行必須是「立場：同意」或「立場：有保留」。',
  ].join('\n');
}

function snapshot(state: DiscussionState): DiscussionState {
  return { ...state, speeches: state.speeches.map((s) => ({ ...s })) };
}

function changeFeed() {
  let dirty = false;
  let wake: (() => void) | undefined;
  return {
    mark() {
      dirty = true;
      wake?.();
      wake = undefined;
    },
    async next() {
      if (!dirty) await new Promise<void>((resolve) => (wake = resolve));
      dirty = false;
    },
  };
}

async function* speakConcurrently(
  speakers: { instance: AgentInstance; prompt: string }[],
  round: number,
  state: DiscussionState,
  run: ConsultantRunner,
  record: RecordSpeech,
  abortSignal?: AbortSignal,
): AsyncGenerator<DiscussionState> {
  const feed = changeFeed();
  let pending = speakers.length;
  const tasks = speakers.map(async ({ instance, prompt }) => {
    const speech: Speech = { consultant_id: instance.id, name: instance.name, round, status: 'speaking', text: '' };
    state.speeches.push(speech);
    feed.mark();
    try {
      for await (const message of run(instance, prompt, abortSignal)) {
        speech.message = message;
        speech.text = textOf(message);
        feed.mark();
      }
      speech.status = 'done';
      speech.stance = parseStance(speech.text);
      if (speech.message) await record(instance, speech.message, round);
    } catch (e) {
      speech.status = 'failed';
      speech.error = errorText(e);
    } finally {
      pending -= 1;
      feed.mark();
    }
  });
  while (pending > 0) {
    await feed.next();
    yield snapshot(state);
  }
  await Promise.all(tasks);
}

export async function* runDiscussion(opts: {
  topic: string;
  participants: AgentInstance[];
  maxRounds: number;
  run: ConsultantRunner;
  record: RecordSpeech;
  abortSignal?: AbortSignal;
}): AsyncGenerator<DiscussionState> {
  const state: DiscussionState = { topic: opts.topic, round: 1, finished: false, speeches: [] };
  const maxRounds = Math.min(Math.max(opts.maxRounds, 1), MAX_ROUNDS);

  for (let round = 1; round <= maxRounds; round++) {
    state.round = round;
    if (round === 1) {
      const prompt = roundPrompt(opts.topic, 1, '');
      yield* speakConcurrently(
        opts.participants.map((instance) => ({ instance, prompt })),
        1, state, opts.run, opts.record, opts.abortSignal,
      );
    } else {
      for (const instance of opts.participants) {
        const prompt = roundPrompt(opts.topic, round, formatTranscript(state));
        yield* speakConcurrently([{ instance, prompt }], round, state, opts.run, opts.record, opts.abortSignal);
      }
    }

    const thisRound = state.speeches.filter((s) => s.round === round);
    const succeeded = thisRound.filter((s) => s.status === 'done');
    if (succeeded.length === 0) {
      state.error = `第 ${round} 輪所有顧問都無法發言`;
      break;
    }
    if (round >= 2 && succeeded.every((s) => s.stance === 'agree')) break;
  }

  state.finished = true;
  yield snapshot(state);
}

export function conveneDiscussionTool(opts: {
  consultants: AgentInstance[];
  run: ConsultantRunner;
  record: RecordSpeech;
  intervalMs?: number;
}) {
  const byId = new Map(opts.consultants.map((c) => [c.id, c]));
  const ids = opts.consultants.map((c) => c.id) as [string, ...string[]];

  return tool({
    description:
      '召開主持人式討論：多位顧問就同一題目來回討論。第 1 輪各自獨立發言，之後輪流回應並標記立場；全部同意或達到輪數上限時結束，回傳完整討論紀錄。需要跨專業權衡時使用。',
    inputSchema: z.object({
      topic: z.string().min(1).describe('討論題目，寫清楚背景與要決定的事'),
      participant_ids: z.array(z.enum(ids)).min(2).describe('參與討論的顧問 id'),
      max_rounds: z.number().int().min(1).max(MAX_ROUNDS).default(MAX_ROUNDS),
    }),
    async *execute({ topic, participant_ids, max_rounds }, { abortSignal }): AsyncGenerator<DiscussionState> {
      const participants = [...new Set(participant_ids)].map((id) => byId.get(id)).filter((c): c is AgentInstance => !!c);
      yield* throttle(
        runDiscussion({ topic, participants, maxRounds: max_rounds, run: opts.run, record: opts.record, abortSignal }),
        opts.intervalMs ?? SNAPSHOT_INTERVAL_MS,
      );
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: [
        `討論題目：${output.topic}`,
        `共進行 ${output.round} 輪${output.error ? `，提前中止：${output.error}` : ''}`,
        '',
        formatTranscript(output),
      ].join('\n'),
    }),
  });
}
```

- [ ] **Step 4: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/discuss.test.ts
pnpm -F @agenthub/runtime typecheck
```

Expected: 10 個測試 PASS；typecheck 沒有錯誤。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 主持人式討論 convene_discussion"
```

---

### Task 6: 主管 prompt 與組裝

**Files:**
- Modify: `packages/runtime/src/agents/prompts.ts`、`packages/runtime/src/agents/build.ts`
- Test: `packages/runtime/test/build.test.ts`（新增測試）

**Interfaces:**
- Consumes: `assignTaskTool`（Task 4）、`conveneDiscussionTool`（Task 5）、`ConsultantRunner`、`RecordSpeech`（Task 3）、計畫 1 的 `readFileTool`、`memoryTools`、`loadMemories`、`formatMemoryBlock`、`MAX_STEPS`、`BuiltAgent`
- Produces:
  - `SUMMARY_HEADINGS = ['## 各面向建議', '## 共識方案', '## 仍有分歧'] as const`
  - `buildManagerInstructions(p: ManagerPromptInput): string`；`ManagerPromptInput = { consultants: AgentInstance[]; memories: MemoryRow[]; sharedRoot: string; sharedFiles: string[] }`
  - `buildManager(ctx: ManagerContext): Promise<BuiltAgent>`；`ManagerContext = { db: Db; model: LanguageModel; config: Pick<Config, 'PROJECT_ID' | 'SHARED_ROOT'>; manager: AgentInstance; consultants: AgentInstance[]; sharedFiles: string[]; runner: ConsultantRunner; record: RecordSpeech; onStepEnd?: (step: StepLike) => Promise<void> | void }`
  - `buildConsultant` 行為不變，但改用共用的 `wrapAgent`

- [ ] **Step 1: 寫測試**

在 `packages/runtime/test/build.test.ts` 最上方 import 區加入：

```ts
import { buildManager } from '../src/agents/build';
import { buildManagerInstructions, SUMMARY_HEADINGS } from '../src/agents/prompts';
import type { ConsultantRunner } from '../src/consultant';
import { seedManager } from './helpers';
```

（`buildManager` 與既有的 `buildConsultant` 合併成同一行 import；`buildManagerInstructions` 與既有的 `buildConsultantInstructions` 合併；`seedManager` 加進既有的 helpers import。）

在檔案最後加入：

```ts
describe('buildManagerInstructions', () => {
  it('列出顧問名稱、id、介紹，說明分工方式與總結格式', () => {
    const text = buildManagerInstructions({
      consultants: [
        instance({ id: 'c-1', name: '法務顧問', description: '契約與法遵' }),
        instance({ id: 'c-2', name: '工程顧問', description: '' }),
      ],
      memories: [],
      sharedRoot: '/shared',
      sharedFiles: ['需求.md'],
    });
    expect(text).toContain('- 法務顧問（id: c-1）：契約與法遵');
    expect(text).toContain('- 工程顧問（id: c-2）：（沒有介紹）');
    expect(text).toContain('assign_task');
    expect(text).toContain('convene_discussion');
    for (const h of SUMMARY_HEADINGS) expect(text).toContain(h);
    expect(text).toContain('/shared/需求.md');
    expect(text).toContain('（目前沒有記憶）');
  });
});

describe('buildManager', () => {
  it('主管只有 read_file、remember、recall、assign_task、convene_discussion', async () => {
    const projectId = await seedProject(db, await seedUser(db));
    const managerId = await seedManager(db, projectId);
    const roots = await tmpRoots();
    const model = mockModel(textTurn('好的'));
    const runner: ConsultantRunner = async function* () {};
    const built = await buildManager({
      db, model,
      config: { PROJECT_ID: projectId, SHARED_ROOT: roots.sharedRoot },
      manager: instance({ id: managerId, project_id: projectId, role: 'manager', name: '主管' }),
      consultants: [instance({ id: 'c-1', name: 'A' }), instance({ id: 'c-2', name: 'B' })],
      sharedFiles: [],
      runner,
      record: async () => {},
    });
    for await (const _ of readUIMessageStream({ stream: await built.streamUI({ messages: [{ role: 'user', content: '嗨' }] }) })) { /* drain */ }
    expect(model.doStreamCalls[0].tools?.map((t) => t.name).sort()).toEqual([
      'assign_task', 'convene_discussion', 'read_file', 'recall', 'remember',
    ]);
    expect(promptText(model)).toContain('（id: c-1）');
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/build.test.ts
```

Expected: FAIL，`buildManagerInstructions` / `buildManager` 不存在。

- [ ] **Step 3: 重構 prompts 並加入主管 prompt**

`packages/runtime/src/agents/prompts.ts` 改成：

```ts
import path from 'node:path';
import { formatMemoryBlock, type MemoryRow } from '../tools/memory';
import type { AgentInstance } from '../types';

export const SUMMARY_HEADINGS = ['## 各面向建議', '## 共識方案', '## 仍有分歧'] as const;

const MEMORY_RULE = '只有使用者明確說過的事實與偏好，才用 remember 記下來。你自己或其他 agent 推論出的內容不要記。';

function filesSection(sharedRoot: string, sharedFiles: string[]): string {
  const files = sharedFiles.length
    ? sharedFiles.map((f) => `- ${path.join(sharedRoot, f)}`).join('\n')
    : '（目前沒有專案檔案）';
  return ['## 專案檔案', files].join('\n');
}

function memorySection(memories: MemoryRow[]): string {
  return ['## 記憶', formatMemoryBlock(memories), MEMORY_RULE].join('\n');
}

export type ConsultantPromptInput = {
  instance: AgentInstance;
  workDir: string;
  skillsDir: string;
  sharedRoot: string;
  sharedFiles: string[];
  memories: MemoryRow[];
  mcpWarnings: string[];
};

export function buildConsultantInstructions(p: ConsultantPromptInput): string {
  const skills = p.instance.skills.length
    ? [
        ...p.instance.skills.map(
          (s) => `- ${s.name}：${s.description}（完整說明：${path.join(p.skillsDir, s.path, 'SKILL.md')}）`,
        ),
        '使用某個 skill 之前，先用 read_file 讀它的 SKILL.md，再照著做。',
      ].join('\n')
    : '（沒有 skill）';

  const sections = [
    p.instance.system_prompt.trim(),
    [
      '## 工作環境',
      `- 你的工作目錄：${p.workDir}。bash 指令和相對路徑都以這裡為基準。`,
      `- 專案共用檔案放在 ${p.sharedRoot}，所有 agent 都能讀寫。`,
    ].join('\n'),
    filesSection(p.sharedRoot, p.sharedFiles),
    ['## 你的 skills', skills].join('\n'),
    memorySection(p.memories),
  ];
  if (p.mcpWarnings.length) {
    sections.push(['## 目前無法使用的工具', ...p.mcpWarnings.map((w) => `- ${w}`)].join('\n'));
  }
  return sections.join('\n\n');
}

export type ManagerPromptInput = {
  consultants: AgentInstance[];
  memories: MemoryRow[];
  sharedRoot: string;
  sharedFiles: string[];
};

export function buildManagerInstructions(p: ManagerPromptInput): string {
  return [
    '你是這個專案的主管，直接面對使用者。你沒有自己的專業 skill：專業問題一律交給顧問處理；簡單的寒暄或釐清需求可以直接回答。',
    ['## 你的顧問', ...p.consultants.map((c) => `- ${c.name}（id: ${c.id}）：${c.description || '（沒有介紹）'}`)].join('\n'),
    [
      '## 怎麼分工',
      '- 只需要單一專業時，用 assign_task 把任務交給最合適的顧問，任務說明要寫清楚背景與要交付的內容。',
      '- 需要跨專業權衡時（例如法律風險與工程成本互相牽制），用 convene_discussion 召開討論，邀請相關顧問參加。',
      '- 拿到顧問的結果後，整理成給使用者的回覆，不要只是轉貼。',
    ].join('\n'),
    [
      '## 討論後的總結格式',
      '召開討論後，最終回覆必須依序包含以下三段：',
      ...SUMMARY_HEADINGS,
      '「仍有分歧」要明確列出顧問之間沒有達成共識的地方，沒有分歧就寫「無」。不可以假裝大家都同意。',
    ].join('\n'),
    filesSection(p.sharedRoot, p.sharedFiles),
    memorySection(p.memories),
  ].join('\n\n');
}
```

- [ ] **Step 4: 加入 wrapAgent 與 buildManager**

`packages/runtime/src/agents/build.ts`：

1. import 區加入：

```ts
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { assignTaskTool } from '../tools/delegate';
import { conveneDiscussionTool } from '../tools/discuss';
import { buildConsultantInstructions, buildManagerInstructions } from './prompts';
```

（取代原本只 import `buildConsultantInstructions` 的那一行。）

2. 在 `BuiltAgent` 型別後面新增 `wrapAgent(agent, instructions, warnings, close): BuiltAgent`。**把 `buildConsultant` 目前回傳物件裡的 `streamUI` 實作原封不動搬進 `wrapAgent`**——計畫 1 最終審查的修正已經在 `streamUI` 裡把 `warnings` 以 `data-warning` 資料片段注入串流，這段行為必須保留（主管的 `warnings` 是空陣列，所以不會注入任何東西）。骨架：

```ts
function wrapAgent(agent: ToolLoopAgent<never, ToolSet>, instructions: string, warnings: string[], close: () => Promise<void>): BuiltAgent {
  return {
    instructions,
    warnings,
    close,
    streamUI: /* 從 buildConsultant 搬過來的 streamUI 實作（含 data-warning 注入），改用參數 agent 與 warnings */,
  };
}
```

3. `buildConsultant` 最後回傳 BuiltAgent 的地方改成（若該處被 try/catch 包住以便失敗時關閉 MCP，保留那個結構，只換掉回傳值）：

```ts
  return wrapAgent(agent, instructions, mcp.warnings, mcp.close);
```

4. 檔案最後新增：

```ts
export type ManagerContext = {
  db: Db;
  model: LanguageModel;
  config: Pick<Config, 'PROJECT_ID' | 'SHARED_ROOT'>;
  manager: AgentInstance;
  consultants: AgentInstance[];
  sharedFiles: string[];
  runner: ConsultantRunner;
  record: RecordSpeech;
  onStepEnd?: (step: StepLike) => Promise<void> | void;
};

export async function buildManager(ctx: ManagerContext): Promise<BuiltAgent> {
  const memories = await loadMemories(ctx.db, ctx.config.PROJECT_ID, ctx.manager.id);
  const instructions = buildManagerInstructions({
    consultants: ctx.consultants,
    memories,
    sharedRoot: ctx.config.SHARED_ROOT,
    sharedFiles: ctx.sharedFiles,
  });
  const tools: ToolSet = {
    read_file: readFileTool(ctx.config.SHARED_ROOT),
    ...memoryTools(ctx.db, ctx.config.PROJECT_ID, ctx.manager.id),
    assign_task: assignTaskTool({ consultants: ctx.consultants, run: ctx.runner, record: ctx.record }),
    convene_discussion: conveneDiscussionTool({ consultants: ctx.consultants, run: ctx.runner, record: ctx.record }),
  };
  const agent = new ToolLoopAgent({
    model: ctx.model,
    instructions,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxRetries: 3,
    onStepEnd: ctx.onStepEnd,
  });
  return wrapAgent(agent, instructions, [], async () => {});
}
```

如果 `ToolLoopAgent<never, ToolSet>` 的泛型參數順序與實際型別不符，typecheck 會報錯：改用 `InstanceType<typeof ToolLoopAgent>` 或把 `wrapAgent` 的第一個參數型別寫成 `{ stream: (o: { messages: ModelMessage[]; abortSignal?: AbortSignal }) => Promise<{ toUIMessageStream: (o: { generateMessageId: () => string; onError: (e: unknown) => string }) => ReadableStream<UIMessageChunk> }> }`，不要用 `any`。

- [ ] **Step 5: 確認測試通過**

```bash
pnpm -F @agenthub/runtime test test/build.test.ts
pnpm -F @agenthub/runtime typecheck
```

Expected: 6 個測試 PASS（原本 4 個 + 新增 2 個）；typecheck 沒有錯誤。

- [ ] **Step 6: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 主管 prompt 與組裝"
```

---

### Task 7: run 流程接上主管（派工、討論整合測試）

**Files:**
- Modify: `packages/runtime/src/run.ts`
- Test: `packages/runtime/test/server.test.ts`（新增測試）

**Interfaces:**
- Consumes: `createConsultantRunner`、`RecordSpeech`（Task 3）、`buildManager`（Task 6）、`textOf`、`toolEvents`（Task 2）、計畫 1 的 run 流程
- Produces: `prepareRootAgent` 在 2 位以上顧問時以主管為根 agent；派工與討論的發言寫入 `messages`（`speaker_instance_id` 為顧問 id，`kind` 為 `'delegation'`／`'discussion'`，討論帶 `round`）；缺主管資料列時錯誤訊息為 `找不到主管`

- [ ] **Step 1: 寫整合測試**

在 `packages/runtime/test/server.test.ts`：

1. helpers import 加上 `seedManager`。
2. 在檔案最後加入：

```ts
describe('POST /chat：多顧問', () => {
  async function seedTeam() {
    const env = await seedEnv({ name: '法務顧問', description: '契約' });
    const engId = await seedConsultant(db, env.projectId, { name: '工程顧問', description: '系統架構' });
    const managerId = await seedManager(db, env.projectId);
    return { ...env, legalId: env.consultantId, engId, managerId };
  }

  it('派工：顧問發言即時串流、寫入 delegation，主管拿到結果後回覆', async () => {
    const env = await seedTeam();
    const model = mockModel(
      toolTurn('assign_task', { consultant_id: env.legalId, task: '審查合約第 5 條' }),
      textTurn('法務意見：第 5 條有違約金風險'),
      textTurn('總結：第 5 條要修改'),
    );
    const res = await post(app(env, model), { thread_id: env.threadId, text: '幫我看合約' });
    expect(await res.text()).toContain('法務意見：第 5 條有違約金風險');

    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');
    const msgs = await messagesOf(env.threadId);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'delegation', 'final']);
    expect(msgs[1]).toMatchObject({ speaker_instance_id: env.legalId, content: '法務意見：第 5 條有違約金風險', round: null });
    expect(msgs[2]).toMatchObject({ speaker_instance_id: env.managerId, content: '總結：第 5 條要修改' });
    expect(promptText(model, 2)).toContain('法務意見：第 5 條有違約金風險');

    const usageRows = await waitFor(async () => {
      const { data } = await db.from('usage_events').select('instance_id').eq('run_id', run.id);
      return data && data.length >= 3 ? data : undefined;
    });
    expect(new Set(usageRows.map((r) => r.instance_id))).toEqual(new Set([env.managerId, env.legalId]));
  });

  it('討論：第 1 輪平行、第 2 輪全部同意後結束，主管拿到完整紀錄', async () => {
    const env = await seedTeam();
    const model = mockModel(
      toolTurn('convene_discussion', { topic: '要不要本週上線', participant_ids: [env.legalId, env.engId], max_rounds: 3 }),
      textTurn('第一輪意見'),
      textTurn('第一輪意見'),
      textTurn('法務：可以上線\n立場：同意'),
      textTurn('工程：可以上線\n立場：同意'),
      textTurn('## 各面向建議\n...\n## 共識方案\n本週上線\n## 仍有分歧\n無'),
    );
    const res = await post(app(env, model), { thread_id: env.threadId, text: '要不要本週上線？' });
    expect(await res.text()).toContain('工程：可以上線');

    const run = await waitForRunDone(db, env.threadId);
    expect(run.status).toBe('succeeded');
    const msgs = await messagesOf(env.threadId);
    const discussion = msgs.filter((m) => m.kind === 'discussion');
    expect(discussion.map((m) => m.round).sort()).toEqual([1, 1, 2, 2]);
    expect(discussion.filter((m) => m.round === 2).map((m) => m.speaker_instance_id)).toEqual([env.legalId, env.engId]);
    expect(msgs.at(-1)).toMatchObject({ kind: 'final', speaker_instance_id: env.managerId });
    expect(msgs.at(-1).content).toContain('## 仍有分歧');
    const managerSecondPrompt = promptText(model, 5);
    expect(managerSecondPrompt).toContain('法務：可以上線');
    expect(managerSecondPrompt).toContain('【第 2 輪｜工程顧問】');
  });

  it('2 位顧問但沒有主管資料列：回 500「找不到主管」', async () => {
    const env = await seedEnv();
    await seedConsultant(db, env.projectId, { name: '第二位' });
    const res = await post(app(env, mockModel()), { thread_id: env.threadId, text: '問題' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '找不到主管' });
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
pnpm -F @agenthub/runtime test test/server.test.ts
```

Expected: 新增的 3 個測試 FAIL（錯誤訊息 `多顧問模式尚未實作`）；原本的測試仍 PASS。

- [ ] **Step 3: 修改 run 流程**

`packages/runtime/src/run.ts`：

1. import 區加入：

```ts
import { buildConsultant, buildManager, type BuiltAgent } from './agents/build';
import { createConsultantRunner, type RecordSpeech } from './consultant';
```

（取代原本的 `import { buildConsultant, type BuiltAgent } from './agents/build';`。）

2. `prepareRootAgent` 改成接收 `threadId`，整個函式換成：

```ts
async function prepareRootAgent(deps: RunDeps, runId: string, threadId: string): Promise<PreparedRoot> {
  const { db, config, model } = deps;
  const instances = await loadInstances(db, config.PROJECT_ID);
  const consultants = instances.filter((i) => i.role === 'consultant');
  if (consultants.length === 0) throw new Error('專案裡還沒有任何顧問');

  const sharedFiles = await syncSharedFiles(db, config.PROJECT_ID, config.SHARED_ROOT);
  for (const i of consultants) await syncSkills(db, config.AGENTS_ROOT, i);
  const secrets = await loadSecrets(db, config.PROJECT_ID);

  if (consultants.length === 1) {
    const root = consultants[0];
    const built = await buildConsultant({
      db, model, config, instance: root, sharedFiles,
      secrets: groupSecrets(secrets, root.id),
      onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: root }),
    });
    return { rootId: root.id, streamUI: built.streamUI, close: built.close };
  }

  const manager = instances.find((i) => i.role === 'manager');
  if (!manager) throw new Error('找不到主管');

  const record: RecordSpeech = async (instance, message, round) => {
    await insertMessage(db, {
      thread_id: threadId,
      run_id: runId,
      speaker_instance_id: instance.id,
      kind: round === null ? 'delegation' : 'discussion',
      round,
      content: textOf(message),
      tool_events: toolEvents(message),
    });
  };
  const built = await buildManager({
    db, model, config, manager, consultants, sharedFiles, record,
    runner: createConsultantRunner({ db, model, config, runId, sharedFiles, secrets }),
    onStepEnd: usageRecorder({ db, projectId: config.PROJECT_ID, runId, instance: manager }),
  });
  return { rootId: manager.id, streamUI: built.streamUI, close: built.close };
}
```

3. `startRun` 裡呼叫處改成 `const root = await prepareRootAgent(deps, runId, req.threadId);`。

- [ ] **Step 4: 確認全部測試通過**

```bash
pnpm -F @agenthub/runtime test
pnpm -F @agenthub/runtime typecheck
supabase test db --linked
```

Expected: 所有 Vitest 測試檔 PASS（`server.test.ts` 共 15 個）；typecheck 沒有錯誤；pgTAP 全部 ok。

- [ ] **Step 5: 用真的 Gemini 跑一次多顧問對話**

用一次性的 tsx 腳本（跑完刪除，不 commit）在雲端 Supabase 建一個 `@test.local` 使用者、兩個範本（例：「法務顧問」描述「契約與法遵」、「財務顧問」描述「財報與估值」，各寫一段 system prompt）、一個專案，用 `hire_agent` 依序啟用兩個範本（會自動建立主管），再建一個對話。然後啟動 runtime：

```bash
cd packages/runtime
PROJECT_ID=<project id> AGENTS_ROOT=/tmp/agenthub/agents SHARED_ROOT=/tmp/agenthub/shared \
  node --env-file=../../.env --import tsx src/main.ts
```

另一個終端機：

```bash
curl -N -X POST http://localhost:8080/chat -H 'content-type: application/json' \
  -d '{"thread_id":"<thread id>","text":"我們想把客戶資料拿去訓練模型，請法務和財務一起討論可行性，最後給我總結。"}'
```

Expected: 串流中看得到 `convene_discussion` 的工具快照（兩位顧問的發言），最後主管的回覆包含 `## 各面向建議`、`## 共識方案`、`## 仍有分歧`；`messages` 有 `discussion` 資料列。若主管沒有召開討論，調整 `buildManagerInstructions` 的分工說明後重試，並把修改與原因寫進報告。確認完刪掉測試使用者。

- [ ] **Step 6: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): 多顧問時由主管派工與召開討論"
```

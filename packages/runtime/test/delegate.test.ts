import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { ConsultantRunner, RecordSpeech } from '../src/consultant';
import { assignTaskTool, type DelegationOutput } from '../src/tools/delegate';
import type { AgentInstance } from '../src/types';
import { textOf } from '../src/ui-stream';
import { ConsultantStoppedError } from '../src/errors';
import { TIME_UP } from '../src/run-clock';

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

const withTool = (text: string, state: string): UIMessage => ({
  id: 'm',
  role: 'assistant',
  parts: [
    { type: 'step-start' },
    { type: 'tool-write_file', toolCallId: 'c1', state, input: { path: 'a.md', content: 'x'.repeat(1000) }, output: { ok: true } },
    { type: 'text', text },
  ],
} as unknown as UIMessage);

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

  it('顧問 id 不存在：回傳錯誤而不是崩潰', async () => {
    const run: ConsultantRunner = async function* () {
      yield msg('不該被呼叫');
    };
    const t = assignTaskTool({ consultants: [legal], run, record: async () => {}, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'nope', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    expect(outputs).toEqual([{ consultant_id: 'nope', name: 'nope', status: 'failed', error: '找不到這位顧問' }]);
  });

  it('快照只帶文字部分與工具摘要；記錄收到完整訊息', async () => {
    const run: ConsultantRunner = async function* () {
      yield withTool('', 'input-available');
      yield withTool('完成', 'output-available');
    };
    const recorded: UIMessage[] = [];
    const t = assignTaskTool({ consultants: [legal], run, record: async (_i, m) => { recorded.push(m); }, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);

    for (const o of outputs) {
      expect(o.message!.parts.every((p) => p.type === 'text')).toBe(true);
      expect(Array.isArray(o.tools)).toBe(true);
    }
    expect(outputs.at(-1)).toMatchObject({
      status: 'done',
      message: { id: 'm', role: 'assistant', parts: [{ type: 'text', text: '完成' }] },
      tools: [{ tool: 'write_file', state: 'output-available' }],
    });
    expect(outputs.find((o) => o.status === 'working')!.tools).toEqual([{ tool: 'write_file', state: 'input-available' }]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].parts.some((p) => p.type === 'tool-write_file')).toBe(true);
  });

  it('文字與工具都沒變的快照不重複送出', async () => {
    const run: ConsultantRunner = async function* () {
      yield msg('A');
      yield msg('A');
      yield msg('A');
      yield msg('AB');
      yield msg('AB');
    };
    const t = assignTaskTool({ consultants: [legal], run, record: async () => {}, intervalMs: 0 });
    const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
    expect(outputs.map((o) => [o.status, o.message?.parts.map((p) => (p as { text: string }).text).join('')])).toEqual([
      ['working', 'A'], ['working', 'AB'], ['done', 'AB'],
    ]);
  });

  it('記錄發言失敗：仍算完成，結果照常交給主管', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const run: ConsultantRunner = async function* () {
        yield msg('結論');
      };
      const t = assignTaskTool({
        consultants: [legal], run, intervalMs: 0,
        record: async () => { throw new Error('DB 斷線'); },
      });
      const outputs = await drain(t.execute!({ consultant_id: 'c-legal', task: 'x' }, opts) as AsyncIterable<DelegationOutput>);
      const last = outputs.at(-1)!;
      expect(last).toMatchObject({ status: 'done' });
      expect(last.error).toBeUndefined();
      expect(t.toModelOutput!({ toolCallId: 't', input: { consultant_id: 'c-legal', task: 'x' }, output: last }))
        .toEqual({ type: 'text', value: '結論' });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

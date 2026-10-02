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

import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
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

async function allStates(it: AsyncIterable<DiscussionState>): Promise<DiscussionState[]> {
  const out: DiscussionState[] = [];
  for await (const s of it) out.push(s);
  return out;
}

const withTool = (text: string): UIMessage => ({
  id: 'm',
  role: 'assistant',
  parts: [
    { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: { command: 'ls' }, output: { stdout: 'x'.repeat(1000) } },
    { type: 'text', text },
  ],
} as unknown as UIMessage);

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

describe('runDiscussion：快照內容', () => {
  it('發言快照不帶 message，只帶工具摘要；記錄收到完整訊息', async () => {
    const recorded: UIMessage[] = [];
    const run: ConsultantRunner = async function* (instance) {
      yield withTool(`${instance.name}意見`);
    };
    const states = await allStates(runDiscussion({
      topic: 't', participants: [legal, eng], maxRounds: 1, run,
      record: async (_i, m) => { recorded.push(m); },
    }));
    for (const state of states) {
      for (const s of state.speeches) {
        expect(s).not.toHaveProperty('message');
        expect(Array.isArray(s.tools)).toBe(true);
      }
    }
    expect(states.at(-1)!.speeches.map((s) => s.tools)).toEqual([
      [{ tool: 'bash', state: 'output-available' }], [{ tool: 'bash', state: 'output-available' }],
    ]);
    expect(recorded).toHaveLength(2);
    expect(recorded.every((m) => m.parts.some((p) => p.type === 'tool-bash'))).toBe(true);
  });

  it('發言內容沒變就不產生新快照', async () => {
    const run: ConsultantRunner = async function* () {
      for (let i = 0; i < 4; i++) {
        yield msg('同樣的內容');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const states = await allStates(runDiscussion({ topic: 't', participants: [legal], maxRounds: 1, run, record: noRecord }));
    const speaking = states.filter((st) => st.speeches[0]?.status === 'speaking' && st.speeches[0].text === '同樣的內容');
    expect(speaking).toHaveLength(1);
  });

  it('記錄發言失敗：發言仍算成功，討論照常進行', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { run } = scriptedRunner({ 'c-legal': ['L1', 'L2\n立場：同意'], 'c-eng': ['E1', 'E2\n立場：同意'] });
      const state = await finalState(runDiscussion({
        topic: 't', participants: [legal, eng], maxRounds: 3, run,
        record: async () => { throw new Error('DB 斷線'); },
      }));
      expect(state.error).toBeUndefined();
      expect(state.speeches.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
      expect(state.speeches[3].stance).toBe('agree');
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('第 1 輪後已中止：不再請下一輪的人發言', async () => {
    const ac = new AbortController();
    const { run, calls } = scriptedRunner({ 'c-legal': ['L1', 'L2'], 'c-eng': ['E1', 'E2'] });
    const aborting: ConsultantRunner = async function* (instance, task, signal) {
      yield* run(instance, task, signal);
      ac.abort();
    };
    const state = await finalState(runDiscussion({
      topic: 't', participants: [legal, eng], maxRounds: 3, run: aborting, record: noRecord, abortSignal: ac.signal,
    }));
    expect(calls).toHaveLength(2);
    expect(state).toMatchObject({ finished: true, round: 1, error: '討論已中止' });
    expect(state.speeches).toHaveLength(2);
  });

  it('第 2 輪中途中止：後面的人不再發言', async () => {
    const ac = new AbortController();
    const { run, calls } = scriptedRunner({ 'c-legal': ['L1', 'L2'], 'c-eng': ['E1', 'E2'] });
    const aborting: ConsultantRunner = async function* (instance, task, signal) {
      yield* run(instance, task, signal);
      if (task.includes('第 2 輪')) ac.abort();
    };
    const state = await finalState(runDiscussion({
      topic: 't', participants: [legal, eng], maxRounds: 3, run: aborting, record: noRecord, abortSignal: ac.signal,
    }));
    expect(calls.map((c) => c.id)).toEqual(['c-legal', 'c-eng', 'c-legal']);
    expect(state).toMatchObject({ finished: true, round: 2, error: '討論已中止' });
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

  it('限制發言長度：第 1 輪 300 字，第 2 輪起 200 字', () => {
    const r1 = roundPrompt('題目A', 1, '');
    expect(r1).toContain('300 字');
    expect(r1).not.toContain('200 字');
    for (const round of [2, 3]) {
      const p = roundPrompt('題目A', round, 'T');
      expect(p).toContain('200 字');
      expect(p).not.toContain('300 字');
      expect(p).toContain('立場：有保留');
    }
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
    const out = (await t.toModelOutput!({ toolCallId: 't', input: { topic: '題目', participant_ids: ['c-legal', 'c-eng'], max_rounds: 3 }, output: last })) as { type: string; value: string };
    expect(out.type).toBe('text');
    expect(out.value).toContain('【第 2 輪｜工程】');
    expect(out.value).toContain('E2');
  });

  it('重複的 participant_ids 合併後不足兩人：直接回報失敗，不請任何人發言', async () => {
    const { run, calls } = scriptedRunner({ 'c-legal': ['L1'], 'c-eng': ['E1'] });
    const t = conveneDiscussionTool({ consultants: [legal, eng], run, record: noRecord, intervalMs: 0 });
    const outputs = await allStates(
      t.execute!({ topic: '題目', participant_ids: ['c-legal', 'c-legal'], max_rounds: 3 }, opts) as AsyncIterable<DiscussionState>,
    );
    expect(outputs).toEqual([{ topic: '題目', round: 0, finished: true, error: '討論至少需要兩位不同的顧問', speeches: [] }]);
    expect(calls).toEqual([]);
  });

  it('預設每 1000ms 最多一份快照', async () => {
    const run: ConsultantRunner = async function* () {
      for (let i = 1; i <= 8; i++) {
        yield msg('字'.repeat(i));
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const t = conveneDiscussionTool({ consultants: [legal, eng], run, record: noRecord });
    const outputs = await allStates(
      t.execute!({ topic: '題目', participant_ids: ['c-legal', 'c-eng'], max_rounds: 1 }, opts) as AsyncIterable<DiscussionState>,
    );
    expect(outputs).toHaveLength(2);
    expect(outputs.at(-1)!.finished).toBe(true);
  });
});

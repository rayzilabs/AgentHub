import { tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { errorText } from '../errors';
import { DISCUSSION_SNAPSHOT_INTERVAL_MS, throttle } from '../throttle';
import type { AgentInstance } from '../types';
import { textOf, toolEvents, type ToolEvent } from '../ui-stream';

export const MAX_ROUNDS = 3;

export type Stance = 'agree' | 'reserve';

export type Speech = {
  consultant_id: string;
  name: string;
  round: number;
  status: 'speaking' | 'done' | 'failed';
  text: string;
  stance?: Stance;
  /** 顧問用過的工具摘要；完整訊息只交給 record，不放進快照 */
  tools?: ToolEvent[];
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

const TOOLS_FIRST = '需要數據或計算結果時，先用你的工具取得再發言，不要憑印象，也不要假設你的工具沒有提供的條件。';

export function roundPrompt(topic: string, round: number, transcript: string): string {
  if (round === 1) {
    return [
      '你正在參加一場專案討論。',
      `題目：${topic}`,
      '',
      '請從你的專業角度提出獨立意見，最多 300 字，用 3–5 個條列重點（重點、風險、建議）。不要冗長開場，不要標題。',
      TOOLS_FIRST,
    ].join('\n');
  }
  return [
    `你正在參加一場專案討論（第 ${round} 輪）。`,
    `題目：${topic}`,
    '',
    '目前的討論紀錄：',
    transcript,
    '',
    '請回應其他人的意見，最多 200 字，只談同意的地方、反對的地方與需要修正之處。',
    TOOLS_FIRST,
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
    const speech: Speech = { consultant_id: instance.id, name: instance.name, round, status: 'speaking', text: '', tools: [] };
    state.speeches.push(speech);
    feed.mark();
    let message: UIMessage | undefined;
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
    } catch (e) {
      speech.status = 'failed';
      speech.error = errorText(e);
    }
    try {
      // 記錄失敗不影響這次發言的結果
      if (speech.status === 'done' && message) await record(instance, message, round);
    } catch (e) {
      console.error(`記錄 ${instance.name} 第 ${round} 輪發言失敗：${errorText(e)}`);
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

  const stopIfAborted = () => {
    if (!opts.abortSignal?.aborted) return false;
    state.error ??= '討論已中止';
    return true;
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (stopIfAborted()) break;
    state.round = round;
    if (round === 1) {
      const prompt = roundPrompt(opts.topic, 1, '');
      yield* speakConcurrently(
        opts.participants.map((instance) => ({ instance, prompt })),
        1, state, opts.run, opts.record, opts.abortSignal,
      );
    } else {
      for (const instance of opts.participants) {
        if (stopIfAborted()) break;
        const prompt = roundPrompt(opts.topic, round, formatTranscript(state));
        yield* speakConcurrently([{ instance, prompt }], round, state, opts.run, opts.record, opts.abortSignal);
      }
      if (state.error) break;
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
      if (participants.length < 2) {
        yield { topic, round: 0, finished: true, error: '討論至少需要兩位不同的顧問', speeches: [] };
        return;
      }
      yield* throttle(
        runDiscussion({ topic, participants, maxRounds: max_rounds, run: opts.run, record: opts.record, abortSignal }),
        opts.intervalMs ?? DISCUSSION_SNAPSHOT_INTERVAL_MS,
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

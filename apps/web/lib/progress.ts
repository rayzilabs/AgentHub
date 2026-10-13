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

/** 被中止的步驟：上層（派工、發言、整則回覆）已結束，這一步卻沒有結果 */
export const INTERRUPTED = 'interrupted';

export function elapsedOf(step: ToolEvent, now: number): number | undefined {
  if (!step.started_at || step.state === INTERRUPTED) return undefined;
  const end = step.ended_at ? Date.parse(step.ended_at) : now;
  return end - Date.parse(step.started_at);
}

/** 上層已結束時，還停在執行中的步驟其實是被中止了（串流中止時工具拿不到結果），改成中斷、不再計時 */
export function settleStep(step: ToolEvent, ended: boolean): ToolEvent {
  return ended && isRunningState(step.state) ? { ...step, state: INTERRUPTED } : step;
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

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

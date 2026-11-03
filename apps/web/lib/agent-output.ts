import type { UIMessage } from 'ai';

/** 與 packages/runtime/src/ui-stream.ts 的 ToolEvent 相同，改形狀時兩邊一起改 */
export type ToolEvent = { tool: string; state: string; description?: string; started_at?: string; ended_at?: string };

/** UIMessage.metadata.tool_times：每次工具呼叫的開始與結束時間 */
export type ToolTimes = Record<string, { started_at: string; ended_at?: string }>;

/** 時間預算：wrap-up = 過了收尾時間才完成；stopped = 逾時被強制停止 */
export type Cutoff = 'wrap-up' | 'stopped';

/** 與 packages/runtime/src/ui-stream.ts 的 DeliveredFile 相同；folder 是從根算起的完整路徑 */
export type DeliveredFile = { file_id: string; name: string; folder: string; size: number };

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  message?: UIMessage; // 只含文字片段
  tools?: ToolEvent[];
  warnings?: string[]; // 顧問的提醒（套件安裝失敗、MCP 無法使用）
  error?: string;
  cutoff?: Cutoff;
  files?: DeliveredFile[];
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
  files?: DeliveredFile[];
};

export type DiscussionState = { topic: string; round: number; finished: boolean; error?: string; speeches: Speech[] };

/** 這則訊息裡派工與討論交付的所有檔案，依 file_id 去重、保留出現順序 */
export function filesInMessage(m: UIMessage): DeliveredFile[] {
  const seen = new Map<string, DeliveredFile>();
  const add = (files?: DeliveredFile[]) => {
    for (const f of files ?? []) if (!seen.has(f.file_id)) seen.set(f.file_id, f);
  };
  for (const part of m.parts) {
    const p = part as { type: string; output?: unknown };
    if (p.type === 'tool-assign_task') add((p.output as DelegationOutput | undefined)?.files);
    else if (p.type === 'tool-convene_discussion') {
      for (const s of (p.output as DiscussionState | undefined)?.speeches ?? []) add(s.files);
    }
  }
  return [...seen.values()];
}

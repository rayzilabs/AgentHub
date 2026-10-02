import type { UIMessage } from 'ai';

export type ToolEvent = { tool: string; state: string };

export type DelegationOutput = {
  consultant_id: string;
  name: string;
  status: 'working' | 'done' | 'failed';
  message?: UIMessage; // 只含文字片段
  tools?: ToolEvent[];
  error?: string;
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
};

export type DiscussionState = { topic: string; round: number; finished: boolean; error?: string; speeches: Speech[] };

import { mkdir } from 'node:fs/promises';
import {
  generateId, stepCountIs, ToolLoopAgent,
  type LanguageModel, type ModelMessage, type ToolSet, type UIMessageChunk,
} from 'ai';
import type { Config } from '../config';
import type { Db } from '../db';
import { errorText } from '../errors';
import { connectMcpServers } from '../mcp';
import { withToolTimes } from '../tool-clock';
import { agentDir, skillsDir } from '../sync';
import { createSandbox } from '../sandbox';
import { bashTool } from '../tools/bash';
import { readFileTool, writeFileTool } from '../tools/files';
import { loadMemories, memoryTools } from '../tools/memory';
import type { RunClock } from '../run-clock';
import type { AgentInstance } from '../types';
import type { StepLike } from '../usage';
import type { ConsultantRunner, RecordSpeech } from '../consultant';
import { assignTaskTool } from '../tools/delegate';
import { conveneDiscussionTool } from '../tools/discuss';
import { buildConsultantInstructions, buildManagerInstructions } from './prompts';

export const MAX_STEPS = 30;

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
  const wrapped = `${instructions}

## 時間到
${note}`;
  return () => (Date.now() >= at ? { toolChoice: 'none' as const, instructions: wrapped } : {});
}

export type ConsultantContext = {
  db: Db;
  model: LanguageModel;
  config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>;
  instance: AgentInstance;
  sharedFiles: string[];
  secrets: Record<string, Record<string, string>>;
  onStepEnd?: (step: StepLike) => Promise<void> | void;
  /** 過了這個時間就收尾（不准再用工具） */
  wrapUpAt?: number;
};

export type BuiltAgent = {
  instructions: string;
  warnings: string[];
  streamUI(input: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<ReadableStream<UIMessageChunk>>;
  close(): Promise<void>;
};

/**
 * 把 MCP 啟動警告放進 UI 串流（data-warning），前端與存下來的 ui_message 都看得到。
 * 警告緊接在 start 之後送出；不用 createUIMessageStream 的 merge，因為它不會把取消往上游傳，
 * run 逾時收尾時 agent 串流就停不下來。
 */
function withWarnings(stream: ReadableStream<UIMessageChunk>, warnings: string[]): ReadableStream<UIMessageChunk> {
  if (warnings.length === 0) return stream;
  let sent = false;
  const sendWarnings = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    if (sent) return;
    sent = true;
    for (const text of warnings) controller.enqueue({ type: 'data-warning', data: { text } });
  };
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start') {
          controller.enqueue(chunk);
          sendWarnings(controller);
        } else {
          sendWarnings(controller);
          controller.enqueue(chunk);
        }
      },
      flush: sendWarnings,
    }),
  );
}

type StreamableAgent = {
  stream(o: { messages: ModelMessage[]; abortSignal?: AbortSignal }): PromiseLike<{
    toUIMessageStream(o: { generateMessageId: () => string; onError: (e: unknown) => string }): ReadableStream<UIMessageChunk>;
  }>;
};

function wrapAgent(agent: StreamableAgent, instructions: string, warnings: string[], close: () => Promise<void>): BuiltAgent {
  return {
    instructions,
    warnings,
    close,
    streamUI: async ({ messages, abortSignal }) => {
      const result = await agent.stream({ messages, abortSignal });
      const ui = result.toUIMessageStream({ generateMessageId: generateId, onError: errorText });
      return withWarnings(withToolTimes(ui), warnings);
    },
  };
}

export async function buildConsultant(ctx: ConsultantContext): Promise<BuiltAgent> {
  const workDir = agentDir(ctx.config.AGENTS_ROOT, ctx.instance.id);
  await mkdir(workDir, { recursive: true });

  const mcp = await connectMcpServers(ctx.instance.mcp_servers, ctx.secrets, workDir);
  try {
    const memories = await loadMemories(ctx.db, ctx.config.PROJECT_ID, ctx.instance.id);
    const instructions = buildConsultantInstructions({
      instance: ctx.instance,
      workDir,
      skillsDir: skillsDir(ctx.config.AGENTS_ROOT, ctx.instance.id),
      sharedRoot: ctx.config.SHARED_ROOT,
      sharedFiles: ctx.sharedFiles,
      memories,
      mcpWarnings: mcp.warnings,
    });

    const tools: ToolSet = {
      bash: bashTool(workDir, createSandbox()),
      read_file: readFileTool(workDir),
      write_file: writeFileTool(workDir),
      ...memoryTools(ctx.db, ctx.config.PROJECT_ID, ctx.instance.id),
      ...mcp.tools,
    };

    const agent = new ToolLoopAgent({
      model: ctx.model,
      instructions,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      maxRetries: 3,
      onStepEnd: ctx.onStepEnd,
      prepareStep: wrapUpStep(ctx.wrapUpAt, instructions, CONSULTANT_WRAP_UP),
    });

    return wrapAgent(agent, instructions, mcp.warnings, mcp.close);
  } catch (e) {
    // 組裝失敗時 MCP 連線（含 stdio 子行程）沒有人會關，先關掉再往上丟
    await mcp.close();
    throw e;
  }
}

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
  clock?: Pick<RunClock, 'consultantWrapUpAt' | 'consultantStopAt'>;
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
    assign_task: assignTaskTool({
      consultants: ctx.consultants, run: ctx.runner, record: ctx.record, acceptUntil: ctx.clock?.consultantWrapUpAt,
    }),
    convene_discussion: conveneDiscussionTool({
      consultants: ctx.consultants, run: ctx.runner, record: ctx.record, acceptUntil: ctx.clock?.consultantWrapUpAt,
    }),
  };
  const agent = new ToolLoopAgent({
    model: ctx.model,
    instructions,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxRetries: 3,
    onStepEnd: ctx.onStepEnd,
    prepareStep: wrapUpStep(ctx.clock?.consultantStopAt, instructions, MANAGER_WRAP_UP),
  });
  return wrapAgent(agent, instructions, [], async () => {});
}

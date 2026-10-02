import { mkdir } from 'node:fs/promises';
import {
  generateId, stepCountIs, ToolLoopAgent,
  type LanguageModel, type ModelMessage, type ToolSet, type UIMessageChunk,
} from 'ai';
import type { Config } from '../config';
import type { Db } from '../db';
import { errorText } from '../errors';
import { connectMcpServers } from '../mcp';
import { agentDir, skillsDir } from '../sync';
import { bashTool } from '../tools/bash';
import { readFileTool, writeFileTool } from '../tools/files';
import { loadMemories, memoryTools } from '../tools/memory';
import type { AgentInstance } from '../types';
import type { StepLike } from '../usage';
import { buildConsultantInstructions } from './prompts';

export const MAX_STEPS = 30;

export type ConsultantContext = {
  db: Db;
  model: LanguageModel;
  config: Pick<Config, 'PROJECT_ID' | 'AGENTS_ROOT' | 'SHARED_ROOT'>;
  instance: AgentInstance;
  sharedFiles: string[];
  secrets: Record<string, Record<string, string>>;
  onStepEnd?: (step: StepLike) => Promise<void> | void;
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

export async function buildConsultant(ctx: ConsultantContext): Promise<BuiltAgent> {
  const workDir = agentDir(ctx.config.AGENTS_ROOT, ctx.instance.id);
  await mkdir(workDir, { recursive: true });

  const mcp = await connectMcpServers(ctx.instance.mcp_servers, ctx.secrets, workDir);
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
    bash: bashTool(workDir),
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
  });

  return {
    instructions,
    warnings: mcp.warnings,
    close: mcp.close,
    streamUI: async ({ messages, abortSignal }) => {
      const result = await agent.stream({ messages, abortSignal });
      return withWarnings(result.toUIMessageStream({ generateMessageId: generateId, onError: errorText }), mcp.warnings);
    },
  };
}

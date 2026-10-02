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
      return result.toUIMessageStream({ generateMessageId: generateId, onError: errorText });
    },
  };
}

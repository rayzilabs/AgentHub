import type { LanguageModelUsage } from 'ai';
import type { Db } from './db';
import type { AgentInstance } from './types';

export type StepLike = { usage: LanguageModelUsage; model: { modelId: string } };

export type UsageContext = { db: Db; projectId: string; runId: string; instance: AgentInstance };

export function usageRow(ctx: UsageContext, step: StepLike) {
  return {
    run_id: ctx.runId,
    project_id: ctx.projectId,
    instance_id: ctx.instance.id,
    template_id: ctx.instance.template_id,
    creator_id: ctx.instance.creator_id,
    model: step.model.modelId,
    prompt_tokens: step.usage.inputTokens ?? 0,
    output_tokens: step.usage.outputTokens ?? 0,
    cached_tokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    thought_tokens: step.usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

export function usageRecorder(ctx: UsageContext): (step: StepLike) => Promise<void> {
  return async (step) => {
    const { error } = await ctx.db.from('usage_events').insert(usageRow(ctx, step));
    if (error) console.error('[usage] 寫入失敗', error.message);
  };
}

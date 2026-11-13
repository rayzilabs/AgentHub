import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { errorText, isQuotaError } from './errors';

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>;
type Model = Parameters<WrapStream>[0]['model'];
type StreamResult = Awaited<ReturnType<WrapStream>>;

/** 串流開頭補上實際回答的模型，step.response.modelId 才記得到（Gemini 的 response-metadata 不帶 modelId） */
function answeredBy(result: StreamResult, modelId: string): StreamResult {
  const stream = result.stream.pipeThrough(new TransformStream({
    start(c) { c.enqueue({ type: 'response-metadata', modelId }); },
  }));
  return { ...result, stream };
}

/**
 * 模型忙線（429／RESOURCE_EXHAUSTED，Google 共用容量塞車）時依序改用備援模型。
 * 只在還沒開始串流前換；串流中途的錯誤和其他錯誤照原樣丟出。全部忙線時丟出最後一個錯誤，
 * 讓 AI SDK 的 maxRetries 退避後再從主模型試。跨模型接手含 thoughtSignature 的歷史已用真的 Vertex 驗證可行。
 */
export function withFallbacks(primary: Model, fallbacks: Model[]): Model {
  const models = [primary, ...fallbacks];
  return wrapLanguageModel({
    model: primary,
    middleware: {
      wrapStream: async ({ doStream, params }) => {
        for (let i = 0; ; i++) {
          try {
            return answeredBy(await (i === 0 ? doStream() : models[i].doStream(params)), models[i].modelId);
          } catch (e) {
            const next = models[i + 1];
            if (!next || !isQuotaError(e)) throw e;
            console.warn(`[model] ${models[i].modelId} → ${next.modelId}：${errorText(e)}`);
          }
        }
      },
    },
  });
}

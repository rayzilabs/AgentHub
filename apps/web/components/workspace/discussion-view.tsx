import { Markdown } from '@/components/markdown';
import { Seal } from '@/components/seal';
import type { DiscussionState, Speech } from '@/lib/agent-output';
import { Collapsible } from './collapsible';
import { ToolList } from './tool-list';

const STANCE_LINE = /\n?\s*立場\s*[:：]\s*(同意|有保留)\s*$/;

function SpeechBlock({ speech, color }: { speech: Speech; color: string }) {
  const body = speech.text.replace(STANCE_LINE, '');
  return (
    <div className="rounded border border-l-4 border-line bg-surface px-4 py-3" style={{ borderLeftColor: color }}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-xl font-bold" style={{ color }}>{speech.name}</span>
        {speech.status === 'speaking' && <span className="chip chip-brand"><span className="dot-busy" aria-hidden />發言中</span>}
        {speech.status === 'done' && speech.stance && <Seal stance={speech.stance} />}
      </div>
      <ToolList tools={speech.tools} />
      {speech.status === 'failed' ? (
        <p className="notice notice-error mt-3">未發言：{speech.error}</p>
      ) : (
        body && (
          <div className="mt-3">
            {speech.status === 'done' ? <Collapsible><Markdown compact text={body} /></Collapsible> : <Markdown compact text={body} />}
          </div>
        )
      )}
    </div>
  );
}

export function DiscussionView({ state, colorOf, failedText }: {
  state?: DiscussionState;
  colorOf: (consultantId: string) => string;
  /** 召集討論的工具失敗時的原因：還沒開始就顯示「討論沒有開始」，進行到一半則顯示「提前結束」 */
  failedText?: string;
}) {
  if (failedText !== undefined && !state) return <p role="status" className="notice notice-error my-4">討論沒有開始：{failedText}</p>;
  if (!state) {
    return (
      <p className="my-4 flex items-center gap-2 text-sm text-muted">
        <span className="dot-busy" aria-hidden />主管正在召集顧問
      </p>
    );
  }
  const rounds = [...new Set(state.speeches.map((s) => s.round))].sort((a, b) => a - b);
  return (
    <section className="my-4 rounded border border-line bg-paper p-3 sm:p-4" aria-label="顧問討論">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-xl">顧問討論</h3>
        <span className={`chip ${state.finished ? '' : 'chip-brand'}`}>
          {state.finished
            ? `已結束，共 ${state.round} 輪`
            : <><span className="dot-busy" aria-hidden />第 {state.round} 輪，最多 3 輪</>}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{state.topic}</p>
      {rounds.map((round) => (
        <div key={round} className="mt-5">
          <h4 className="mb-2 flex items-center gap-3 text-sm font-medium text-muted">
            <span>{round === 1 ? '第 1 輪：各自提出意見' : `第 ${round} 輪：互相回應`}</span>
            <span aria-hidden className="h-px flex-1 bg-line" />
          </h4>
          <div className="space-y-3">
            {state.speeches.filter((s) => s.round === round).map((s) => (
              <SpeechBlock key={`${s.consultant_id}-${s.round}`} speech={s} color={colorOf(s.consultant_id)} />
            ))}
          </div>
        </div>
      ))}
      {state.finished ? (
        state.error
          ? <p className="notice notice-error mt-4">討論提前結束：{state.error}</p>
          : <p className="mt-4 text-sm text-muted">討論結束。主管的總結在下方。</p>
      ) : failedText !== undefined && (
        <p className="notice notice-error mt-4">討論提前結束：{failedText}</p>
      )}
    </section>
  );
}

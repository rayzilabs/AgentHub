import { Markdown } from '@/components/markdown';
import { Seal } from '@/components/seal';
import { Avatar } from '@/components/ui/avatar';
import type { DiscussionState, Speech } from '@/lib/agent-output';
import { Collapsible } from './collapsible';
import { ToolSteps } from './tool-steps';

const STANCE_LINE = /\n?\s*立場\s*[:：]\s*(同意|有保留)\s*$/;

function SpeechBlock({ speech, color, live }: { speech: Speech; color: string; live: boolean }) {
  const body = speech.text.replace(STANCE_LINE, '');
  return (
    <div className="panel px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={speech.name} color={color} />
          <span className="min-w-0 truncate font-semibold">{speech.name}</span>
        </span>
        {speech.status === 'speaking' && <span className="chip chip-brand"><span className="dot-busy" aria-hidden />發言中</span>}
        {speech.cutoff === 'stopped' && <span className="chip chip-seal">逾時</span>}
        {speech.status === 'done' && speech.stance && <Seal stance={speech.stance} />}
      </div>
      <ToolSteps tools={speech.tools} ended={!live || speech.status !== 'speaking'} />
      {speech.status === 'failed' && speech.cutoff !== 'stopped' ? (
        <p className="notice notice-error mt-3">未發言：{speech.error}</p>
      ) : (
        body && (
          <div className="mt-3">
            {speech.status === 'done' ? <Collapsible><Markdown compact text={body} /></Collapsible> : <Markdown compact text={body} />}
          </div>
        )
      )}
      {speech.cutoff === 'stopped' && <p className="notice notice-error mt-3">{speech.error}</p>}
      {speech.cutoff === 'wrap-up' && <p className="notice notice-warn mt-3">時間到，已提前收尾</p>}
    </div>
  );
}

export function DiscussionView({ state, colorOf, failedText, live }: {
  state?: DiscussionState;
  /** 整則回覆還在產生中；結束後還沒有結果的工具是被中止的 */
  live: boolean;
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
    <section className="my-4 rounded-[24px] bg-sunken p-3 sm:p-5" aria-label="顧問討論">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="text-xl font-semibold">顧問討論</h3>
        <span className={`chip ${state.finished ? '' : 'chip-brand'}`}>
          {state.finished
            ? `已結束，共 ${state.round} 輪`
            : <><span className="dot-busy" aria-hidden />第 {state.round} 輪，最多 3 輪</>}
        </span>
      </div>
      <p className="mt-1 px-1 text-sm text-muted">{state.topic}</p>
      {rounds.map((round) => (
        <div key={round} className="mt-5">
          <h4 className="mb-2 flex items-center gap-3 px-1 text-sm font-medium text-muted">
            <span>{round === 1 ? '第 1 輪：各自提出意見' : `第 ${round} 輪：互相回應`}</span>
            <span aria-hidden className="h-px flex-1 bg-line" />
          </h4>
          <div className="space-y-3">
            {state.speeches.filter((s) => s.round === round).map((s) => (
              <SpeechBlock key={`${s.consultant_id}-${s.round}`} speech={s} color={colorOf(s.consultant_id)} live={live} />
            ))}
          </div>
        </div>
      ))}
      {state.finished ? (
        state.error
          ? <p className="notice notice-error mt-4">討論提前結束：{state.error}</p>
          : <p className="mt-4 px-1 text-sm text-muted">討論結束，主管接著整理總結。</p>
      ) : failedText !== undefined && (
        <p className="notice notice-error mt-4">討論提前結束：{failedText}</p>
      )}
    </section>
  );
}

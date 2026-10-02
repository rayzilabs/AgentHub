import { Markdown } from '@/components/markdown';
import { Seal } from '@/components/seal';
import type { DiscussionState, Speech } from '@/lib/agent-output';
import { Collapsible } from './collapsible';
import { ToolList } from './tool-list';

const STANCE_LINE = /\n?\s*立場\s*[:：]\s*(同意|有保留)\s*$/;

function SpeechBlock({ speech, color }: { speech: Speech; color: string }) {
  const body = speech.text.replace(STANCE_LINE, '');
  return (
    <div className="border-l-4 bg-surface py-3 pl-4 pr-3" style={{ borderColor: color }}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-lg" style={{ color }}>{speech.name}</span>
        {speech.status === 'speaking' && <span className="text-xs text-muted">發言中…</span>}
        {speech.status === 'done' && speech.stance && <Seal stance={speech.stance} />}
      </div>
      <ToolList tools={speech.tools} />
      {speech.status === 'failed' ? (
        <p className="mt-2 text-sm text-muted">未發言：{speech.error}</p>
      ) : (
        body && (
          <div className="mt-2">
            {speech.status === 'done' ? <Collapsible><Markdown text={body} /></Collapsible> : <Markdown text={body} />}
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
  if (failedText !== undefined && !state) return <p role="status" className="my-3 text-sm text-muted">討論沒有開始：{failedText}</p>;
  if (!state) return <p className="my-3 text-sm text-muted">主管正在召集顧問…</p>;
  const rounds = [...new Set(state.speeches.map((s) => s.round))].sort((a, b) => a - b);
  return (
    <section className="my-4 rounded border border-line bg-paper p-4" aria-label="顧問討論">
      <h3 className="font-display text-lg">顧問討論</h3>
      <p className="mt-1 text-sm text-muted">{state.topic}</p>
      {rounds.map((round) => (
        <div key={round} className="mt-4">
          <h4 className="mb-2 text-sm font-medium text-muted">
            {round === 1 ? '第 1 輪：各自提出意見' : `第 ${round} 輪：互相回應`}
          </h4>
          <div className="space-y-3">
            {state.speeches.filter((s) => s.round === round).map((s) => (
              <SpeechBlock key={`${s.consultant_id}-${s.round}`} speech={s} color={colorOf(s.consultant_id)} />
            ))}
          </div>
        </div>
      ))}
      {state.finished ? (
        <p className="mt-4 text-sm text-muted">{state.error ? `討論提前結束：${state.error}` : `討論結束，共進行 ${state.round} 輪。`}</p>
      ) : failedText !== undefined && (
        <p className="mt-4 text-sm text-muted">討論提前結束：{failedText}</p>
      )}
    </section>
  );
}

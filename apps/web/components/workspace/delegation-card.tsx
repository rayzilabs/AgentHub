import { Markdown } from '@/components/markdown';
import type { DelegationOutput } from '@/lib/agent-output';
import { textOf } from '@/lib/text';
import { Collapsible } from './collapsible';
import { ToolList } from './tool-list';

export function DelegationCard({ output, task, color, failedText }: { output?: DelegationOutput; task?: string; color: string; failedText?: string }) {
  const name = output?.name ?? '顧問';
  return (
    <div className="my-4 overflow-hidden rounded border border-l-4 border-line bg-surface" style={{ borderLeftColor: color }}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        {/* 粗體 20px 屬於 WCAG 大字（門檻 3:1），所有顧問識別色在白底都過 */}
        <span className="font-display text-xl font-bold" style={{ color }}>{name}</span>
        {failedText !== undefined || output?.status === 'failed'
          ? <span className="chip chip-seal">失敗</span>
          : !output || output.status === 'working'
            ? <span className="chip chip-brand"><span className="dot-busy" aria-hidden />處理中</span>
            : <span className="chip">完成</span>}
      </div>
      <div className="px-4 pb-4">
        {task && (
          <details className="group mt-2 text-sm">
            {/* 收合時顯示兩行預覽，不用點就看得到主管交辦了什麼；展開後預覽消失、全文出現 */}
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              <span className="text-muted">主管交辦</span>
              <span className="mt-0.5 line-clamp-2 text-ink group-open:hidden">{task}</span>
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-ink">{task}</p>
          </details>
        )}
        <ToolList tools={output?.tools} />
        {failedText !== undefined && <p className="notice notice-error mt-3">{failedText}</p>}
        {output?.status === 'failed' && <p className="notice notice-error mt-3">{output.error}</p>}
        {output?.message && (
          <div className="mt-3">
            {output.status === 'done'
              ? <Collapsible><Markdown compact text={textOf(output.message)} /></Collapsible>
              : <Markdown compact text={textOf(output.message)} />}
          </div>
        )}
      </div>
    </div>
  );
}

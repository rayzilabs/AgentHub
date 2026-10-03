import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import type { DelegationOutput } from '@/lib/agent-output';
import { textOf } from '@/lib/text';
import { Collapsible } from './collapsible';
import { ToolList } from './tool-list';

export function DelegationCard({ output, task, color, failedText }: { output?: DelegationOutput; task?: string; color: string; failedText?: string }) {
  const name = output?.name ?? '顧問';
  return (
    <div className="panel my-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={name} color={color} />
          <span className="min-w-0 truncate font-semibold">{name}</span>
        </span>
        {failedText !== undefined || output?.status === 'failed'
          ? <span className="chip chip-seal">失敗</span>
          : !output || output.status === 'working'
            ? <span className="chip chip-brand"><span className="dot-busy" aria-hidden />處理中</span>
            : <span className="chip chip-sage">完成</span>}
      </div>
      <div className="px-5 pb-5">
        {task && (
          <details className="group mt-3 rounded-xl bg-sunken px-3.5 py-2.5 text-sm">
            {/* 收合時顯示兩行預覽，不用點就看得到主管交辦了什麼；展開後預覽消失、全文出現 */}
            <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
              <span className="font-medium text-muted">主管交辦</span>
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

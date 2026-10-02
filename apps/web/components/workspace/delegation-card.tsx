import { Markdown } from '@/components/markdown';
import type { DelegationOutput } from '@/lib/agent-output';
import { textOf } from '@/lib/text';
import { ToolList } from './tool-list';

export function DelegationCard({ output, task, color }: { output?: DelegationOutput; task?: string; color: string }) {
  const name = output?.name ?? '顧問';
  return (
    <div className="my-3 border-l-4 bg-surface py-3 pl-4 pr-3" style={{ borderColor: color }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-lg" style={{ color }}>{name}</span>
        <span className="text-xs text-muted">
          {!output || output.status === 'working' ? '處理中…' : output.status === 'done' ? '完成' : '失敗'}
        </span>
      </div>
      {task && <p className="mt-1 text-sm text-muted">主管交辦：{task}</p>}
      <ToolList tools={output?.tools} />
      {output?.status === 'failed' && <p className="mt-2 text-sm text-seal">{output.error}</p>}
      {output?.message && <div className="mt-2"><Markdown text={textOf(output.message)} /></div>}
    </div>
  );
}

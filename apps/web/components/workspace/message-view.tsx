import type { UIMessage } from 'ai';
import { Markdown } from '@/components/markdown';
import type { DelegationOutput, DiscussionState } from '@/lib/agent-output';
import { DelegationCard } from './delegation-card';
import { DiscussionView } from './discussion-view';
import { TOOL_LABELS } from './tool-list';

type ToolPart = { type: string; toolName?: string; state: string; input?: Record<string, unknown>; output?: unknown; errorText?: string };

export function MessageView({ message, speaker, colorOf }: { message: UIMessage; speaker: string; colorOf: (id: string) => string }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded bg-brand px-4 py-2 text-white">
          {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 font-display text-sm text-muted">{speaker}</div>
      {message.parts.map((part, i) => {
        if (part.type === 'text') return <Markdown key={i} text={part.text} />;
        if (part.type === 'data-warning') {
          return <p key={i} role="status" className="my-1 text-xs text-ochre">{(part as { data: { text: string } }).data.text}</p>;
        }
        if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return null;
        const tool = part as ToolPart;
        const name = tool.type === 'dynamic-tool' ? tool.toolName ?? '工具' : tool.type.slice('tool-'.length);
        if (name === 'assign_task') {
          const output = tool.output as DelegationOutput | undefined;
          const consultantId = output?.consultant_id ?? (tool.input?.consultant_id as string | undefined) ?? '';
          return <DelegationCard key={i} output={output} task={tool.input?.task as string | undefined} color={colorOf(consultantId)}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '顧問沒有完成這項工作' : undefined} />;
        }
        if (name === 'convene_discussion') {
          return <DiscussionView key={i} state={tool.output as DiscussionState | undefined} colorOf={colorOf} />;
        }
        const done = tool.state === 'output-available';
        const failed = tool.state === 'output-error';
        return (
          <p key={i} className="my-1 text-xs text-muted">
            {failed ? '工具失敗' : done ? '用了工具' : '正在使用工具'}：{TOOL_LABELS[name] ?? name}
          </p>
        );
      })}
    </div>
  );
}

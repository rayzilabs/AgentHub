'use client';

import type { UIMessage } from 'ai';
import { motion } from 'motion/react';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import type { DelegationOutput, DiscussionState } from '@/lib/agent-output';
import { DelegationCard } from './delegation-card';
import { DiscussionView } from './discussion-view';
import { TOOL_LABELS } from './tool-list';

type ToolPart = { type: string; toolName?: string; state: string; input?: Record<string, unknown>; output?: unknown; errorText?: string };

export function MessageView({ message, speaker, speakerColor, colorOf, animateIn }: {
  message: UIMessage;
  speaker: string;
  speakerColor: string;
  colorOf: (id: string) => string;
  /** 這次畫面上新出現的訊息才播進場動畫 */
  animateIn: boolean;
}) {
  if (message.role === 'user') {
    // 送出的訊息從右下角的輸入列方向長出來
    return (
      <div className="flex justify-end">
        <motion.div initial={animateIn ? { opacity: 0, y: 16, scale: 0.96 } : false} animate={{ opacity: 1, y: 0, scale: 1 }}
          className="max-w-[85%] origin-bottom-right whitespace-pre-wrap rounded-[20px] rounded-br-md bg-brand px-4 py-2.5 text-white sm:max-w-[70%]">
          {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
        </motion.div>
      </div>
    );
  }
  return (
    <motion.div initial={animateIn ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
      <div className="mb-3 flex items-center gap-2.5">
        <Avatar name={speaker} color={speakerColor} />
        <span className="font-semibold">{speaker}</span>
      </div>
      {message.parts.map((part, i) => {
        if (part.type === 'text') return <Markdown key={i} text={part.text} />;
        if (part.type === 'data-warning') {
          return (
            <p key={i} role="status" className="notice notice-warn my-2">
              <span className="font-medium text-ochre">提醒</span>　{(part as { data: { text: string } }).data.text}
            </p>
          );
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
          return <DiscussionView key={i} state={tool.output as DiscussionState | undefined} colorOf={colorOf}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '主管沒能召集顧問' : undefined} />;
        }
        const done = tool.state === 'output-available';
        const failed = tool.state === 'output-error';
        return (
          <span key={i} className={`chip mb-2 mr-2 ${failed ? 'chip-seal' : ''}`}>
            {!done && !failed && <span className="dot-busy" aria-hidden />}
            {failed ? '工具失敗：' : done ? '用了' : '正在用'}{TOOL_LABELS[name] ?? name}
          </span>
        );
      })}
    </motion.div>
  );
}

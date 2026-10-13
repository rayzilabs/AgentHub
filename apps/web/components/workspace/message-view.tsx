'use client';

import type { UIMessage } from 'ai';
import { motion } from 'motion/react';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import type { DelegationOutput, DiscussionState } from '@/lib/agent-output';
import { DelegationCard } from './delegation-card';
import { DiscussionView } from './discussion-view';
import { isRunningPart, isToolPart, stepOf, toolNameOf, type ToolPartLike } from '@/lib/progress';
import { ToolStep } from './tool-steps';
import { useNow } from './use-now';

export function MessageView({ message, speaker, speakerColor, colorOf, animateIn }: {
  message: UIMessage;
  speaker: string;
  speakerColor: string;
  colorOf: (id: string) => string;
  /** 這次畫面上新出現的訊息才播進場動畫 */
  animateIn: boolean;
}) {
  const now = useNow(message.parts.some((p) => isToolPart(p) && isRunningPart(p as unknown as ToolPartLike)));
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
        if (!isToolPart(part)) return null;
        const tool = part as unknown as ToolPartLike;
        const name = toolNameOf(tool);
        if (name === 'assign_task') {
          const output = tool.output as DelegationOutput | undefined;
          const consultantId = output?.consultant_id ?? (tool.input as { consultant_id?: string } | undefined)?.consultant_id ?? '';
          return <DelegationCard key={i} output={output} task={(tool.input as { task?: string } | undefined)?.task} color={colorOf(consultantId)}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '顧問沒有完成這項工作' : undefined} />;
        }
        if (name === 'convene_discussion') {
          return <DiscussionView key={i} state={tool.output as DiscussionState | undefined} colorOf={colorOf}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '主管沒能召集顧問' : undefined} />;
        }
        return <ul key={i} className="my-2"><ToolStep step={stepOf(tool, message.metadata)} now={now} /></ul>;
      })}
    </motion.div>
  );
}

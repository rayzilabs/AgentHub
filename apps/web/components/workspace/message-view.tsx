'use client';

import type { UIMessage } from 'ai';
import { motion } from 'motion/react';
import { Markdown } from '@/components/markdown';
import { Avatar } from '@/components/ui/avatar';
import { FileCards } from '@/components/files/file-card';
import { filesInMessage, type DelegationOutput, type DeliveredFile, type DiscussionState } from '@/lib/agent-output';
import { DelegationCard } from './delegation-card';
import { DiscussionView } from './discussion-view';
import { isRunningPart, isToolPart, settleStep, stepOf, toolNameOf, type ToolPartLike } from '@/lib/progress';
import { ToolStep } from './tool-steps';
import { useNow } from './use-now';

function UserBubble({ text, animateIn }: { text: string; animateIn: boolean }) {
  // 送出的訊息從右下角的輸入列方向長出來
  return (
    <div className="flex justify-end">
      <motion.div initial={animateIn ? { opacity: 0, y: 16, scale: 0.96 } : false} animate={{ opacity: 1, y: 0, scale: 1 }}
        className="max-w-[85%] origin-bottom-right whitespace-pre-wrap rounded-[20px] rounded-br-md bg-brand px-4 py-2.5 text-white sm:max-w-[70%]">
        {text}
      </motion.div>
    </div>
  );
}

export function MessageView({ message, speaker, speakerColor, colorOf, animateIn, live }: {
  message: UIMessage;
  speaker: string;
  speakerColor: string;
  colorOf: (id: string) => string;
  /** 這次畫面上新出現的訊息才播進場動畫 */
  animateIn: boolean;
  /** 這則回覆還在產生中；結束後還沒有結果的工具是被中止的 */
  live: boolean;
}) {
  const now = useNow(live && message.parts.some((p) => isToolPart(p) && isRunningPart(p as unknown as ToolPartLike)));
  if (message.role === 'user') {
    return <UserBubble text={message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')} animateIn={animateIn} />;
  }
  const delivered = filesInMessage(message);
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
        if (part.type === 'data-interjection') {
          return <div key={i} className="my-4"><UserBubble text={(part as { data: { text: string } }).data.text} animateIn={live} /></div>;
        }
        if (part.type === 'data-interrupted') return <p key={i} role="status" className="mt-3 text-sm text-muted">已由你中斷</p>;
        if (!isToolPart(part)) return null;
        const tool = part as unknown as ToolPartLike;
        const name = toolNameOf(tool);
        if (name === 'assign_task') {
          const output = tool.output as DelegationOutput | undefined;
          const consultantId = output?.consultant_id ?? (tool.input as { consultant_id?: string } | undefined)?.consultant_id ?? '';
          return <DelegationCard key={i} output={output} task={(tool.input as { task?: string } | undefined)?.task} color={colorOf(consultantId)} live={live}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '顧問沒有完成這項工作' : undefined} />;
        }
        if (name === 'convene_discussion') {
          return <DiscussionView key={i} state={tool.output as DiscussionState | undefined} colorOf={colorOf} live={live}
            failedText={tool.state === 'output-error' ? tool.errorText ?? '主管沒能召集顧問' : undefined} />;
        }
        if (name === 'deliver_file' && tool.state === 'output-available') {
          // 失敗時輸出是 { error }，沒有 file_id，照一般工具步驟畫
          const file = tool.output as DeliveredFile | undefined;
          if (typeof file?.file_id === 'string') return <FileCards key={i} files={[file]} />;
        }
        return <ul key={i} className="my-2"><ToolStep step={settleStep(stepOf(tool, message.metadata), !live)} now={now} /></ul>;
      })}
      {delivered.length > 0 && (
        <section className="mt-4" aria-label="這次交付的檔案">
          <h3 className="text-sm font-medium text-muted">這次交付的檔案</h3>
          <FileCards files={delivered} />
        </section>
      )}
    </motion.div>
  );
}

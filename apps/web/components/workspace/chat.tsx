'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { textOf } from '@/lib/text';
import { MessageView } from './message-view';

type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null };

export function Chat({ threadId, ready, speaker, colorOf }: {
  threadId: string;
  ready: boolean;
  speaker: string;
  colorOf: (id: string) => string;
}) {
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const polling = useRef(false);

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: `/api/threads/${threadId}/chat`,
      prepareSendMessagesRequest: ({ messages }) => ({ body: { text: textOf(messages.at(-1)) } }),
    }),
    [threadId],
  );

  const { messages, sendMessage, setMessages, status } = useChat({ id: threadId, transport });

  const pollUntilDone = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setWaiting(true);
    try {
      for (;;) {
        const data = await api<ThreadMessages>(`/api/threads/${threadId}/messages`);
        if (!data.running) {
          setMessages(data.messages);
          setNotice(data.error ? `這次回覆沒有完成：${data.error}` : null);
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      polling.current = false;
      setWaiting(false);
    }
  }, [threadId, setMessages]);

  useEffect(() => {
    let cancelled = false;
    api<ThreadMessages>(`/api/threads/${threadId}/messages`)
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages);
        if (data.running) void pollUntilDone();
        else if (data.error) setNotice(`上一次回覆沒有完成：${data.error}`);
      })
      .catch((e) => setNotice((e as Error).message));
    return () => { cancelled = true; };
  }, [threadId, setMessages, pollUntilDone]);

  useEffect(() => {
    // 串流中斷時改用輪詢取回結果；輪詢本身會同步 setWaiting，這是刻意的
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (status === 'error') void pollUntilDone();
  }, [status, pollUntilDone]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming' || waiting;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !ready) return;
    setNotice(null);
    setInput('');
    void sendMessage({ text });
  }

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex-1 space-y-6 pb-4">
        {messages.length === 0 && (
          <p className="text-muted">說明你想完成的事，顧問們會分工處理。需要跨專業權衡時，主管會召集大家討論。</p>
        )}
        {messages.map((m) => <MessageView key={m.id} message={m} speaker={speaker} colorOf={colorOf} />)}
        {busy && <p className="text-sm text-muted">{waiting ? '回覆還在進行中，完成後會自動顯示…' : '顧問正在處理…'}</p>}
        {notice && <p role="alert" className="text-sm text-seal">{notice}</p>}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit} className="sticky bottom-0 flex gap-2 border-t border-line bg-paper py-3">
        <label className="flex-1">
          <span className="sr-only">訊息</span>
          <textarea
            rows={2}
            value={input}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}
            placeholder={ready ? '輸入訊息，Enter 送出，Shift+Enter 換行' : 'agent 環境準備好之後才能送出'}
            className="w-full resize-none rounded border border-line bg-surface px-3 py-2"
          />
        </label>
        <button disabled={busy || !ready || !input.trim()} className="self-end rounded bg-brand px-4 py-2 text-white disabled:opacity-60">送出</button>
      </form>
    </div>
  );
}

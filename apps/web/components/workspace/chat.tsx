'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { textOf } from '@/lib/text';
import { MessageView } from './message-view';

type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null };

export function Chat({ threadId, ready, speaker, colorOf, onSettled }: {
  threadId: string;
  ready: boolean;
  speaker: string;
  colorOf: (id: string) => string;
  onSettled?: () => void;
}) {
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const polling = useRef(false);
  const alive = useRef(true);
  const draft = useRef('');
  const localMessages = useRef<UIMessage[]>([]);
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; });

  const transport = useMemo(
    () => new DefaultChatTransport({
      api: `/api/threads/${threadId}/chat`,
      prepareSendMessagesRequest: ({ messages }) => ({ body: { text: textOf(messages.at(-1)) } }),
    }),
    [threadId],
  );

  const pollUntilDoneRef = useRef<() => Promise<void>>(async () => {});

  const { messages, sendMessage, setMessages, status } = useChat({
    id: threadId,
    transport,
    onFinish: () => settled.current?.(),
    onError: (err) => {
      if (!alive.current) return;
      // 請求本身被伺服器拒絕：伺服器回 { error }，訊息沒有送出，把草稿還給使用者
      let serverMessage: string | null = null;
      try {
        const parsed = JSON.parse(err.message) as { error?: unknown };
        if (typeof parsed.error === 'string') serverMessage = parsed.error;
      } catch { /* 不是 JSON：連線層級的錯誤 */ }
      if (serverMessage !== null) {
        setMessages((prev) => (prev.at(-1)?.role === 'user' ? prev.slice(0, -1) : prev));
        setInput(draft.current);
        setNotice(serverMessage);
        return;
      }
      // 連線中斷：如果回覆已開始（出現助理訊息），改用輪詢取回；否則檢查伺服器上的狀態
      void pollUntilDoneRef.current();
    },
  });
  useEffect(() => { localMessages.current = messages; }, [messages]);

  const pollUntilDone = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setWaiting(true);
    try {
      while (alive.current) {
        const data = await api<ThreadMessages>(`/api/threads/${threadId}/messages`);
        if (!alive.current) return;
        if (!data.running) {
          const local = localMessages.current;
          const replyStarted = local.at(-1)?.role === 'assistant';
          if (!replyStarted && data.messages.length < local.length) {
            // 伺服器沒有收到這則訊息：還原草稿，請使用者重送
            setMessages((prev) => (prev.at(-1)?.role === 'user' ? prev.slice(0, -1) : prev));
            setInput(draft.current);
            setNotice('送出失敗，請再試一次');
          } else {
            setMessages(data.messages);
            setNotice(data.error ? `這次回覆沒有完成：${data.error}` : null);
            settled.current?.();
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      if (alive.current) setNotice((e as Error).message);
    } finally {
      polling.current = false;
      if (alive.current) setWaiting(false);
    }
  }, [threadId, setMessages]);
  useEffect(() => { pollUntilDoneRef.current = pollUntilDone; }, [pollUntilDone]);

  useEffect(() => {
    alive.current = true;
    api<ThreadMessages>(`/api/threads/${threadId}/messages`)
      .then((data) => {
        if (!alive.current) return;
        setMessages(data.messages);
        if (data.running) void pollUntilDone();
        else if (data.error) setNotice(`上一次回覆沒有完成：${data.error}`);
      })
      .catch((e) => { if (alive.current) setNotice((e as Error).message); });
    return () => { alive.current = false; };
  }, [threadId, setMessages, pollUntilDone]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming' || waiting;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !ready) return;
    draft.current = text;
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

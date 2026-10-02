'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { textOf } from '@/lib/text';
import { MessageView } from './message-view';

type ThreadMessages = { messages: UIMessage[]; running: boolean; error: string | null };

/** 輪詢失敗後的等待時間：3 秒、6 秒，之後每 10 秒；連續失敗 5 次才放棄。 */
const POLL_INTERVAL_MS = 3000;
const POLL_BACKOFF_MS = [3000, 6000, 10000];
const MAX_POLL_FAILURES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Chat({ threadId, ready, speaker, hasManager, colorOf, onSettled }: {
  threadId: string;
  ready: boolean;
  speaker: string;
  /** 專案有兩位以上顧問時，由主管分工與召集討論 */
  hasManager: boolean;
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
    onFinish: ({ isError, isAbort, finishReason }) => {
      // 出錯由 onError 處理；使用者中止不需要處理
      if (isError || isAbort) return;
      // 串流正常關閉卻沒有 finish（runtime 逾時中止或 Vercel 函式時間到）：回覆可能沒完成，改向伺服器確認
      if (finishReason == null) {
        void pollUntilDoneRef.current();
        return;
      }
      settled.current?.();
    },
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
    let failures = 0;
    try {
      while (alive.current) {
        let data: ThreadMessages;
        try {
          data = await api<ThreadMessages>(`/api/threads/${threadId}/messages`);
        } catch {
          // 暫時連不上就稍後再試，連續失敗太多次才放棄
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            if (alive.current) setNotice('一直無法取得回覆進度，請檢查網路後重新整理頁面');
            return;
          }
          await sleep(POLL_BACKOFF_MS[Math.min(failures - 1, POLL_BACKOFF_MS.length - 1)]);
          continue;
        }
        failures = 0;
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
        await sleep(POLL_INTERVAL_MS);
      }
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
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    bottom.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'end' });
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
    <div className="flex min-h-[calc(100vh-14rem)] flex-col">
      <div className="flex-1 space-y-7 pb-6">
        {messages.length === 0 && (
          <div className="panel p-5 text-muted">
            <p className="font-display text-xl text-ink">{hasManager ? '跟主管說你想完成的事' : `跟${speaker}說你想完成的事`}</p>
            <p className="mt-2">
              {hasManager
                ? '主管會分派給合適的顧問；需要跨專業權衡時，會召集大家討論，最後整理成一份建議。'
                : `${speaker}會直接處理，需要時會讀你上傳的專案資料。`}
            </p>
            <p className="mt-2 text-sm">說過的事實與偏好會記在「記憶」面板，之後的對話都會沿用。</p>
          </div>
        )}
        {messages.map((m) => <MessageView key={m.id} message={m} speaker={speaker} colorOf={colorOf} />)}
        {busy && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <span className="dot-busy" aria-hidden />
            {waiting ? '回覆還在進行中，完成後會自動顯示' : `${speaker}正在處理`}
          </p>
        )}
        {notice && <p role="alert" className="notice notice-error">{notice}</p>}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit} className="sticky bottom-0 -mx-4 border-t border-line bg-paper px-4 py-3 sm:mx-0 sm:px-0">
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">訊息</span>
            <textarea
              rows={2}
              value={input}
              disabled={!ready}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}
              placeholder={ready ? `輸入訊息給${speaker}` : '工作電腦準備好之後才能送出'}
              className="field mt-0 resize-none"
            />
          </label>
          <button disabled={busy || !ready || !input.trim()} className="btn btn-primary">送出</button>
        </div>
        <p className="mt-1 hidden text-sm text-muted sm:block">Enter 送出，Shift+Enter 換行</p>
      </form>
    </div>
  );
}

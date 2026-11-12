'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { currentActivity, formatElapsed, isStalled } from '@/lib/progress';
import { afterRun, chatInFlight, readIds, reclaimQueued, restoredInput } from '@/lib/queue';
import type { QueuedView, ThreadMessages } from '@/lib/services/threads';
import { textOf } from '@/lib/text';
import { MessageView } from './message-view';
import { QueuedMessages } from './queued-messages';
import { useNow } from './use-now';

/** 輪詢失敗後的等待時間：3 秒、6 秒，之後每 10 秒；連續失敗 5 次才放棄。 */
const POLL_INTERVAL_MS = 3000;
const POLL_BACKOFF_MS = [3000, 6000, 10000];
const MAX_POLL_FAILURES = 5;
/** 這輪正常完成、還有排隊訊息時，等伺服器開下一輪的時間；超過就把訊息放回輸入框 */
const QUEUE_WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Chat({ threadId, ready, speaker, speakerColor, hasManager, colorOf, onSettled }: {
  threadId: string;
  ready: boolean;
  speaker: string;
  speakerColor: string;
  /** 專案有兩位以上顧問時，由主管分工與召集討論 */
  hasManager: boolean;
  colorOf: (id: string) => string;
  onSettled?: () => void;
}) {
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queued, setQueued] = useState<QueuedView[]>([]);
  // 這次回覆的開始時間（送出當下，或輪詢時伺服器回報的 run 開始時間）與伺服器最後更新時間
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // 從伺服器載入的訊息不播進場動畫，只有這次畫面上新出現的訊息才播
  const [known, setKnown] = useState<ReadonlySet<string>>(() => new Set());
  const markKnown = useCallback((list: UIMessage[]) => setKnown((prev) => new Set([...prev, ...list.map((m) => m.id)])), []);
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
  const queuedRef = useRef<QueuedView[]>([]);
  useEffect(() => { queuedRef.current = queued; }, [queued]);

  // 使用者按了停止：輪詢期間要繼續要求（下一輪可能才剛開），也不再等伺服器開下一輪
  const stopWanted = useRef(false);

  const restoreQueued = useCallback(async (items: QueuedView[]) => {
    setQueued([]);
    const kept = await reclaimQueued(items, (id) => api(`/api/threads/${threadId}/queue/${id}`, { method: 'DELETE' }));
    if (alive.current && kept.length > 0) setInput((current) => restoredInput(current, kept));
  }, [threadId]);

  const { messages, sendMessage, setMessages, status } = useChat({
    id: threadId,
    transport,
    onFinish: ({ isError, isAbort, finishReason }) => {
      // 出錯由 onError 處理；使用者中止不需要處理
      if (isError || isAbort) return;
      // 串流正常關閉卻沒有 finish（runtime 逾時中止或 Vercel 函式時間到）：回覆可能沒完成，改向伺服器確認。
      // 還有排隊訊息時也要繼續看伺服器，下一輪是伺服器自己開的
      if (finishReason == null || queuedRef.current.length > 0) {
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
        restoreDraft(serverMessage);
        // 這輪沒有開始，等著被它讀走的排隊訊息也放回輸入框
        void restoreQueued(queuedRef.current);
        return;
      }
      // 連線中斷：如果回覆已開始（出現助理訊息），改用輪詢取回；否則檢查伺服器上的狀態
      void pollUntilDoneRef.current();
    },
  });
  useEffect(() => { localMessages.current = messages; }, [messages]);
  // 換成伺服器上的訊息；這些不播進場動畫
  const showServer = useCallback((list: UIMessage[]) => {
    markKnown(list);
    setMessages(list);
  }, [markKnown, setMessages]);
  // 這則沒有送到伺服器：拿掉畫面上的使用者訊息，草稿放回輸入框
  const restoreDraft = useCallback((text: string) => {
    setMessages((prev) => (prev.at(-1)?.role === 'user' ? prev.slice(0, -1) : prev));
    setInput(draft.current);
    setNotice(text);
  }, [setMessages]);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  // 串流中沒有輪詢，靠回覆裡的 data-interjection 知道哪些排隊訊息被讀走了
  useEffect(() => {
    const read = readIds(messages);
    setQueued((prev) => (prev.some((q) => read.has(q.id)) ? prev.filter((q) => !read.has(q.id)) : prev));
  }, [messages]);

  const pollUntilDone = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setWaiting(true);
    let failures = 0;
    let queueDeadline: number | null = null;
    let reclaimed = false;
    // 上次換上的伺服器進度時間；runtime 每 5 秒才存一次，沒變就不用整串重畫
    let shownAt: string | null | undefined;
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
        setQueued(data.queued);
        if (!data.running) {
          const local = localMessages.current;
          const next = afterRun(data, stopWanted.current);
          // 停止時先收回排隊訊息再看一次：有訊息已被讀走（409），代表下一輪已經開始，要接著停它
          if (next === 'restore' && stopWanted.current && !reclaimed) {
            reclaimed = true;
            await restoreQueued(data.queued);
            continue;
          }
          if (next === 'wait') {
            queueDeadline ??= Date.now() + QUEUE_WAIT_MS;
            if (Date.now() < queueDeadline) {
              if (data.messages.length >= local.length) showServer(data.messages);
              await sleep(POLL_INTERVAL_MS);
              continue;
            }
          }
          const replyStarted = local.at(-1)?.role === 'assistant';
          if (!replyStarted && data.messages.length < local.length) {
            // 伺服器沒有收到這則訊息：還原草稿，請使用者重送
            restoreDraft('送出失敗，請再試一次');
          } else {
            showServer(data.messages);
            setNotice(data.error ? `這次回覆沒有完成：${data.error}` : next === 'wait' ? '排隊訊息沒有送出，已放回輸入框' : null);
            settled.current?.();
          }
          if (next !== 'none' && !reclaimed) void restoreQueued(data.queued);
          return;
        }
        queueDeadline = null;
        // 重複要求無害；失敗就下一次輪詢再試
        if (stopWanted.current) void api(`/api/threads/${threadId}/stop`, { method: 'POST' }).catch(() => undefined);
        if (data.startedAt) setStartedAt(Date.parse(data.startedAt));
        setUpdatedAt(data.updatedAt);
        // runtime 每 5 秒把進度存進 final：伺服器上已經有這次的回覆就直接顯示；
        // 伺服器自己開的下一輪還沒有回覆，但使用者訊息要先出現
        const grew = data.messages.length > localMessages.current.length;
        if ((data.messages.at(-1)?.role === 'assistant' && data.updatedAt !== shownAt) || grew) {
          shownAt = data.updatedAt;
          showServer(data.messages);
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      polling.current = false;
      if (alive.current) setWaiting(false);
    }
  }, [threadId, showServer, restoreDraft, restoreQueued]);
  useEffect(() => { pollUntilDoneRef.current = pollUntilDone; }, [pollUntilDone]);

  useEffect(() => {
    alive.current = true;
    api<ThreadMessages>(`/api/threads/${threadId}/messages`)
      .then((data) => {
        if (!alive.current) return;
        showServer(data.messages);
        setQueued(data.queued);
        const next = afterRun(data);
        if (data.running || next === 'wait') {
          if (data.startedAt) setStartedAt(Date.parse(data.startedAt));
          void pollUntilDone();
          return;
        }
        if (data.error) setNotice(`上一次回覆沒有完成：${data.error}`);
        if (next === 'restore') void restoreQueued(data.queued);
      })
      .catch((e) => { if (alive.current) setNotice((e as Error).message); });
    return () => { alive.current = false; };
  }, [threadId, showServer, pollUntilDone, restoreQueued]);

  // 使用者往上捲就停止跟到最新；捲回底部附近再恢復。只看「往上」才停，避免平滑捲動途中被誤判
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const nearBottom = (bottom.current?.getBoundingClientRect().top ?? 0) <= window.innerHeight + 80;
      if (nearBottom) following.current = true;
      else if (y < lastY) following.current = false;
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!following.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    bottom.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'end' });
  }, [messages]);

  // 輸入框跟著內容長高，最多到 max-h 後改成捲動
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const busy = chatInFlight(status) || waiting;
  const reply = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined;
  useEffect(() => {
    if (busy) return;
    stopWanted.current = false;
    setStopping(false);
  }, [busy]);

  async function enqueue(text: string) {
    setInput('');
    setNotice(null);
    try {
      const item = await api<QueuedView>(`/api/threads/${threadId}/queue`, {
        method: 'POST',
        json: { text, chatPending: status === 'submitted' },
      });
      if (!alive.current) return;
      // 上一則在這個請求途中被拒絕：那時 onError 還看不到這則，這裡補放回輸入框；這輪沒開始，不會有人讀它
      if (statusRef.current === 'error' && !polling.current) {
        void restoreQueued([item]);
        return;
      }
      if (!readIds(localMessages.current).has(item.id)) {
        setQueued((prev) => (prev.some((q) => q.id === item.id) ? prev : [...prev, item]));
      }
      // 請求途中這輪已經結束：onFinish 沒看到這則，改由輪詢接手（等下一輪或放回輸入框）
      if (!chatInFlight(statusRef.current)) void pollUntilDone();
    } catch (e) {
      if (!alive.current) return;
      setInput((current) => restoredInput(current, [{ id: '', text }]));
      setNotice((e as Error).message);
    }
  }

  async function editQueued(id: string, text: string) {
    try {
      await api(`/api/threads/${threadId}/queue/${id}`, { method: 'PATCH', json: { text } });
      setQueued((prev) => prev.map((q) => (q.id === id ? { ...q, text } : q)));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function deleteQueued(id: string) {
    try {
      await api(`/api/threads/${threadId}/queue/${id}`, { method: 'DELETE' });
      setQueued((prev) => prev.filter((q) => q.id !== id));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function stopRun() {
    if (stopping) return;
    setStopping(true);
    stopWanted.current = true;
    try {
      const askStop = () => api(`/api/threads/${threadId}/stop`, { method: 'POST' });
      await askStop();
      // 剛送出時 run 可能還沒建立，這時查不到就停不了；這個請求有結果之前持續要求，重複呼叫無害
      while (alive.current && statusRef.current === 'submitted') {
        await sleep(POLL_INTERVAL_MS);
        await askStop();
      }
      // 不用 useChat 的 stop：它只切斷瀏覽器連線，伺服器照跑
      await pollUntilDone();
    } catch (e) {
      if (!alive.current) return;
      stopWanted.current = false;
      setStopping(false);
      setNotice((e as Error).message);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !ready) return;
    if (busy) {
      void enqueue(text);
      return;
    }
    draft.current = text;
    setNotice(null);
    setStartedAt(Date.now());
    setUpdatedAt(null);
    setInput('');
    following.current = true;
    void sendMessage({ text });
  }

  return (
    <div className="flex min-h-[calc(100dvh-16rem)] flex-col">
      <div className="flex-1 space-y-8 pb-8">
        {messages.length === 0 && (
          <div className="panel p-6 text-muted">
            <p className="text-xl font-semibold text-ink">{hasManager ? '跟主管說你想完成的事' : `跟${speaker}說你想完成的事`}</p>
            <p className="mt-2">
              {hasManager
                ? '主管會分派給合適的顧問；需要跨專業權衡時，會召集大家討論，最後整理成一份建議。'
                : `${speaker}會直接處理，需要時會讀你上傳的專案資料。`}
            </p>
            <p className="mt-2 text-sm">說過的事實與偏好會記在「記憶」面板，之後的對話都會沿用。</p>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={m.id} message={m} speaker={speaker} speakerColor={speakerColor} colorOf={colorOf} animateIn={!known.has(m.id)}
            live={busy && i === messages.length - 1} />
        ))}
        <RunStatus busy={busy} speaker={speaker} startedAt={startedAt} activity={currentActivity(reply)}
          // 串流連線還在就表示 runtime 活著；只有輪詢時才用更新時間判斷是否卡住
          stallSince={waiting ? updatedAt : null} />
        {notice && <p role="alert" className="notice notice-error">{notice}</p>}
        <div ref={bottom} className="scroll-mb-32" />
      </div>
      {/* 浮動輸入列：半透明材質，對話從底下捲過去 */}
      <form onSubmit={submit} className="sticky bottom-0 z-10 -mx-4 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:mx-0 sm:px-0">
        <QueuedMessages items={queued} onEdit={editQueued} onDelete={deleteQueued} />
        <div className="material-surface flex items-end gap-2 rounded-[24px] p-1.5 pl-4 shadow-float transition-shadow duration-150 focus-within:shadow-[0_0_0_1.5px_var(--color-link),0_0_0_5px_var(--color-brand-soft),var(--shadow-float)]">
          <label className="min-w-0 flex-1 self-center">
            <span className="sr-only">訊息</span>
            <textarea
              ref={textarea}
              rows={1}
              value={input}
              disabled={!ready}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && !e.shiftKey) submit(e);
                if (e.key === 'Escape' && busy) void stopRun();
              }}
              placeholder={!ready ? '工作電腦準備好之後才能送出' : busy ? '再傳一則訊息，會排隊' : `輸入訊息給${speaker}`}
              className="block max-h-48 w-full resize-none bg-transparent py-1.5 text-base text-ink placeholder:text-muted focus:outline-none disabled:opacity-60"
            />
          </label>
          {busy && (
            <button type="button" onClick={() => void stopRun()} disabled={stopping} aria-label={stopping ? '停止中…' : '停止'}
              className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-full bg-sunken text-ink transition-[transform,opacity] duration-100 active:scale-90 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100">
              {stopping
                ? <span aria-hidden className="px-3 text-sm">停止中…</span>
                : <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>}
            </button>
          )}
          {(!busy || input.trim()) && (
            <button disabled={!ready || !input.trim()} aria-label={busy ? '排隊' : '送出'}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white transition-[transform,background-color,opacity] duration-100 hover:bg-brand-strong active:scale-90 disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100">
              <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** 經過時間每秒更新；放在自己的元件裡，整串對話不必跟著每秒重畫 */
function RunStatus({ busy, speaker, startedAt, activity, stallSince }: {
  busy: boolean; speaker: string; startedAt: number | null; activity: string; stallSince: string | null;
}) {
  const now = useNow(busy);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted empty:hidden">
      {busy && (
        <>
          <span className="dot-busy" aria-hidden />
          <span>{speaker}處理中</span>
          {startedAt !== null && <span aria-hidden className="tabular-nums">· {formatElapsed(now - startedAt)}</span>}
          <span role="status">· {activity}</span>
        </>
      )}
      {busy && isStalled(stallSince, now) && <span role="alert" className="text-ochre">已經 1 分鐘沒有新進度，可能卡住了</span>}
    </div>
  );
}

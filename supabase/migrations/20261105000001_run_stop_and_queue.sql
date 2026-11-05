-- 執行中停止與訊息排隊：run 可標成使用者中斷，執行中送出的訊息先排隊，由 runtime 在下一步取走。
-- 規格：docs/superpowers/specs/2026-11-05-run-stop-and-queue-design.md §5、§9
-- 可重複執行：先在 Dashboard SQL Editor 手動套用，之後 db:push 再跑一次也不會出錯。

alter table public.runs drop constraint if exists runs_status_check;
alter table public.runs add constraint runs_status_check
  check (status in ('running', 'succeeded', 'failed', 'cancelled'));

-- interjection：被 agent 讀到的排隊訊息，畫面靠 final 裡的 data-interjection 顯示，這裡只給之後的輪次組歷史
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('user', 'final', 'delegation', 'discussion', 'interjection'));

-- 中斷後組上下文時要標明每段報告是哪位顧問
grant select (speaker_instance_id) on public.messages to authenticated;

create table if not exists public.queued_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists queued_messages_thread_created on public.queued_messages (thread_id, created_at);
alter table public.queued_messages enable row level security;

-- runtime 只能讀取與取走（刪除）自己專案的排隊訊息；新增與編輯由網站以 service role 處理
grant select (id, thread_id, text, created_at) on public.queued_messages to authenticated;
grant delete on public.queued_messages to authenticated;
drop policy if exists runtime_read on public.queued_messages;
create policy runtime_read on public.queued_messages for select to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()));
drop policy if exists runtime_delete on public.queued_messages;
create policy runtime_delete on public.queued_messages for delete to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()));

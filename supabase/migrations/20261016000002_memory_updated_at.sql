-- 記憶的 updated_at 由資料庫維護：新增用預設的 now()，更新由觸發器設成 now()，
-- 不混用 runtime／Vercel 的時鐘（時鐘不同步時，記憶索引的新舊順序會錯）。
-- 可重複執行：先在 Dashboard SQL Editor 手動套用，之後 db:push 再跑一次也不會出錯。

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists memories_touch_updated_at on public.memories;
create trigger memories_touch_updated_at before update on public.memories
  for each row execute function public.touch_updated_at();

-- runtime 不必再自己寫 updated_at（docs/security-model.md 第 4 節）
revoke update (updated_at) on public.memories from authenticated;

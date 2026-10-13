-- 執行中的 final 會定期更新；前端用它判斷 runtime 是否還活著
-- 2026-10-13 已先在 Dashboard 手動套用，用 if not exists 讓 db:push 補記 migration 時不會失敗
alter table public.messages add column if not exists updated_at timestamptz not null default now();

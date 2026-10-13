-- 執行中的 final 會定期更新；前端用它判斷 runtime 是否還活著
alter table public.messages add column updated_at timestamptz not null default now();

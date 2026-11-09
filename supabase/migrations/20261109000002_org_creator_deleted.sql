-- 組織設定：做顧問的人刪除帳號時，他的組織顧問要轉給管理員（預設）還是跟著刪除。
-- 轉給該組織最早加入的管理員（不含被刪的人）；沒有其他管理員就照原本的 cascade 刪除。代管 MCP 版本跟著範本走。
-- 規格：docs/superpowers/specs/2026-11-09-organizations-design.md §5.3；營運說明：docs/security-model.md 第 7 節
-- 可重複執行：先在 Dashboard SQL Editor 手動套用，之後 db:push 再跑一次也不會出錯。
-- 與目前上線的程式相容：新欄位有預設值，舊程式不用帶。

alter table public.organizations add column if not exists creator_deleted_action text not null default 'transfer'
  check (creator_deleted_action in ('transfer', 'delete'));
-- 網站使用者仍然碰不到（網站一律用 secret key）
revoke all on public.organizations from anon, authenticated;

-- 刪帳號時 auth.users → profiles 是 cascade，cascade 的 delete 一樣會觸發 profiles 的 row trigger。
-- before delete 先改掉 creator_id，之後 profiles → agent_templates 的 cascade 就找不到這些範本。
create or replace function public.transfer_org_templates_on_profile_delete()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_templates t
     set creator_id = a.user_id
    from public.organizations o
    cross join lateral (
      select m.user_id from public.org_members m
       where m.org_id = o.id and m.role = 'admin' and m.user_id <> old.id
       order by m.joined_at, m.user_id
       limit 1
    ) a
   where t.creator_id = old.id
     and t.org_id = o.id
     and o.creator_deleted_action = 'transfer';
  return old;
end $$;

revoke execute on function public.transfer_org_templates_on_profile_delete() from public, anon, authenticated;

drop trigger if exists transfer_org_templates on public.profiles;
create trigger transfer_org_templates before delete on public.profiles
  for each row execute function public.transfer_org_templates_on_profile_delete();

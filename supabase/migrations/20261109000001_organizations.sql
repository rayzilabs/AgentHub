-- 組織：團隊內部共用顧問。組織顧問只有成員租得到；成員離開或顧問下架後，已租的副本 runtime 讀不到。
-- 能不能呼叫每次即時判斷（org_instance_problem），副本自己記得屬於哪個組織（範本被刪時 template_id 會變成 null）。
-- 規格：docs/superpowers/specs/2026-11-09-organizations-design.md §5.3、§5.3a、§5.4、§6
-- 可重複執行：先在 Dashboard SQL Editor 手動套用，之後 db:push 再跑一次也不會出錯。
-- 與目前上線的程式相容：新欄位都可為 null；org_id 為 null 的顧問與範本，權限與租用行為都跟以前一樣。

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 50),
  require_template_approval boolean not null default false,
  -- 建立的人刪帳號後組織留著（顧問與其他成員不受影響）
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  -- 加入時的 email，給成員名單顯示用
  email text not null,
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user on public.org_members (user_id);

create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  invited_by uuid not null references public.profiles (id) on delete cascade,
  needs_approval boolean not null,
  status text not null default 'invited' check (status in ('invited', 'accepted')),
  accepted_user_id uuid references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  constraint org_invitations_org_email unique (org_id, email)
);
create index if not exists org_invitations_email on public.org_invitations (email);

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.org_invitations enable row level security;
revoke all on public.organizations from anon, authenticated;
revoke all on public.org_members from anon, authenticated;
revoke all on public.org_invitations from anon, authenticated;

-- 範本：org_id 為 null 是公開市集的範本；pending（等管理員核准）只有組織範本會有
alter table public.agent_templates add column if not exists org_id uuid references public.organizations (id) on delete restrict;
alter table public.agent_templates drop constraint if exists agent_templates_status_check;
alter table public.agent_templates add constraint agent_templates_status_check
  check (status in ('draft', 'pending', 'published'));
alter table public.agent_templates drop constraint if exists agent_templates_pending_needs_org;
alter table public.agent_templates add constraint agent_templates_pending_needs_org
  check (status <> 'pending' or org_id is not null);

-- 副本：租用時從範本複製；組織還有副本時不能刪（set null 會讓組織顧問變成誰都能用）
alter table public.agent_instances add column if not exists org_id uuid references public.organizations (id) on delete restrict;

-- 組織顧問現在能不能呼叫：null＝可以（或不是組織顧問）；not_member＝專案擁有者不是組織成員；unpublished＝範本不在或沒上架
create or replace function public.org_instance_problem(p_org_id uuid, p_template_id uuid, p_project_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_org_id is null then null
    when not exists (
      select 1 from public.projects p
        join public.org_members m on m.user_id = p.owner_id
       where p.id = p_project_id and m.org_id = p_org_id
    ) then 'not_member'
    when not exists (
      select 1 from public.agent_templates t
       where t.id = p_template_id and t.org_id = p_org_id and t.status = 'published'
    ) then 'unpublished'
  end
$$;

-- 專案畫面用：列出被擋的組織顧問與原因
create or replace function public.project_instance_problems(p_project_id uuid)
returns table (instance_id uuid, org_name text, problem text)
language sql stable set search_path = '' as $$
  select x.id, o.name, x.problem
    from (select i.id, i.org_id, i.created_at,
                 public.org_instance_problem(i.org_id, i.template_id, i.project_id) as problem
            from public.agent_instances i
           where i.project_id = p_project_id and i.org_id is not null) x
    join public.organizations o on o.id = x.org_id
   where x.problem is not null
   order by x.created_at
$$;

revoke execute on function public.org_instance_problem(uuid, uuid, uuid) from public, anon;
revoke execute on function public.project_instance_problems(uuid) from public, anon, authenticated;
grant execute on function public.org_instance_problem(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.project_instance_problems(uuid) to service_role;

-- runtime 權限（docs/security-model.md 第 4 節）：被擋的組織顧問讀不到。
-- agent_templates 與 Storage skills 的 runtime policy 都是查 agent_instances，會跟著濾掉。
grant select (org_id) on public.agent_instances to authenticated;
drop policy if exists runtime_read on public.agent_instances;
create policy runtime_read on public.agent_instances for select to authenticated
  using (project_id = public.runtime_project()
         and public.org_instance_problem(org_id, template_id, project_id) is null);

-- 租用：以 20261015000002_hosted_mcp_retire.sql 為底，加上組織成員檢查與 org_id
create or replace function public.hire_agent(p_project_id uuid, p_template_id uuid, p_secrets jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.agent_templates%rowtype;
  v_instance_id uuid;
  v_server jsonb;
  v_required jsonb;
  v_value text;
  v_secret_id uuid;
  v_consultants int;
  v_version_id uuid;
begin
  -- 鎖住專案列，讓同一專案的並行啟用依序執行（避免兩個顧問同時加入卻沒有建立主管）
  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'project % not found', p_project_id using errcode = 'P0002';
  end if;

  select * into t from public.agent_templates
   where id = p_template_id and status = 'published';
  if not found then
    raise exception 'template % not found or not published', p_template_id using errcode = 'P0002';
  end if;

  -- 組織顧問只有該組織的成員（看專案擁有者）租得到
  if t.org_id is not null and not exists (
    select 1 from public.projects p
      join public.org_members m on m.user_id = p.owner_id
     where p.id = p_project_id and m.org_id = t.org_id
  ) then
    raise exception 'not org member' using errcode = '42501';
  end if;

  -- remote 型的創作者網址不寫進顧問設定（Sprite 讀得到），改存 remote_mcp_targets
  insert into public.agent_instances
    (project_id, template_id, org_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers)
  values
    (p_project_id, t.id, t.org_id, 'consultant', t.name, t.description, t.system_prompt, t.skills_zip_path, t.skills,
     (select coalesce(jsonb_agg(case when s ->> 'transport' = 'remote'
                                     then jsonb_build_object('name', s ->> 'name', 'transport', 'remote')
                                     else s end order by n), '[]'::jsonb)
        from jsonb_array_elements(t.mcp_servers) with ordinality as e(s, n)))
  returning id into v_instance_id;

  insert into public.remote_mcp_targets (instance_id, mcp_name, kind, url)
  select v_instance_id, s ->> 'name', 'self', s ->> 'url'
    from jsonb_array_elements(t.mcp_servers) s
   where s ->> 'transport' = 'remote' and coalesce((s ->> 'hosted')::boolean, false) = false;

  -- 平台代管：鎖定該 MCP 最新的已發布版本；沒有就不能租用
  for v_server in select * from jsonb_array_elements(t.mcp_servers) loop
    if v_server ->> 'transport' = 'remote' and coalesce((v_server ->> 'hosted')::boolean, false) then
      select id into v_version_id from public.hosted_mcp_versions
       where template_id = t.id and mcp_name = v_server ->> 'name' and status = 'published'
       order by version desc limit 1
       -- 與 retire_hosted_mcp_version 的 for update 互斥：下架要等這次租用 commit 才檢查得到
       for share;
      if v_version_id is null then
        raise exception 'hosted mcp % has no published version', v_server ->> 'name';
      end if;
      insert into public.remote_mcp_targets (instance_id, mcp_name, kind, hosted_version_id)
      values (v_instance_id, v_server ->> 'name', 'hosted', v_version_id);
    end if;
  end loop;

  for v_server in select * from jsonb_array_elements(t.mcp_servers) loop
    for v_required in select * from jsonb_array_elements(coalesce(v_server -> 'required_secrets', '[]'::jsonb)) loop
      v_value := p_secrets -> (v_server ->> 'name') ->> (v_required ->> 'key');
      if v_value is null or v_value = '' then
        raise exception 'missing secret %.%', v_server ->> 'name', v_required ->> 'key' using errcode = '22023';
      end if;
      v_secret_id := vault.create_secret(
        v_value,
        v_instance_id::text || ':' || (v_server ->> 'name') || ':' || (v_required ->> 'key'));
      insert into public.instance_secrets (instance_id, mcp_name, key, vault_secret_id)
      values (v_instance_id, v_server ->> 'name', v_required ->> 'key', v_secret_id);
    end loop;
  end loop;

  select count(*) into v_consultants
    from public.agent_instances
   where project_id = p_project_id and role = 'consultant';
  if v_consultants >= 2 then
    insert into public.agent_instances (project_id, role, name, description)
    values (p_project_id, 'manager', '主管', '平台內建主管，負責分工與整合')
    on conflict (project_id) where role = 'manager' do nothing;
  end if;

  return v_instance_id;
end $$;

revoke execute on function public.hire_agent(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hire_agent(uuid, uuid, jsonb) to service_role;

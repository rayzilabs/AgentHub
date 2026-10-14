-- 子專案 3：創作者 MCP 的網址只有閘道（service_role）讀得到；用量只由閘道寫入
create table public.remote_mcp_targets (
  instance_id uuid not null references public.agent_instances (id) on delete cascade,
  mcp_name text not null,
  kind text not null default 'self' check (kind in ('self', 'hosted')),
  url text,
  primary key (instance_id, mcp_name)
);
alter table public.remote_mcp_targets enable row level security;
revoke all on public.remote_mcp_targets from anon, authenticated;

create table public.mcp_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null,
  instance_id uuid not null,
  template_id uuid,
  creator_id uuid,
  mcp_name text not null,
  tool text not null,
  ok boolean not null,
  duration_ms int not null
);
alter table public.mcp_usage enable row level security;
revoke all on public.mcp_usage from anon, authenticated;
create index mcp_usage_template_created on public.mcp_usage (template_id, created_at desc);

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

  -- remote 型的創作者網址不寫進顧問設定（Sprite 讀得到），改存 remote_mcp_targets
  insert into public.agent_instances
    (project_id, template_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers)
  values
    (p_project_id, t.id, 'consultant', t.name, t.description, t.system_prompt, t.skills_zip_path, t.skills,
     (select coalesce(jsonb_agg(case when s ->> 'transport' = 'remote'
                                     then jsonb_build_object('name', s ->> 'name', 'transport', 'remote')
                                     else s end order by n), '[]'::jsonb)
        from jsonb_array_elements(t.mcp_servers) with ordinality as e(s, n)))
  returning id into v_instance_id;

  insert into public.remote_mcp_targets (instance_id, mcp_name, kind, url)
  select v_instance_id, s ->> 'name', 'self', s ->> 'url'
    from jsonb_array_elements(t.mcp_servers) s
   where s ->> 'transport' = 'remote';

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

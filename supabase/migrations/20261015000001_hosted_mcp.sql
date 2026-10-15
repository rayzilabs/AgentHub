-- 子專案 3b：平台代管 MCP 的版本與創作者金鑰；只有 service role（Vercel）讀寫
create table public.hosted_mcp_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.agent_templates (id) on delete cascade,
  mcp_name text not null,
  version int not null,
  status text not null default 'pending'
    check (status in ('pending', 'deploying', 'ready', 'failed', 'published', 'retired', 'disabled')),
  bundle_path text not null,
  sprite_name text,
  sprite_url text,
  tools jsonb not null default '[]'::jsonb,
  log_tail text not null default '',
  deploy_started_at timestamptz,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (template_id, mcp_name, version)
);
alter table public.hosted_mcp_versions enable row level security;
revoke all on public.hosted_mcp_versions from anon, authenticated;

create table public.hosted_mcp_secrets (
  template_id uuid not null references public.agent_templates (id) on delete cascade,
  mcp_name text not null,
  key text not null,
  vault_secret_id uuid not null,
  primary key (template_id, mcp_name, key)
);
alter table public.hosted_mcp_secrets enable row level security;
revoke all on public.hosted_mcp_secrets from anon, authenticated;

-- 租用時鎖定的代管版本；還有顧問在用的版本不能刪
alter table public.remote_mcp_targets
  add column hosted_version_id uuid references public.hosted_mcp_versions (id) on delete restrict;

create function public.set_hosted_mcp_secret(p_template_id uuid, p_mcp_name text, p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select vault_secret_id into v_id from public.hosted_mcp_secrets
   where template_id = p_template_id and mcp_name = p_mcp_name and key = p_key;
  if v_id is null then
    v_id := vault.create_secret(p_value, 'hosted:' || p_template_id || ':' || p_mcp_name || ':' || p_key);
    insert into public.hosted_mcp_secrets values (p_template_id, p_mcp_name, p_key, v_id);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end $$;

create function public.get_hosted_mcp_secrets(p_template_id uuid, p_mcp_name text)
returns table (key text, value text) language sql security definer set search_path = '' as $$
  select s.key, d.decrypted_secret
    from public.hosted_mcp_secrets s join vault.decrypted_secrets d on d.id = s.vault_secret_id
   where s.template_id = p_template_id and s.mcp_name = p_mcp_name
   order by s.key
$$;

revoke execute on function public.set_hosted_mcp_secret(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_hosted_mcp_secrets(uuid, text) from public, anon, authenticated;
grant execute on function public.set_hosted_mcp_secret(uuid, text, text, text) to service_role;
grant execute on function public.get_hosted_mcp_secrets(uuid, text) to service_role;

-- 創作者上傳的代管 MCP 套件（私有）
insert into storage.buckets (id, name, public) values ('mcp-bundles', 'mcp-bundles', false)
on conflict (id) do nothing;

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
   where s ->> 'transport' = 'remote' and coalesce((s ->> 'hosted')::boolean, false) = false;

  -- 平台代管：鎖定該 MCP 最新的已發布版本；沒有就不能租用
  for v_server in select * from jsonb_array_elements(t.mcp_servers) loop
    if v_server ->> 'transport' = 'remote' and coalesce((v_server ->> 'hosted')::boolean, false) then
      select id into v_version_id from public.hosted_mcp_versions
       where template_id = t.id and mcp_name = v_server ->> 'name' and status = 'published'
       order by version desc limit 1;
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

-- 子專案 3b 修正：租用與下架同時發生時，下架必須看得到進行中的租用
-- hire_agent 對選到的版本加 for share；下架改由函式在同一個交易裡 for update、檢查、標 retired
create function public.retire_hosted_mcp_version(p_version_id uuid, p_allowed text[])
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.hosted_mcp_versions where id = p_version_id for update;
  if v_status is null then
    raise exception 'hosted version not found' using errcode = 'P0002';
  end if;
  if not (v_status = any (p_allowed)) then
    raise exception 'hosted version status %', v_status using errcode = '55000';
  end if;
  if exists (select 1 from public.remote_mcp_targets where hosted_version_id = p_version_id) then
    raise exception 'hosted version in use' using errcode = '55000';
  end if;
  update public.hosted_mcp_versions set status = 'retired' where id = p_version_id;
  return v_status;
end $$;

revoke execute on function public.retire_hosted_mcp_version(uuid, text[]) from public, anon, authenticated;
grant execute on function public.retire_hosted_mcp_version(uuid, text[]) to service_role;

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

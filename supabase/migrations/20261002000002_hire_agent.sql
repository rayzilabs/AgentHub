create function public.hire_agent(p_project_id uuid, p_template_id uuid, p_secrets jsonb default '{}'::jsonb)
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
  select * into t from public.agent_templates
   where id = p_template_id and status = 'published';
  if not found then
    raise exception 'template % not found or not published', p_template_id using errcode = 'P0002';
  end if;

  insert into public.agent_instances
    (project_id, template_id, role, name, system_prompt, skills_zip_path, skills, mcp_servers)
  values
    (p_project_id, t.id, 'consultant', t.name, t.system_prompt, t.skills_zip_path, t.skills, t.mcp_servers)
  returning id into v_instance_id;

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
    insert into public.agent_instances (project_id, role, name)
    values (p_project_id, 'manager', '主管')
    on conflict (project_id) where role = 'manager' do nothing;
  end if;

  return v_instance_id;
end $$;

create function public.get_project_secrets(p_project_id uuid)
returns table (instance_id uuid, mcp_name text, key text, value text)
language sql security definer set search_path = '' as $$
  select s.instance_id, s.mcp_name, s.key, d.decrypted_secret
    from public.instance_secrets s
    join public.agent_instances i on i.id = s.instance_id
    join vault.decrypted_secrets d on d.id = s.vault_secret_id
   where i.project_id = p_project_id
$$;

-- 新函式預設 PUBLIC 可執行，Supabase 也預設授權給 anon / authenticated，必須全部收回
revoke execute on function public.hire_agent(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.get_project_secrets(uuid) from public, anon, authenticated;
grant execute on function public.hire_agent(uuid, uuid, jsonb) to service_role;
grant execute on function public.get_project_secrets(uuid) to service_role;

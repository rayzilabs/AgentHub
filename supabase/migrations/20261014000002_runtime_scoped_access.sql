-- 子專案 1-C：runtime 以專案專用帳號的通行證存取資料庫，權限由這裡把關
-- 一般使用者（含專案擁有者）與匿名者一律沒有任何權限；網站照舊用 service role

create function public.runtime_project() returns uuid
language sql stable set search_path = '' as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'agenthub_runtime_project', '')::uuid
$$;

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- runtime 帳號的通行證快取（只有 service role）
create table public.project_runtime_accounts (
  project_id uuid primary key references public.projects (id) on delete cascade,
  user_id uuid not null,
  password text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz
);
alter table public.project_runtime_accounts enable row level security;
revoke all on public.project_runtime_accounts from anon, authenticated;

-- agent_instances：讀自己專案
grant select (id, project_id, template_id, role, name, description, system_prompt, skills_zip_path, skills, mcp_servers, created_at)
  on public.agent_instances to authenticated;
create policy runtime_read on public.agent_instances for select to authenticated
  using (project_id = public.runtime_project());

-- agent_templates：只讀 creator_id，且只限自己專案租用的範本
grant select (id, creator_id) on public.agent_templates to authenticated;
create policy runtime_read on public.agent_templates for select to authenticated
  using (id in (select template_id from public.agent_instances where project_id = public.runtime_project()));

-- threads：讀自己專案
grant select (id, project_id) on public.threads to authenticated;
create policy runtime_read on public.threads for select to authenticated
  using (project_id = public.runtime_project());

-- runs：讀、新增；只能改狀態欄位
grant select (id, thread_id, status) on public.runs to authenticated;
grant insert (thread_id) on public.runs to authenticated;
grant update (status, error, finished_at) on public.runs to authenticated;
create policy runtime_read on public.runs for select to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_insert on public.runs for insert to authenticated
  with check (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_update on public.runs for update to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()))
  with check (thread_id in (select id from public.threads where project_id = public.runtime_project()));

-- messages：讀、新增；只能改／刪執行中 run 的 final
grant select (id, thread_id, run_id, kind, content, created_at) on public.messages to authenticated;
grant insert (thread_id, run_id, speaker_instance_id, kind, round, content, ui_message, tool_events) on public.messages to authenticated;
grant update (content, ui_message, tool_events, updated_at) on public.messages to authenticated;
grant delete on public.messages to authenticated;
create policy runtime_read on public.messages for select to authenticated
  using (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_insert on public.messages for insert to authenticated
  with check (thread_id in (select id from public.threads where project_id = public.runtime_project()));
create policy runtime_update on public.messages for update to authenticated
  using (kind = 'final'
         and thread_id in (select id from public.threads where project_id = public.runtime_project())
         and run_id in (select id from public.runs where status = 'running'));
create policy runtime_delete on public.messages for delete to authenticated
  using (kind = 'final' and content = ''
         and thread_id in (select id from public.threads where project_id = public.runtime_project())
         and run_id in (select id from public.runs where status = 'running'));

-- memories：讀、新增
grant select (id, project_id, instance_id, content, created_at) on public.memories to authenticated;
grant insert (project_id, instance_id, content, created_by_instance_id) on public.memories to authenticated;
create policy runtime_read on public.memories for select to authenticated
  using (project_id = public.runtime_project());
create policy runtime_insert on public.memories for insert to authenticated
  with check (project_id = public.runtime_project());

-- usage_events：只能新增
grant insert (run_id, project_id, instance_id, template_id, creator_id, model, prompt_tokens, output_tokens, cached_tokens, thought_tokens)
  on public.usage_events to authenticated;
create policy runtime_insert on public.usage_events for insert to authenticated
  with check (project_id = public.runtime_project());

-- MCP 金鑰：只能取自己專案
create or replace function public.get_project_secrets(p_project_id uuid)
returns table (instance_id uuid, mcp_name text, key text, value text)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' and p_project_id is distinct from public.runtime_project() then
    raise exception 'not allowed';
  end if;
  return query
    select s.instance_id, s.mcp_name, s.key, d.decrypted_secret
      from public.instance_secrets s
      join public.agent_instances i on i.id = s.instance_id
      join vault.decrypted_secrets d on d.id = s.vault_secret_id
     where i.project_id = p_project_id;
end $$;
revoke execute on function public.get_project_secrets(uuid) from public, anon;
grant execute on function public.get_project_secrets(uuid) to authenticated, service_role;

-- Storage：skill zip 只限自己專案顧問的；專案檔案只限自己專案資料夾
create policy runtime_read_skills on storage.objects for select to authenticated
  using (bucket_id = 'skills'
         and name in (select skills_zip_path from public.agent_instances where project_id = public.runtime_project()));
create policy runtime_read_project_files on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and name like public.runtime_project()::text || '/%');

-- runtime 帳號不建立個人檔案
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_app_meta_data ? 'agenthub_runtime_project' then
    return new;
  end if;
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''));
  return new;
end $$;

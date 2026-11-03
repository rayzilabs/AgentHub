-- 雲端資料夾：檔案與資料夾有自己的紀錄，storage 路徑固定為 <專案id>/files/<檔案id>，改名、搬移只改資料表。
-- runtime 只能上傳到自己專案的 files/ 底下，再呼叫 deliver_project_file 登記到該顧問的資料夾。
-- 規格：docs/superpowers/specs/2026-11-03-cloud-folder-design.md §4.1–4.3、§4.8
-- 可重複執行：先在 Dashboard SQL Editor 手動套用，之後 db:push 再跑一次也不會出錯。

-- 檔名與資料夾名：1～100 字，不能有 /、\、控制字元，不能是 . 或 ..
create or replace function public.is_entry_name(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_name is not null
     and char_length(p_name) between 1 and 100
     and p_name !~ '[[:cntrl:]/\\]'
     and p_name not in ('.', '..')
$$;

-- 顧問名稱當資料夾名：不合法的字元換成 _，淨化後不能用就叫「顧問」
create or replace function public.safe_entry_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  select case when s.v in ('', '.', '..') then '顧問' else s.v end
    from (select left(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]/\\]', '_', 'g'), 100) as v) s
$$;

-- 週報.docx, 2 → 週報 (2).docx；沒有副檔名（或只有開頭的 .）就直接接在後面；超過 100 字時截短主檔名
create or replace function public.numbered_name(p_name text, p_n int) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_dot int := char_length(p_name) - strpos(reverse(p_name), '.') + 1;
  v_tag text := ' (' || p_n || ')';
  v_base text := p_name;
  v_ext text := '';
begin
  if strpos(p_name, '.') > 0 and v_dot > 1 then
    v_base := left(p_name, v_dot - 1);
    v_ext := substr(p_name, v_dot);
  end if;
  return left(v_base, greatest(100 - char_length(v_tag) - char_length(v_ext), 1)) || v_tag || v_ext;
end $$;

create table if not exists public.project_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  parent_id uuid references public.project_folders (id) on delete cascade,
  name text not null check (public.is_entry_name(name)),
  created_at timestamptz not null default now(),
  -- 根目錄（parent_id is null）的資料夾也不能同名
  constraint project_folders_parent_name unique nulls not distinct (project_id, parent_id, name)
);

create table if not exists public.project_files (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  folder_id uuid not null references public.project_folders (id) on delete cascade,
  name text not null check (public.is_entry_name(name)),
  size bigint not null,
  content_type text not null,
  source text not null check (source in ('user', 'agent')),
  agent_instance_id uuid references public.agent_instances (id) on delete set null,
  run_id uuid references public.runs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_files_folder_name unique (folder_id, name)
);
create index if not exists project_files_project on public.project_files (project_id);

alter table public.project_folders enable row level security;
alter table public.project_files enable row level security;
revoke all on public.project_folders from anon, authenticated;
revoke all on public.project_files from anon, authenticated;

-- 有就回 id，沒有就建；同時有人建同名資料夾時回頭拿對方建好的
create or replace function public.ensure_folder(p_project_id uuid, p_parent_id uuid, p_name text) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  if p_parent_id is not null and not exists (
    select 1 from public.project_folders f where f.id = p_parent_id and f.project_id = p_project_id
  ) then
    raise exception 'folder not found';
  end if;
  for i in 1..3 loop
    select f.id into v_id from public.project_folders f
     where f.project_id = p_project_id and f.parent_id is not distinct from p_parent_id and f.name = p_name;
    if found then
      return v_id;
    end if;
    begin
      insert into public.project_folders (project_id, parent_id, name)
      values (p_project_id, p_parent_id, p_name)
      returning id into v_id;
      return v_id;
    exception when unique_violation then
      -- 別的交易剛建好同名資料夾，下一輪查得到（read committed 每句都看得到最新的資料）
    end;
  end loop;
  raise exception 'folder conflict';
end $$;

-- 替已上傳的 storage 物件登記檔案；大小與類型以 storage 為準，同名時自動加序號
create or replace function public.register_project_file(
  p_project_id uuid, p_file_id uuid, p_folder_id uuid, p_name text,
  p_source text, p_instance_id uuid, p_run_id uuid
) returns public.project_files
language plpgsql set search_path = '' as $$
declare
  v_size bigint;
  v_type text;
  v_name text := p_name;
  v_n int := 1;
  v_constraint text;
  v_row public.project_files;
begin
  select (o.metadata ->> 'size')::bigint, coalesce(o.metadata ->> 'mimetype', 'application/octet-stream')
    into v_size, v_type
    from storage.objects o
   where o.bucket_id = 'project-files' and o.name = p_project_id::text || '/files/' || p_file_id::text;
  if not found then
    raise exception 'storage object missing';
  end if;
  if not exists (select 1 from public.project_folders f where f.id = p_folder_id and f.project_id = p_project_id) then
    raise exception 'folder not found';
  end if;
  loop
    if not exists (select 1 from public.project_files f where f.folder_id = p_folder_id and f.name = v_name) then
      begin
        insert into public.project_files (id, project_id, folder_id, name, size, content_type, source, agent_instance_id, run_id)
        values (p_file_id, p_project_id, p_folder_id, v_name, v_size, v_type, p_source, p_instance_id, p_run_id)
        returning * into v_row;
        return v_row;
      exception when unique_violation then
        -- 只有同名才換下一個序號；檔案 id 重複登記照樣報錯
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'project_files_folder_name' then
          raise;
        end if;
      end;
    end if;
    v_n := v_n + 1;
    v_name := public.numbered_name(p_name, v_n);
  end loop;
end $$;

-- runtime 交付：只能交付到本專案顧問自己的資料夾底下
create or replace function public.deliver_project_file(
  p_file_id uuid, p_instance_id uuid, p_subfolder text, p_name text, p_run_id uuid
) returns table (id uuid, name text, folder text, size bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid := public.runtime_project();
  v_instance_name text;
  v_folder uuid;
  v_path text;
  v_part text;
  v_file public.project_files;
begin
  if v_project is null then
    raise exception 'not allowed';
  end if;
  select i.name into v_instance_name from public.agent_instances i
   where i.id = p_instance_id and i.project_id = v_project and i.role = 'consultant';
  if not found then
    raise exception 'not allowed';
  end if;
  if p_run_id is not null and not exists (
    select 1 from public.runs r join public.threads t on t.id = r.thread_id
     where r.id = p_run_id and t.project_id = v_project
  ) then
    raise exception 'not allowed';
  end if;
  if not public.is_entry_name(p_name) then
    raise exception 'invalid name';
  end if;

  v_path := public.safe_entry_name(v_instance_name);
  v_folder := public.ensure_folder(v_project, null, v_path);
  if coalesce(p_subfolder, '') <> '' then
    foreach v_part in array string_to_array(p_subfolder, '/') loop
      if not public.is_entry_name(v_part) then
        raise exception 'invalid folder';
      end if;
      v_folder := public.ensure_folder(v_project, v_folder, v_part);
      v_path := v_path || '/' || v_part;
    end loop;
  end if;

  v_file := public.register_project_file(v_project, p_file_id, v_folder, p_name, 'agent', p_instance_id, p_run_id);
  return query select v_file.id, v_file.name, v_path, v_file.size;
end $$;

revoke execute on function public.ensure_folder(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.register_project_file(uuid, uuid, uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.deliver_project_file(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.ensure_folder(uuid, uuid, text) to service_role;
grant execute on function public.register_project_file(uuid, uuid, uuid, text, text, uuid, uuid) to service_role;
grant execute on function public.deliver_project_file(uuid, uuid, text, text, uuid) to authenticated;

-- runtime 權限（docs/security-model.md 第 4 節）：只讀自己專案；登記一律走 deliver_project_file
grant select (id, project_id, parent_id, name, created_at) on public.project_folders to authenticated;
grant select (id, project_id, folder_id, name, size, content_type, source, agent_instance_id, run_id, created_at, updated_at)
  on public.project_files to authenticated;
drop policy if exists runtime_read on public.project_folders;
create policy runtime_read on public.project_folders for select to authenticated
  using (project_id = public.runtime_project());
drop policy if exists runtime_read on public.project_files;
create policy runtime_read on public.project_files for select to authenticated
  using (project_id = public.runtime_project());

-- Storage：單檔 50 MB；runtime 只能新增到自己專案的 files/ 底下，不能覆蓋或刪除
update storage.buckets set file_size_limit = 52428800 where id = 'project-files';
drop policy if exists runtime_insert_project_files on storage.objects;
create policy runtime_insert_project_files on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files' and name like public.runtime_project()::text || '/files/%');

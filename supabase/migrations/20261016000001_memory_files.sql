-- 記憶改成 Claude Code 的做法：一筆一件事，有名稱、一行說明、類型；runtime 可以更新與刪除。
-- 規格：docs/superpowers/specs/2026-10-16-skills-and-memory-design.md §4
-- 可重複執行：先在 Dashboard SQL Editor 手動套用，之後 db:push 再跑一次也不會出錯。

alter table public.memories
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists type text;

-- 既有記憶回填，遷移後在記憶面板與 prompt 索引都看得到
update public.memories set
  name = 'memory-' || left(id::text, 8),
  description = left(btrim(regexp_replace(content, '\s+', ' ', 'g')), 100),
  type = 'user'
where name is null;
-- 內容全是空白的舊記憶，說明至少要有一個字
update public.memories set description = '（空白）' where description = '';

alter table public.memories
  alter column name set not null,
  alter column description set not null,
  alter column type set not null,
  drop constraint if exists memories_name_check,
  drop constraint if exists memories_description_check,
  drop constraint if exists memories_type_check,
  drop constraint if exists memories_content_check,
  drop constraint if exists memories_owner_name,
  add constraint memories_name_check check (char_length(name) between 1 and 64 and name !~ '[\r\n]'),
  add constraint memories_description_check check (char_length(description) between 1 and 200),
  add constraint memories_type_check check (type in ('user', 'feedback', 'project', 'reference')),
  add constraint memories_content_check check (char_length(content) <= 5000),
  -- 私有（instance_id = 顧問）與專案共用（instance_id is null）是不同的名稱空間
  add constraint memories_owner_name unique nulls not distinct (project_id, instance_id, name);

drop index if exists public.memories_project_created;
create index if not exists memories_project_updated on public.memories (project_id, updated_at desc);

-- runtime 權限（docs/security-model.md 第 4 節）：讀、新增、改內容與說明、刪除，都只限自己專案
revoke select, insert, update, delete on public.memories from authenticated;
grant select (id, project_id, instance_id, name, description, type, content, created_at, updated_at)
  on public.memories to authenticated;
grant insert (project_id, instance_id, name, description, type, content, created_by_instance_id)
  on public.memories to authenticated;
grant update (content, description, type, updated_at) on public.memories to authenticated;
grant delete on public.memories to authenticated;
drop policy if exists runtime_update on public.memories;
create policy runtime_update on public.memories for update to authenticated
  using (project_id = public.runtime_project())
  with check (project_id = public.runtime_project());
drop policy if exists runtime_delete on public.memories;
create policy runtime_delete on public.memories for delete to authenticated
  using (project_id = public.runtime_project());

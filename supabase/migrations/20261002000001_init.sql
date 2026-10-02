-- 使用者
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 創作者上架的範本
create table public.agent_templates (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text not null default '',
  category text not null default '',
  system_prompt text not null default '',
  skills_zip_path text,
  skills jsonb not null default '[]'::jsonb,
  mcp_servers jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 專案（一個專案一台 Sprite）
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  sprite_name text,
  sprite_url text,
  sprite_status text not null default 'provisioning'
    check (sprite_status in ('provisioning', 'ready', 'error')),
  sprite_error text,
  created_at timestamptz not null default now()
);

-- 專案裡的 agent（啟用當下的快照）
create table public.agent_instances (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  template_id uuid references public.agent_templates (id) on delete set null,
  role text not null check (role in ('consultant', 'manager')),
  name text not null,
  system_prompt text not null default '',
  skills_zip_path text,
  skills jsonb not null default '[]'::jsonb,
  mcp_servers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create unique index one_manager_per_project
  on public.agent_instances (project_id) where role = 'manager';

-- 租用者填的 MCP 金鑰（實際值在 Vault）
create table public.instance_secrets (
  instance_id uuid not null references public.agent_instances (id) on delete cascade,
  mcp_name text not null,
  key text not null,
  vault_secret_id uuid not null,
  primary key (instance_id, mcp_name, key)
);

-- 對話
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null default '新對話',
  created_at timestamptz not null default now()
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index one_running_run_per_thread
  on public.runs (thread_id) where status = 'running';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id) on delete cascade,
  run_id uuid references public.runs (id) on delete cascade,
  speaker_instance_id uuid references public.agent_instances (id) on delete set null,
  kind text not null check (kind in ('user', 'final', 'delegation', 'discussion')),
  round int,
  content text not null default '',
  ui_message jsonb,
  tool_events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_thread_created on public.messages (thread_id, created_at);

-- 記憶：instance_id 為 null 代表專案共用
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  instance_id uuid references public.agent_instances (id) on delete cascade,
  content text not null,
  created_by_instance_id uuid references public.agent_instances (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memories_project_created on public.memories (project_id, created_at desc);

-- 用量帳本：刻意不加外鍵，專案或 agent 刪除後帳本仍保留
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  project_id uuid not null,
  instance_id uuid,
  template_id uuid,
  creator_id uuid,
  model text not null,
  prompt_tokens int not null default 0,
  output_tokens int not null default 0,
  cached_tokens int not null default 0,
  thought_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index usage_events_creator_created on public.usage_events (creator_id, created_at);

-- 全部開 RLS、不設規則：只有 service role 能讀寫
alter table public.profiles enable row level security;
alter table public.agent_templates enable row level security;
alter table public.projects enable row level security;
alter table public.agent_instances enable row level security;
alter table public.instance_secrets enable row level security;
alter table public.threads enable row level security;
alter table public.runs enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.usage_events enable row level security;

-- Storage buckets（私有）
insert into storage.buckets (id, name, public) values
  ('skills', 'skills', false),
  ('project-files', 'project-files', false),
  ('runtime', 'runtime', false)
on conflict (id) do nothing;

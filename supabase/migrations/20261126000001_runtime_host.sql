-- 專案與代管 MCP 版本記錄跑在哪個執行環境（sprite 或 e2b），host_token 供 e2b 存取沙盒用，不可給瀏覽器或 runtime 角色讀
alter table public.projects
  add column if not exists host text not null default 'sprite' check (host in ('sprite', 'e2b')),
  add column if not exists host_token text;

alter table public.hosted_mcp_versions
  add column if not exists host text not null default 'sprite' check (host in ('sprite', 'e2b')),
  add column if not exists host_token text;

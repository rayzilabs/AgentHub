begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(8);

select has_table('public', 'remote_mcp_targets', '有 remote_mcp_targets');
select has_table('public', 'mcp_usage', '有 mcp_usage');
select ok((select relrowsecurity from pg_class where oid = 'public.remote_mcp_targets'::regclass), 'remote_mcp_targets 開啟 RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mcp_usage'::regclass), 'mcp_usage 開啟 RLS');
select ok(
  not has_table_privilege('authenticated', 'public.remote_mcp_targets', 'select')
  and not has_table_privilege('anon', 'public.remote_mcp_targets', 'select')
  and not has_table_privilege('authenticated', 'public.mcp_usage', 'insert'),
  '一般使用者沒有這兩張表的權限');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'creator@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'renter@test.local');

insert into public.agent_templates (id, creator_id, name, system_prompt, mcp_servers, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', '金融顧問', '你是金融顧問',
   '[{"name":"fin","transport":"remote","url":"https://c.example/mcp"},{"name":"web","transport":"http","url":"https://w.example/mcp"}]',
   'published');

insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000002', 'demo');

select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '{}'::jsonb) $$,
  '含 remote 型 MCP 的範本可以啟用');
select is(
  (select mcp_servers from public.agent_instances where project_id = '00000000-0000-0000-0000-0000000000b1'),
  '[{"name":"fin","transport":"remote"},{"name":"web","transport":"http","url":"https://w.example/mcp"}]'::jsonb,
  '顧問設定裡 remote 型不留網址，其他型照舊');
select results_eq(
  $$ select r.mcp_name, r.kind, r.url from public.remote_mcp_targets r
       join public.agent_instances i on i.id = r.instance_id
      where i.project_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values ('fin'::text, 'self'::text, 'https://c.example/mcp'::text) $$,
  '創作者網址搬到 remote_mcp_targets');

select * from finish();
rollback;

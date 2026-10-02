begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'creator@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'renter@test.local');

insert into public.agent_templates (id, creator_id, name, system_prompt, skills_zip_path, skills, mcp_servers, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001',
   '法務顧問', '你是法務', 'a1/abc.zip',
   '[{"name":"contract","description":"審合約","path":"contract"}]',
   '[{"name":"finmind","transport":"stdio","command":"npx","args":["finmind-mcp"],"required_secrets":[{"key":"FINMIND_API_KEY","description":"FinMind token"}]}]',
   'published'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001',
   '財務顧問', '你是財務', null, '[]', '[]', 'published'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001',
   '草稿', '', null, '[]', '[]', 'draft');

insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000002', 'demo');

-- 缺金鑰：整筆撤銷
select throws_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '{}'::jsonb) $$,
  '22023',
  'missing secret finmind.FINMIND_API_KEY',
  '缺必要金鑰時拒絕');
select is(
  (select count(*)::int from public.agent_instances where project_id = '00000000-0000-0000-0000-0000000000b1'),
  0,
  '缺金鑰時不留下任何 agent');

-- 草稿範本不能啟用
select throws_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', '{}'::jsonb) $$,
  'P0002',
  null,
  '草稿範本不能啟用');

-- 成功啟用：複製快照、存金鑰
select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
       '{"finmind":{"FINMIND_API_KEY":"k-123"}}'::jsonb) $$,
  '填好金鑰後可以啟用');
select results_eq(
  $$ select name, system_prompt, skills_zip_path, role from public.agent_instances
     where project_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values ('法務顧問'::text, '你是法務'::text, 'a1/abc.zip'::text, 'consultant'::text) $$,
  '從範本複製快照');
select is(
  (select value from public.get_project_secrets('00000000-0000-0000-0000-0000000000b1')),
  'k-123',
  '金鑰可以透過 get_project_secrets 讀回');
select is(
  (select count(*)::int from public.agent_instances
    where project_id = '00000000-0000-0000-0000-0000000000b1' and role = 'manager'),
  0,
  '只有 1 位顧問時沒有主管');

-- 第 2 位顧問：自動建立主管
select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', '{}'::jsonb) $$,
  '啟用第 2 位顧問');
select is(
  (select count(*)::int from public.agent_instances
    where project_id = '00000000-0000-0000-0000-0000000000b1' and role = 'manager'),
  1,
  '第 2 位顧問加入時自動建立主管');

-- 第 3 位顧問：主管仍只有一位
select lives_ok(
  $$ select public.hire_agent('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', '{}'::jsonb) $$,
  '啟用第 3 位顧問');
select is(
  (select count(*)::int from public.agent_instances
    where project_id = '00000000-0000-0000-0000-0000000000b1' and role = 'manager'),
  1,
  '主管只會有一位');

-- 快照不受範本修改影響
update public.agent_templates set system_prompt = '改過' where id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select system_prompt from public.agent_instances where template_id = '00000000-0000-0000-0000-0000000000a1'),
  '你是法務',
  '修改範本不影響已啟用的 agent');

-- 權限
select ok(
  not has_function_privilege('anon', 'public.hire_agent(uuid, uuid, jsonb)', 'execute'),
  'anon 不能執行 hire_agent');
select ok(
  not has_function_privilege('authenticated', 'public.get_project_secrets(uuid)', 'execute'),
  'authenticated 不能執行 get_project_secrets');

select * from finish();
rollback;

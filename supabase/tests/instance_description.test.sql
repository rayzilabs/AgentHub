begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(2);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'creator-d@test.local'),
  ('00000000-0000-0000-0000-0000000000d2', 'renter-d@test.local');
insert into public.agent_templates (id, creator_id, name, description, status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', '財務顧問', '擅長財報分析與估值', 'published');
insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d2', 'p');

select public.hire_agent('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', '{}'::jsonb);

select is(
  (select description from public.agent_instances where project_id = '00000000-0000-0000-0000-0000000000f1'),
  '擅長財報分析與估值',
  '啟用時複製範本的介紹');

select ok(
  not has_function_privilege('anon', 'public.hire_agent(uuid, uuid, jsonb)', 'execute'),
  '重新定義後 anon 仍不能執行 hire_agent');

select * from finish();
rollback;

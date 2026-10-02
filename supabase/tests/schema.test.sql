begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(5);

select ok(
  (select bool_and(c.relrowsecurity)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  'public 底下所有資料表都開啟 RLS');

select is(
  (select count(*)::int from pg_policies where schemaname = 'public'),
  0,
  'public 沒有任何 RLS 規則（一律拒絕直接存取）');

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');

select is(
  (select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  1,
  '新使用者自動建立 profile');

insert into public.projects (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'p');
insert into public.threads (id, project_id)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1');
insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000c1');

select throws_ok(
  $$ insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000c1') $$,
  '23505',
  null,
  '同一串對話不能同時有兩個 running 的 run');

select results_eq(
  $$ select id from storage.buckets where id in ('skills', 'project-files', 'runtime') order by id $$,
  $$ values ('project-files'::text), ('runtime'::text), ('skills'::text) $$,
  '三個 Storage bucket 都存在');

select * from finish();
rollback;

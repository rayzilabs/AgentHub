begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path to public, extensions;
select plan(3);

select has_column('public', 'messages', 'updated_at', 'messages 有 updated_at');
select col_not_null('public', 'messages', 'updated_at', 'updated_at 不可為 null');
select col_has_default('public', 'messages', 'updated_at', 'updated_at 有預設值');

select * from finish();
rollback;

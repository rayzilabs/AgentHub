-- 子專案 1-C 的權限驗證：runtime 帳號只限自己專案，一般使用者（含專案擁有者）什麼都讀不到。
-- 純 SQL 斷言，可在本機 Postgres（加上 Supabase 替身）或 Supabase Dashboard 的 SQL Editor 執行；最後 rollback，不留資料。
begin;

-- 準備資料（以 postgres 身分）
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'creator@test.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner@test.local');
insert into public.agent_templates (id, creator_id, name, system_prompt, status)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 't', 'SECRET PROMPT', 'published');
insert into public.projects (id, owner_id, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c2', 'mine'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c2', 'other');
insert into public.agent_instances (id, project_id, template_id, role, name, system_prompt, skills_zip_path) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'consultant', 'x', 'SECRET PROMPT', 'a1/x.zip'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b2', null, 'consultant', 'y', 'OTHER', 'a1/y.zip');
insert into public.threads (id, project_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b2');
insert into public.runs (id, thread_id, status) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'succeeded');
insert into public.messages (id, thread_id, run_id, kind, content) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'final', 'done');
insert into storage.objects (bucket_id, name) values
  ('skills', 'a1/x.zip'), ('skills', 'a1/y.zip'),
  ('project-files', '00000000-0000-0000-0000-0000000000b1/a.txt'),
  ('project-files', '00000000-0000-0000-0000-0000000000b2/b.txt');

-- runtime 身分（專案 b1）
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"agenthub_runtime_project":"00000000-0000-0000-0000-0000000000b1"}}';
do $$ begin
  assert (select count(*) from public.agent_instances) = 1, 'runtime 只看得到自己專案的顧問';
  assert (select system_prompt from public.agent_instances) = 'SECRET PROMPT', 'runtime 讀得到 system prompt';
  assert (select count(*) from public.agent_templates) = 1, 'runtime 看得到自己顧問的範本';
  assert (select count(*) from public.threads) = 1, 'runtime 只看得到自己專案的對話';
  assert (select array_agg(name order by name) from storage.objects where bucket_id = 'skills') = array['a1/x.zip'], 'runtime 只讀得到自己顧問的 skill zip';
  assert (select array_agg(name order by name) from storage.objects where bucket_id = 'project-files')
         = array['00000000-0000-0000-0000-0000000000b1/a.txt'], 'runtime 只讀得到自己專案的檔案';
end $$;
insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000e1');
do $$ begin
  begin
    insert into public.runs (thread_id) values ('00000000-0000-0000-0000-0000000000e2');
    assert false, '不能替別的專案建立 run';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    perform system_prompt from public.agent_templates;
    assert false, '不能讀範本的 system prompt';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.usage_events;
    assert false, '不能讀用量帳本';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.projects;
    assert false, '不能讀專案表';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.project_runtime_accounts;
    assert false, '不能讀 runtime 帳號表';
  exception when insufficient_privilege then null;
  end;
end $$;
-- 已結束 run 的 final 改不了、刪不了（被規則過濾掉，影響 0 列）
update public.messages set content = 'hacked' where id = '00000000-0000-0000-0000-000000000011';
delete from public.messages where id = '00000000-0000-0000-0000-000000000011';
do $$ begin
  assert (select content from public.messages where id = '00000000-0000-0000-0000-000000000011') = 'done', '已結束的回覆不能被改或刪';
end $$;
insert into public.usage_events (project_id, model) values ('00000000-0000-0000-0000-0000000000b1', 'm');
do $$ begin
  begin
    insert into public.usage_events (project_id, model) values ('00000000-0000-0000-0000-0000000000b2', 'm');
    assert false, '不能替別的專案記用量';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.get_project_secrets('00000000-0000-0000-0000-0000000000b1')) = 0, '可以取自己專案的金鑰（這裡沒有）';
  begin
    perform 1 from public.get_project_secrets('00000000-0000-0000-0000-0000000000b2');
    assert false, '不能取別的專案的金鑰';
  exception when raise_exception then null;
  end;
end $$;

-- 一般使用者身分（專案擁有者本人，沒有 runtime 標記）
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated","app_metadata":{"provider":"email"}}';
do $$ begin
  assert (select count(*) from public.agent_instances) = 0, '一般使用者讀不到顧問（含 system prompt）';
  assert (select count(*) from public.messages) = 0, '一般使用者讀不到訊息';
  assert (select count(*) from storage.objects where bucket_id = 'skills') = 0, '一般使用者讀不到 skill zip';
  begin
    perform 1 from public.get_project_secrets('00000000-0000-0000-0000-0000000000b1');
    assert false, '一般使用者不能取金鑰';
  exception when raise_exception then null;
  end;
end $$;

-- 匿名（只有公開金鑰）
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
do $$ begin
  begin
    perform 1 from public.agent_instances;
    assert false, '匿名不能讀顧問';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;

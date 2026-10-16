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
insert into public.memories (id, project_id, name, description, type, content) values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000b1', 'm', '我的', 'user', '我的記憶'),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-0000000000b2', 'm', '別人的', 'user', '別人的記憶'),
  ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-0000000000b1', 'gone', '要刪的', 'user', '要刪的記憶');

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
-- 記憶：自己專案可改內容、說明、類型，可刪；別的專案的被規則過濾掉（影響 0 列）
update public.memories set content = '新', description = '新說明', type = 'feedback' where name = 'm';
delete from public.memories where name = 'gone';
delete from public.memories where id = '00000000-0000-0000-0000-000000000022';
do $$ begin
  assert (select content from public.memories where id = '00000000-0000-0000-0000-000000000021') = '新', 'runtime 改得了自己專案的記憶';
  assert (select count(*) from public.memories where name = 'gone') = 0, 'runtime 刪得了自己專案的記憶';
  begin
    update public.memories set name = 'x';
    assert false, '不能改記憶名稱';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.memories set updated_at = now();
    assert false, 'updated_at 由觸發器維護，runtime 不能直接改';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.memories set instance_id = null;
    assert false, '不能改記憶的歸屬顧問';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.memories set project_id = '00000000-0000-0000-0000-0000000000b2';
    assert false, '不能把記憶搬到別的專案';
  exception when insufficient_privilege then null;
  end;
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
update public.memories set content = '使用者改的';
delete from public.memories;

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

-- 回到 postgres 檢查：別的專案的記憶沒被 runtime 動到，一般使用者也改不到、刪不到
set local role postgres;
do $$ begin
  assert (select content from public.memories where id = '00000000-0000-0000-0000-000000000022') = '別人的記憶', 'runtime 改不到、刪不到別的專案的記憶';
  assert (select content from public.memories where id = '00000000-0000-0000-0000-000000000021') = '新', '一般使用者不能直接改或刪記憶';
end $$;

rollback;

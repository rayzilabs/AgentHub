-- 子專案 3b 驗證：代管 MCP 的版本鎖定、金鑰、權限。純 SQL 斷言，可在本機 Postgres（加上 Supabase 替身）或 Dashboard 的 SQL Editor 執行；最後 rollback。
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000003c1', 'creator@test.local'),
  ('00000000-0000-0000-0000-0000000003c2', 'renter@test.local');
insert into public.agent_templates (id, creator_id, name, system_prompt, status, mcp_servers) values
  ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000003c1', '代管顧問', 'p', 'published',
   '[{"name":"fin","transport":"remote","hosted":true},{"name":"web","transport":"remote","url":"https://c.example/mcp"}]');
insert into public.projects (id, owner_id, name) values
  ('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003c2', 'p1'),
  ('00000000-0000-0000-0000-0000000003b2', '00000000-0000-0000-0000-0000000003c2', 'p2');

-- 沒有已發布版本：不能租用
do $$ begin
  begin
    perform public.hire_agent('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003a1', '{}'::jsonb);
    assert false, '沒有已發布版本不能租用';
  exception when raise_exception then
    assert sqlerrm like 'hosted mcp fin%', '錯誤訊息要指出是哪個 MCP：' || sqlerrm;
  end;
end $$;

insert into public.hosted_mcp_versions (id, template_id, mcp_name, version, status, bundle_path) values
  ('00000000-0000-0000-0000-0000000003e1', '00000000-0000-0000-0000-0000000003a1', 'fin', 1, 'published', 'a/fin/1.zip'),
  ('00000000-0000-0000-0000-0000000003e2', '00000000-0000-0000-0000-0000000003a1', 'fin', 2, 'ready', 'a/fin/2.zip');

do $$
declare v_inst uuid;
begin
  v_inst := public.hire_agent('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003a1', '{}'::jsonb);
  assert (select hosted_version_id from public.remote_mcp_targets where instance_id = v_inst and mcp_name = 'fin')
         = '00000000-0000-0000-0000-0000000003e1', '鎖定最新的已發布版本（ready 的版本 2 不算）';
  assert (select kind from public.remote_mcp_targets where instance_id = v_inst and mcp_name = 'fin') = 'hosted', 'kind 是 hosted';
  assert (select url from public.remote_mcp_targets where instance_id = v_inst and mcp_name = 'fin') is null, '代管不存網址';
  assert (select url from public.remote_mcp_targets where instance_id = v_inst and mcp_name = 'web') = 'https://c.example/mcp', '自己架的照舊';
  assert (select mcp_servers from public.agent_instances where id = v_inst)
         = '[{"name":"fin","transport":"remote"},{"name":"web","transport":"remote"}]'::jsonb, '顧問設定不留 hosted 與網址';
end $$;

-- 版本 2 發布後，新租用指向版本 2，舊顧問仍是版本 1
update public.hosted_mcp_versions set status = 'published' where id = '00000000-0000-0000-0000-0000000003e2';
do $$
declare v_inst uuid;
begin
  v_inst := public.hire_agent('00000000-0000-0000-0000-0000000003b2', '00000000-0000-0000-0000-0000000003a1', '{}'::jsonb);
  assert (select hosted_version_id from public.remote_mcp_targets where instance_id = v_inst and mcp_name = 'fin')
         = '00000000-0000-0000-0000-0000000003e2', '新租用鎖定版本 2';
  assert (select count(*) from public.remote_mcp_targets where hosted_version_id = '00000000-0000-0000-0000-0000000003e1') = 1,
         '舊顧問仍指向版本 1';
  begin
    delete from public.hosted_mcp_versions where id = '00000000-0000-0000-0000-0000000003e1';
    assert false, '還有顧問在用的版本不能刪';
  exception when foreign_key_violation then null;
  end;
end $$;

-- 金鑰：更新而不是重複
select public.set_hosted_mcp_secret('00000000-0000-0000-0000-0000000003a1', 'fin', 'API_KEY', 'v1');
select public.set_hosted_mcp_secret('00000000-0000-0000-0000-0000000003a1', 'fin', 'API_KEY', 'v2');
do $$ begin
  assert (select array_agg(key || '=' || value) from public.get_hosted_mcp_secrets('00000000-0000-0000-0000-0000000003a1', 'fin'))
         = array['API_KEY=v2'], '金鑰更新後只有一筆、值是新的';
end $$;

-- 一般登入身分碰不到
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000003c1","role":"authenticated"}';
do $$ begin
  begin perform 1 from public.hosted_mcp_versions; assert false, '不能讀版本表';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.hosted_mcp_secrets; assert false, '不能讀金鑰表';
  exception when insufficient_privilege then null; end;
  begin perform public.get_hosted_mcp_secrets('00000000-0000-0000-0000-0000000003a1', 'fin'); assert false, '不能取金鑰';
  exception when insufficient_privilege then null; end;
  begin perform public.set_hosted_mcp_secret('00000000-0000-0000-0000-0000000003a1', 'fin', 'X', 'y'); assert false, '不能寫金鑰';
  exception when insufficient_privilege then null; end;
end $$;

rollback;

-- 資料權限與同步函式測試。
-- 只能在「測試用」資料庫執行（會暫時建立兩個測試帳號）；整個測試在一個交易中，最後 rollback，不留下資料。
-- 執行：psql "<測試資料庫連線字串>" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
-- 任何一項失敗都會以 ERROR 結束；全部通過時最後會印出「ALL RLS TESTS PASSED」。

begin;

-- 測試帳號 A、B
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@example.test', '', now(), now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@example.test', '', now(), now());

-- ===== 未登入（anon）不能讀寫 =====
set local role anon;
do $$
begin
  begin
    perform 1 from public.records;
    raise exception 'FAIL: anon 可以讀取 records';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sync_push('[]'::jsonb, null);
    raise exception 'FAIL: anon 可以呼叫 sync_push';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: 未登入不能讀寫';
end $$;
reset role;

-- ===== 帳號 B 先建立一筆資料 =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.sync_push('[{"collection":"tasks","id":"t_b1","base_rev":null,"deleted":false,"data":{"id":"t_b1","title":"B 的任務"}}]'::jsonb, 'device-b');
  if r -> 0 ->> 'status' <> 'applied' or (r -> 0 ->> 'rev')::int <> 1 then raise exception 'FAIL: B 新增失敗 %', r; end if;
  raise notice 'PASS: B 透過 sync_push 新增';
end $$;

-- ===== 帳號 A：只能存取自己的資料 =====
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare
  r jsonb;
  n int;
begin
  -- 新增（直接寫入資料表與透過同步函式）
  insert into public.records (collection, id, data) values ('tasks', 't_a1', '{"id":"t_a1","title":"A 的任務"}');
  r := public.sync_push('[{"collection":"habits","id":"h_a1","base_rev":null,"deleted":false,"data":{"id":"h_a1","name":"A 的習慣"}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' then raise exception 'FAIL: A 新增失敗 %', r; end if;

  -- 讀取：只看得到自己的
  select count(*) into n from public.records;
  if n <> 2 then raise exception 'FAIL: A 應只看到自己的 2 筆，實際 %', n; end if;
  select count(*) into n from public.records where id = 't_b1';
  if n <> 0 then raise exception 'FAIL: A 看得到 B 的資料'; end if;
  raise notice 'PASS: 讀取只看得到自己的資料';

  -- 不能以別人的身分新增
  begin
    insert into public.records (user_id, collection, id, data) values ('bbbbbbbb-0000-4000-8000-000000000002', 'tasks', 't_fake', '{"id":"t_fake"}');
    raise exception 'FAIL: A 可以替 B 新增資料';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: 不能替其他帳號新增';

  -- 不能修改、刪除別人的資料（RLS 讓這些列「不存在」）
  update public.records set data = '{"id":"t_b1","title":"被竄改"}' where id = 't_b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: A 修改了 B 的資料'; end if;
  delete from public.records where id = 't_b1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: A 刪除了 B 的資料'; end if;
  -- 同步函式以 auth.uid() 為準：同 id 只會寫到 A 自己的資料
  r := public.sync_push('[{"collection":"tasks","id":"t_b1","base_rev":1,"deleted":true,"data":null}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' or r -> 0 ->> 'rev' is not null then raise exception 'FAIL: 同步函式影響到 B 的資料 %', r; end if;
  raise notice 'PASS: 不能修改或刪除其他帳號的資料';

  -- 不能把自己的資料改成別人的
  begin
    update public.records set user_id = 'bbbbbbbb-0000-4000-8000-000000000002' where id = 't_a1';
    raise exception 'FAIL: 可以把資料轉給其他帳號';
  exception when insufficient_privilege then null;
  end;

  -- 修改與刪除自己的資料
  update public.records set data = '{"id":"t_a1","title":"A 改名"}' where id = 't_a1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: A 不能修改自己的資料'; end if;
  if (select rev from public.records where id = 't_a1') <> 2 then raise exception 'FAIL: 修改後 rev 應為 2'; end if;
  raise notice 'PASS: 可以修改自己的資料（rev 自動加 1）';

  -- 序號計數表無法直接存取
  begin
    perform 1 from public.sync_counters;
    raise exception 'FAIL: 可以讀取 sync_counters';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: 序號計數表無法直接存取';
end $$;

-- ===== 同步規則：衝突、重試、刪除標記 =====
do $$
declare
  r jsonb;
  s1 bigint;
  s2 bigint;
begin
  -- 版本一致：套用
  r := public.sync_push('[{"collection":"tasks","id":"t_a1","base_rev":2,"deleted":false,"data":{"id":"t_a1","title":"第三版"}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' or (r -> 0 ->> 'rev')::int <> 3 then raise exception 'FAIL: 版本一致時應套用 %', r; end if;
  -- 重試同一筆（例如上次回應遺失）：視為成功，版本不變
  r := public.sync_push('[{"collection":"tasks","id":"t_a1","base_rev":2,"deleted":false,"data":{"id":"t_a1","title":"第三版"}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' or (r -> 0 ->> 'rev')::int <> 3 then raise exception 'FAIL: 重試應視為成功 %', r; end if;
  raise notice 'PASS: 重試不會重複套用';
  -- 另一台裝置用舊版本修改：衝突，回傳雲端版本，不覆蓋
  r := public.sync_push('[{"collection":"tasks","id":"t_a1","base_rev":2,"deleted":false,"data":{"id":"t_a1","title":"舊裝置的修改"}}]'::jsonb, 'device-c');
  if r -> 0 ->> 'status' <> 'conflict' or r -> 0 -> 'server' -> 'data' ->> 'title' <> '第三版' then raise exception 'FAIL: 舊版本應回報衝突 %', r; end if;
  if (select data ->> 'title' from public.records where id = 't_a1') <> '第三版' then raise exception 'FAIL: 衝突時被覆蓋'; end if;
  raise notice 'PASS: 版本不一致時回報衝突，不無聲覆蓋';
  -- 同一個 id 兩台裝置各自新增：第二台回報衝突
  r := public.sync_push('[{"collection":"tasks","id":"t_a1","base_rev":null,"deleted":false,"data":{"id":"t_a1","title":"另一台新增"}}]'::jsonb, 'device-c');
  if r -> 0 ->> 'status' <> 'conflict' then raise exception 'FAIL: 同 id 重複新增應衝突 %', r; end if;
  -- 刪除：標記刪除，舊版本的修改不會讓它復活
  r := public.sync_push('[{"collection":"tasks","id":"t_a1","base_rev":3,"deleted":true,"data":null}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' or not (select deleted from public.records where id = 't_a1') then raise exception 'FAIL: 刪除失敗 %', r; end if;
  r := public.sync_push('[{"collection":"tasks","id":"t_a1","base_rev":3,"deleted":false,"data":{"id":"t_a1","title":"舊資料"}}]'::jsonb, 'device-c');
  if r -> 0 ->> 'status' <> 'conflict' or (r -> 0 -> 'server' ->> 'deleted')::boolean is not true then raise exception 'FAIL: 舊資料應與刪除衝突 %', r; end if;
  raise notice 'PASS: 刪除會同步，舊資料不會重新出現';
  -- 序號遞增
  select seq into s1 from public.records where id = 'h_a1';
  select seq into s2 from public.records where id = 't_a1';
  if s2 <= s1 then raise exception 'FAIL: 序號應遞增'; end if;
  -- 資料 id 必須一致
  r := public.sync_push('[{"collection":"tasks","id":"t_x","base_rev":null,"deleted":false,"data":{"id":"t_other"}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'invalid' then raise exception 'FAIL: id 不一致應拒絕 %', r; end if;
  -- 不支援的集合
  r := public.sync_push('[{"collection":"secrets","id":"x","base_rev":null,"deleted":false,"data":{"id":"x"}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'invalid' then raise exception 'FAIL: 不支援的集合被接受 %', r; end if;
  r := public.sync_push('[{"collection":"tasks","id":"bad id!","base_rev":null,"deleted":false,"data":{"id":"bad id!"}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'invalid' then raise exception 'FAIL: 不合法的 id 被接受 %', r; end if;
  raise notice 'PASS: 拒絕不正確的資料';
end $$;

-- ===== 獎勵帳本：不可修改、兌換檢查餘額 =====
do $$
declare r jsonb;
begin
  r := public.sync_push('[{"collection":"ledger","id":"l_task_t1_0","base_rev":null,"deleted":false,"data":{"id":"l_task_t1_0","kind":"award","coins":10,"xp":20}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' then raise exception 'FAIL: 帳本新增 %', r; end if;
  -- 兩台裝置對同一來源各自結算（相同 id）：只入帳一次
  r := public.sync_push('[{"collection":"ledger","id":"l_task_t1_0","base_rev":null,"deleted":false,"data":{"id":"l_task_t1_0","kind":"award","coins":10,"xp":20}}]'::jsonb, 'device-c');
  if r -> 0 ->> 'status' <> 'applied' or (r -> 0 ->> 'rev')::int <> 1 then raise exception 'FAIL: 相同帳本紀錄應視為已存在 %', r; end if;
  if (select count(*) from public.records where collection = 'ledger') <> 1 then raise exception 'FAIL: 帳本重複入帳'; end if;
  raise notice 'PASS: 同一筆獎勵只入帳一次';
  -- 不能修改帳本內容
  r := public.sync_push('[{"collection":"ledger","id":"l_task_t1_0","base_rev":1,"deleted":false,"data":{"id":"l_task_t1_0","kind":"award","coins":9999,"xp":20}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'conflict' then raise exception 'FAIL: 帳本被修改 %', r; end if;
  begin
    update public.records set data = '{"id":"l_task_t1_0","kind":"award","coins":9999}' where id = 'l_task_t1_0';
    raise exception 'FAIL: 可以直接修改帳本';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS: 帳本紀錄不可修改';
  -- 兌換：餘額 10，兌換 8 成功；再兌換 8（另一台裝置）被拒絕
  r := public.sync_push('[{"collection":"ledger","id":"l_rd_1","base_rev":null,"deleted":false,"data":{"id":"l_rd_1","kind":"redeem","coins":-8,"xp":0}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' then raise exception 'FAIL: 兌換失敗 %', r; end if;
  r := public.sync_push('[{"collection":"ledger","id":"l_rd_2","base_rev":null,"deleted":false,"data":{"id":"l_rd_2","kind":"redeem","coins":-8,"xp":0}}]'::jsonb, 'device-c');
  if r -> 0 ->> 'status' <> 'rejected' or r -> 0 ->> 'reason' <> 'insufficient_coins' then raise exception 'FAIL: 餘額不足仍可兌換 %', r; end if;
  -- 重試已成功的兌換：不會重複扣
  r := public.sync_push('[{"collection":"ledger","id":"l_rd_1","base_rev":null,"deleted":false,"data":{"id":"l_rd_1","kind":"redeem","coins":-8,"xp":0}}]'::jsonb, 'device-a');
  if r -> 0 ->> 'status' <> 'applied' or (select count(*) from public.records where id like 'l_rd_%') <> 1 then raise exception 'FAIL: 兌換重試重複扣款 %', r; end if;
  raise notice 'PASS: 兌換在雲端檢查餘額，重試不重複扣';
end $$;

-- ===== B 的資料完全沒有被 A 影響 =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.records) <> 1 or (select data ->> 'title' from public.records where id = 't_b1') <> 'B 的任務' or (select deleted from public.records where id = 't_b1') then
    raise exception 'FAIL: B 的資料被影響';
  end if;
  raise notice 'PASS: 其他帳號的資料不受影響';
  raise notice 'ALL RLS TESTS PASSED';
end $$;

rollback;

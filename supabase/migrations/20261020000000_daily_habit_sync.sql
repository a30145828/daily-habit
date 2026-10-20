-- 每日管理中心：雲端同步資料表、資料權限（RLS）與同步函式。
-- 在 Supabase 專案的 SQL Editor 執行本檔一次即可（或使用 Supabase CLI：supabase db push）。
-- 本檔可重複執行（使用 if not exists / or replace）。
--
-- 設計：
-- - 所有資料存在 public.records，一列 = 一筆資料（任務、習慣、交易…），以 (user_id, collection, id) 為主鍵。
-- - 每個帳號只能讀寫自己的資料（RLS）。
-- - rev：每次修改加 1；用戶端送出修改時附上「看到的版本」，不一致就回報衝突，不會無聲覆蓋。
-- - seq：每個帳號自己的遞增序號（寫入時鎖定計數列），序號順序 = 寫入完成順序，用戶端依序號增量下載。
-- - deleted：刪除只標記（tombstone），讓其他裝置知道要刪除，舊資料不會重新出現。
-- - ledger（獎勵帳本）只能新增或標記刪除，不能修改；兌換（金幣為負）時在交易中檢查餘額，避免重複花用。

-- ---------- 資料表 ----------

create table if not exists public.records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collection text not null check (
    collection in (
      'tasks', 'series', 'habits', 'checkins', 'reviews', 'transactions', 'accounts',
      'categories', 'budgets', 'subscriptions', 'rewards', 'ledger', 'settings'
    )
  ),
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  data jsonb,
  deleted boolean not null default false,
  rev integer not null default 1 check (rev >= 1),
  seq bigint not null default 0,
  device_id text check (device_id is null or char_length(device_id) <= 100),
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, id),
  constraint records_data_present check (deleted or data is not null),
  constraint records_data_size check (data is null or pg_column_size(data) <= 65536)
);

create index if not exists records_user_seq_idx on public.records (user_id, seq);

-- 每個帳號的序號計數（用戶端不能直接存取）
create table if not exists public.sync_counters (
  user_id uuid primary key references auth.users (id) on delete cascade,
  seq bigint not null default 0
);

alter table public.records enable row level security;
alter table public.sync_counters enable row level security;

-- ---------- 資料權限：只能存取自己的資料 ----------

drop policy if exists records_select_own on public.records;
create policy records_select_own on public.records
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists records_insert_own on public.records;
create policy records_insert_own on public.records
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists records_update_own on public.records;
create policy records_update_own on public.records
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists records_delete_own on public.records;
create policy records_delete_own on public.records
  for delete to authenticated using (user_id = (select auth.uid()));

-- sync_counters 沒有任何 policy：用戶端完全無法讀寫，只由下面的觸發函式維護。

revoke all on table public.records from anon, authenticated;
grant select, insert, update, delete on table public.records to authenticated;
revoke all on table public.sync_counters from anon, authenticated;

-- ---------- 觸發：序號、版本、帳本不可修改 ----------

create or replace function public.records_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_seq bigint;
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.collection <> old.collection or new.id <> old.id then
      raise exception 'records: key columns cannot change' using errcode = '42501';
    end if;
    -- 帳本紀錄只能標記刪除，不能修改內容
    if old.collection = 'ledger' and not new.deleted and new.data is distinct from old.data then
      raise exception 'ledger entries are immutable' using errcode = '42501';
    end if;
    new.rev := old.rev + 1;
  else
    new.rev := 1;
  end if;

  -- 鎖定該帳號的計數列直到交易結束，確保序號順序等於寫入完成順序
  insert into public.sync_counters as c (user_id, seq) values (new.user_id, 1)
  on conflict (user_id) do update set seq = c.seq + 1
  returning c.seq into next_seq;

  new.seq := next_seq;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists records_before_write on public.records;
create trigger records_before_write
  before insert or update on public.records
  for each row execute function public.records_before_write();

-- ---------- 同步函式 ----------
-- p_changes：[{ "collection", "id", "base_rev": 版本或 null, "deleted": bool, "data": {...} | null }]
-- 回傳：[{ "collection", "id", "status": "applied" | "conflict" | "rejected" | "invalid", "rev", "seq", "server": {...}, "reason" }]
-- 以呼叫者身分執行（security invoker），因此仍受上面的 RLS 限制。

create or replace function public.sync_push(p_changes jsonb, p_device text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  change jsonb;
  c_collection text;
  c_id text;
  c_base integer;
  c_deleted boolean;
  c_data jsonb;
  cur public.records%rowtype;
  saved public.records%rowtype;
  balance bigint;
  results jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'p_changes must be an array of at most 500 items' using errcode = '22023';
  end if;

  for change in select value from jsonb_array_elements(p_changes) loop
    c_collection := change ->> 'collection';
    c_id := change ->> 'id';
    c_base := (change ->> 'base_rev')::integer;
    c_deleted := coalesce((change ->> 'deleted')::boolean, false);
    c_data := case when c_deleted then null else change -> 'data' end;

    if c_collection is null or c_id is null or (not c_deleted and (c_data is null or jsonb_typeof(c_data) <> 'object')) then
      results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'invalid', 'reason', 'missing fields'));
      continue;
    end if;
    if not c_deleted and c_data ->> 'id' is distinct from c_id then
      results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'invalid', 'reason', 'data.id mismatch'));
      continue;
    end if;

    select * into cur from public.records r
      where r.user_id = uid and r.collection = c_collection and r.id = c_id
      for update;

    if not found then
      if c_deleted then
        -- 雲端從未有這筆：不需要處理
        results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'applied', 'rev', null, 'seq', null));
        continue;
      end if;
      -- 兌換：先鎖定並確認雲端金幣餘額足夠，避免多裝置重複花用
      if c_collection = 'ledger' and (c_data ->> 'coins')::bigint < 0 and c_data ->> 'kind' = 'redeem' then
        perform pg_advisory_xact_lock(hashtextextended(uid::text, 42));
        select coalesce(sum((r.data ->> 'coins')::bigint), 0) into balance
          from public.records r
          where r.user_id = uid and r.collection = 'ledger' and not r.deleted;
        if balance + (c_data ->> 'coins')::bigint < 0 then
          results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'rejected', 'reason', 'insufficient_coins', 'balance', balance));
          continue;
        end if;
      end if;
      begin
        insert into public.records (user_id, collection, id, data, deleted, device_id)
          values (uid, c_collection, c_id, c_data, false, left(p_device, 100))
          returning * into saved;
      exception when check_violation then
        results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'invalid', 'reason', sqlerrm));
        continue;
      end;
      results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'applied', 'rev', saved.rev, 'seq', saved.seq));
      continue;
    end if;

    -- 內容與雲端相同（例如重試時上次其實已成功）：視為成功，不增加版本
    if cur.deleted = c_deleted and (c_deleted or cur.data = c_data) then
      results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'applied', 'rev', cur.rev, 'seq', cur.seq));
      continue;
    end if;

    if (c_base is not null and cur.rev = c_base and not (c_collection = 'ledger' and not c_deleted))
       or (c_base is null and cur.deleted and not c_deleted and c_collection <> 'ledger') then
      -- 版本一致（或在雲端已刪除後重新建立）：套用修改
      update public.records r
        set data = c_data, deleted = c_deleted, device_id = left(p_device, 100)
        where r.user_id = uid and r.collection = c_collection and r.id = c_id
        returning * into saved;
      results := results || jsonb_build_array(jsonb_build_object('collection', c_collection, 'id', c_id, 'status', 'applied', 'rev', saved.rev, 'seq', saved.seq));
    else
      -- 衝突：回傳雲端目前的版本，交給用戶端處理
      results := results || jsonb_build_array(jsonb_build_object(
        'collection', c_collection, 'id', c_id, 'status', 'conflict',
        'server', jsonb_build_object('data', cur.data, 'deleted', cur.deleted, 'rev', cur.rev, 'seq', cur.seq, 'updated_at', cur.updated_at)
      ));
    end if;
  end loop;

  return results;
end;
$$;

revoke all on function public.sync_push(jsonb, text) from public, anon;
grant execute on function public.sync_push(jsonb, text) to authenticated;
revoke all on function public.records_before_write() from public, anon, authenticated;

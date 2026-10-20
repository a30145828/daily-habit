#!/usr/bin/env bash
# 開發用：在本機啟動與 Supabase 相容的測試環境（PostgreSQL 16 + supabase/auth + PostgREST + 閘道 + 測試信箱）。
# 只用來測試，與你的正式 Supabase 專案無關；請勿用於正式資料。
#
# 需要：PostgreSQL 16（initdb、pg_ctl、psql）、Node.js、Python 3（pip 安裝 aiosmtpd）、curl、tar。
# 以 root 執行時，PostgreSQL 會以 PG_USER（預設 pgtest，需事先建立）身分啟動。
#
# 用法：
#   scripts/dev/local-supabase.sh start   # 建立並啟動，最後印出 SUPABASE_URL 與 SUPABASE_ANON_KEY
#   scripts/dev/local-supabase.sh stop
# 可用環境變數調整：STACK_DIR（預設 /tmp/dhstack）、PG_PORT、AUTH_PORT、REST_PORT、GATEWAY_PORT、SMTP_PORT、SITE_URL
set -euo pipefail

STACK_DIR="${STACK_DIR:-/tmp/dhstack}"
PG_PORT="${PG_PORT:-54322}"
AUTH_PORT="${AUTH_PORT:-9999}"
REST_PORT="${REST_PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-54321}"
SMTP_PORT="${SMTP_PORT:-2500}"
SITE_URL="${SITE_URL:-http://localhost:8765/daily-habit/}"
PG_USER="${PG_USER:-pgtest}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
AUTH_VERSION="${AUTH_VERSION:-v2.180.0}"
POSTGREST_VERSION="${POSTGREST_VERSION:-v12.2.3}"
JWT_SECRET="local-test-jwt-secret-that-is-at-least-32-characters"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

run_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u "$PG_USER" -- "$@"; else "$@"; fi
}

stop() {
  [ -f "$STACK_DIR/pids" ] && while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$STACK_DIR/pids"
  rm -f "$STACK_DIR/pids"
  [ -d "$STACK_DIR/pg" ] && run_pg "$PG_BIN/pg_ctl" -D "$STACK_DIR/pg" stop -m fast || true
}

start() {
  mkdir -p "$STACK_DIR/mail"
  [ "$(id -u)" = "0" ] && chown "$PG_USER" "$STACK_DIR"
  cd "$STACK_DIR"
  : > pids

  # 1. PostgreSQL
  if [ ! -d pg ]; then
    run_pg "$PG_BIN/initdb" -D "$STACK_DIR/pg" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 > initdb.log
  fi
  run_pg "$PG_BIN/pg_ctl" -D "$STACK_DIR/pg" -o "-p $PG_PORT -k $STACK_DIR -c listen_addresses=localhost" -l "$STACK_DIR/pg.log" -w start < /dev/null > /dev/null 2>&1
  psql -h localhost -p "$PG_PORT" -U postgres -qtA -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    create role authenticator login noinherit password 'authpw';
    grant anon, authenticated, service_role to authenticator;
    create role supabase_auth_admin login superuser createrole noinherit password 'authpw';
    create schema auth authorization supabase_auth_admin;
    grant usage on schema auth to anon, authenticated, service_role;
    alter role supabase_auth_admin set search_path = 'auth';
    grant usage on schema public to anon, authenticated, service_role;
  end if;
end $$;
SQL

  # 2. 下載 supabase/auth 與 PostgREST
  [ -x gotrue/auth ] || { mkdir -p gotrue && curl -sSL "https://github.com/supabase/auth/releases/download/$AUTH_VERSION/auth-$AUTH_VERSION-x86.tar.gz" | tar -xz -C gotrue; }
  [ -x postgrest ] || curl -sSL "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-linux-static-x64.tar.xz" | tar -xJ

  # 3. 測試信箱（信件存成檔案）
  python3 -c "import aiosmtpd" 2>/dev/null || pip install -q aiosmtpd
  cat > smtp_sink.py <<PY
import asyncio, os, time
from aiosmtpd.controller import Controller
class Sink:
    async def handle_DATA(self, server, session, envelope):
        with open(os.path.join('$STACK_DIR/mail', f"{time.time():.6f}.eml"), 'wb') as f:
            f.write(b'X-To: ' + ','.join(envelope.rcpt_tos).encode() + b'\r\n')
            f.write(envelope.content)
        return '250 OK'
Controller(Sink(), hostname='127.0.0.1', port=$SMTP_PORT).start()
asyncio.new_event_loop().run_forever()
PY
  nohup python3 smtp_sink.py > smtp.log 2>&1 & echo $! >> pids

  # 4. supabase/auth（會自動建立 auth 結構與 auth.uid()）
  (
    export GOTRUE_API_HOST=127.0.0.1 PORT="$AUTH_PORT" API_EXTERNAL_URL="http://localhost:$GATEWAY_PORT"
    export GOTRUE_DB_DRIVER=postgres DATABASE_URL="postgres://supabase_auth_admin:authpw@localhost:$PG_PORT/postgres?sslmode=disable"
    export GOTRUE_SITE_URL="$SITE_URL" GOTRUE_URI_ALLOW_LIST="http://localhost:*/**"
    export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
    export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
    export GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false
    export GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT="$SMTP_PORT" GOTRUE_SMTP_USER=test GOTRUE_SMTP_PASS=test
    export GOTRUE_SMTP_ADMIN_EMAIL=admin@example.com GOTRUE_SMTP_SENDER_NAME=DailyHabitTest GOTRUE_SMTP_MAX_FREQUENCY=1s
    export GOTRUE_RATE_LIMIT_EMAIL_SENT=10000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000 GOTRUE_RATE_LIMIT_VERIFY=10000
    export GOTRUE_PASSWORD_MIN_LENGTH=8
    export GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify
    export GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
    cd gotrue
    nohup ./auth > ../gotrue.log 2>&1 &
    echo $! >> "$STACK_DIR/pids"
  )
  for _ in $(seq 1 30); do curl -s "http://127.0.0.1:$AUTH_PORT/health" > /dev/null && break; sleep 1; done

  # 5. 專案的資料表、權限與同步函式
  psql -h localhost -p "$PG_PORT" -U postgres -q -v ON_ERROR_STOP=1 -f "$REPO_DIR/supabase/migrations/20261020000000_daily_habit_sync.sql" 2>&1 | grep -v NOTICE || true

  # 6. PostgREST
  cat > postgrest.conf <<CONF
db-uri = "postgres://authenticator:authpw@localhost:$PG_PORT/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = $REST_PORT
CONF
  nohup ./postgrest postgrest.conf > postgrest.log 2>&1 & echo $! >> pids

  # 7. 金鑰與閘道
  node -e '
const c=require("crypto");const s=process.argv[1];
const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const sign=(p)=>{const h=b({alg:"HS256",typ:"JWT"}),q=b(p);return h+"."+q+"."+c.createHmac("sha256",s).update(h+"."+q).digest("base64url")};
const exp=Math.floor(Date.now()/1000)+10*365*86400;
console.log("ANON_KEY="+sign({role:"anon",iss:"supabase-demo",exp}));
console.log("SERVICE_KEY="+sign({role:"service_role",iss:"supabase-demo",exp}));' "$JWT_SECRET" > keys.env
  (
    set -a; . ./keys.env; set +a
    GATEWAY_PORT="$GATEWAY_PORT" AUTH_URL="http://127.0.0.1:$AUTH_PORT" REST_URL="http://127.0.0.1:$REST_PORT" \
      nohup node "$REPO_DIR/scripts/dev/gateway.cjs" > gateway.log 2>&1 & echo $! >> "$STACK_DIR/pids"
  )
  sleep 2
  . ./keys.env
  echo "SUPABASE_URL=http://localhost:$GATEWAY_PORT"
  echo "SUPABASE_ANON_KEY=$ANON_KEY"
  echo "MAIL_DIR=$STACK_DIR/mail"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "用法：$0 start|stop" >&2; exit 2 ;;
esac

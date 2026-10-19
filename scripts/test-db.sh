#!/usr/bin/env bash
# Στήνει προσωρινή Postgres, εφαρμόζει τα migrations και τρέχει τα DB tests.
# Χρήση: scripts/test-db.sh   (απαιτεί Postgres 15+ binaries και node)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUN_AS=""
if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$WORK"
  RUN_AS="runuser -u postgres --"
fi
cleanup() { $RUN_AS "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

$RUN_AS "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
$RUN_AS "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

export DATABASE_URL="postgresql://postgres@localhost/postgres?host=$WORK&port=$PORT"
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
done
echo "migrations applied"
node --test "$ROOT"/supabase/tests/*.test.mjs

#!/usr/bin/env bash
# Restore drill: proves a backup can be turned back into a working database, and that D1 Time Travel can undo a write,
# without ever touching production. Run it once now and again after any schema change; write down how long it took.
#
#   scripts/restore-drill.sh d1/paygate-2026-10-25.sql.gz   # restore that weekly backup from R2 (preferred: tests the backup itself)
#   scripts/restore-drill.sh                                 # restore a fresh export of production. D1 cannot serve queries while it
#                                                            # is being exported, so payments pause for that time: run it at a quiet hour
#
# Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) with D1 edit and R2 read.
# It creates a scratch database named paygate-drill-<time>, and deletes it at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD=paygate
BUCKET=${BACKUP_BUCKET:-paygate-backups}
SCRATCH="paygate-drill-$(date -u +%Y%m%d-%H%M%S)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
w() { npx wrangler "$@"; }
step() { printf '\n== %s (%ss)\n' "$1" "$SECONDS"; }
[[ "$SCRATCH" != "$PROD" ]] || { echo "refusing: scratch name equals production" >&2; exit 1; }

step "1. Get the data"
if [[ $# -ge 1 ]]; then
  w r2 object get "$BUCKET/$1" --remote --file "$WORK/dump.sql.gz"
  gunzip "$WORK/dump.sql.gz"
else
  w d1 export "$PROD" --remote --output "$WORK/dump.sql"   # reads production (and blocks its queries while it runs); writes nothing to it
fi
grep -q 'CREATE TABLE.*payments' "$WORK/dump.sql" || { echo "the dump has no payments table" >&2; exit 1; }

step "2. Create the scratch database $SCRATCH"
w d1 create "$SCRATCH"

step "3. Import"
w d1 execute "$SCRATCH" --remote --file "$WORK/dump.sql" -y

step "4. Check it holds what production holds"
COUNTS="SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM payment_events) AS events, (SELECT COUNT(*) FROM ledger_postings) AS postings"
w d1 execute "$SCRATCH" --remote --command "$COUNTS"
[[ $# -ge 1 ]] || w d1 execute "$PROD" --remote --command "$COUNTS"   # same numbers expected (bar payments made during the drill)

step "5. Time Travel: bookmark, write, restore, check the write is gone"
BOOKMARK=$(w d1 time-travel info "$SCRATCH" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).bookmark))')
echo "bookmark: $BOOKMARK"
w d1 execute "$SCRATCH" --remote --command "CREATE TABLE drill_marker (at INTEGER); INSERT INTO drill_marker VALUES ($(date +%s))"
w d1 time-travel restore "$SCRATCH" --bookmark "$BOOKMARK" --json   # --json: no prompt; this is the scratch copy
if w d1 execute "$SCRATCH" --remote --command "SELECT COUNT(*) AS n FROM drill_marker" >/dev/null 2>&1; then
  echo "FAILED: the write after the bookmark survived the restore" >&2; exit 1
fi
echo "the write after the bookmark is gone, as expected"

step "6. Delete the scratch database"
w d1 delete "$SCRATCH" -y

printf '\nDrill passed in %ss. Record the date, the duration and the counts in docs/operations.md (Backups and restore).\n' "$SECONDS"

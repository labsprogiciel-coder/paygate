#!/usr/bin/env bash
# Restore drill: proves a backup can be turned back into a working database, and that D1 Time Travel can undo a write,
# without ever touching production. Run it once now and again after any schema change; write down how long it took.
#
#   scripts/restore-drill.sh d1/paygate-2026-10-25T0230Z-123-1.sql.gz   # restore that weekly backup from R2 (preferred: tests the backup itself)
#   scripts/restore-drill.sh                                      # restore a fresh export of production. D1 cannot serve queries while it
#                                                                 # is being exported, so payments pause for that time: run it at a quiet hour
#
# Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) with D1 edit and R2 read, and Node 22 (see .nvmrc).
# It creates a scratch database named paygate-drill-<time> and deletes it on the way out, whether the drill passes or fails.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD=paygate
BUCKET=${BACKUP_BUCKET:-paygate-backups}
SCRATCH="paygate-drill-$(date -u +%Y%m%d-%H%M%S)"
WORK=$(mktemp -d)
CREATED=""
w() { npx wrangler "$@"; }
step() { printf '\n== %s (%ss)\n' "$1" "$SECONDS"; }
cleanup() {
  local rc=$?
  rm -rf "$WORK"
  # the scratch database holds a copy of production (phone numbers included): it must not outlive the drill
  if [[ -n "$CREATED" ]]; then
    w d1 delete "$CREATED" -y >/dev/null || echo "WARNING: could not delete the scratch database $CREATED; delete it by hand now" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
[[ "$SCRATCH" != "$PROD" ]] || { echo "refusing: scratch name equals production" >&2; exit 1; }

step "1. Get the data"
if [[ $# -ge 1 ]]; then
  w r2 object get "$BUCKET/$1" --remote --file "$WORK/dump.sql.gz"
  gunzip "$WORK/dump.sql.gz"
else
  w d1 export "$PROD" --remote --output "$WORK/dump.sql"   # reads production (and blocks its queries while it runs); writes nothing to it
fi
grep -q 'CREATE TABLE.*payments' "$WORK/dump.sql" || { echo "the dump has no payments table" >&2; exit 1; }

step "2. Count what the dump holds (loaded locally, nothing leaves this machine)"
# One query counting every table in the dump; the same query runs on the restored database, and the answers must match exactly.
node - "$WORK/dump.sql" "$WORK" <<'JS'
const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
const [file, work] = process.argv.slice(2);
const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(file, 'utf8'));
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all().map((t) => t.name);
const sql = `SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(', ')}`;
fs.writeFileSync(`${work}/count.sql`, sql);
fs.writeFileSync(`${work}/expected.json`, JSON.stringify(db.prepare(sql).get()));
JS
cat "$WORK/expected.json"; echo

step "3. Create the scratch database $SCRATCH"
w d1 create "$SCRATCH"
CREATED="$SCRATCH"

step "4. Import"
w d1 execute "$SCRATCH" --remote --file "$WORK/dump.sql" -y

step "5. Check the restored database holds exactly what the dump holds"
w d1 execute "$SCRATCH" --remote --json --command "$(cat "$WORK/count.sql")" > "$WORK/restored.json"
node - "$WORK/expected.json" "$WORK/restored.json" <<'JS'
const fs = require('node:fs');
const [expectedFile, restoredFile] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
const restored = JSON.parse(fs.readFileSync(restoredFile, 'utf8'))[0].results[0];
const diff = Object.keys(expected).filter((t) => Number(restored[t]) !== Number(expected[t]));
for (const t of Object.keys(expected)) console.log(`${diff.includes(t) ? 'MISMATCH' : 'ok      '} ${t}: dump ${expected[t]}, restored ${restored[t]}`);
if (diff.length) { console.error(`FAILED: ${diff.length} table(s) differ`); process.exit(1); }
JS

step "6. Time Travel: bookmark, write, restore, check the write is gone"
BOOKMARK=$(w d1 time-travel info "$SCRATCH" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).bookmark))')
echo "bookmark: $BOOKMARK"
w d1 execute "$SCRATCH" --remote --command "CREATE TABLE drill_marker (at INTEGER); INSERT INTO drill_marker VALUES ($(date +%s))"
w d1 time-travel restore "$SCRATCH" --bookmark "$BOOKMARK" --json   # --json: no prompt; this is the scratch copy
if w d1 execute "$SCRATCH" --remote --command "SELECT COUNT(*) AS n FROM drill_marker" >/dev/null 2>&1; then
  echo "FAILED: the write after the bookmark survived the restore" >&2; exit 1
fi
echo "the write after the bookmark is gone, as expected"

step "7. Delete the scratch database (also done on any failure above)"
printf '\nDrill passed in %ss. Record the date, the duration and the counts in docs/operations.md (Backups and restore).\n' "$SECONDS"

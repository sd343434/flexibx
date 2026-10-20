#!/usr/bin/env bash
# Mutation test of the restore drill (Pass 18): proves the drill can fail. Each mutant is
# one realistic defect — in the backup/restore/verify/marker scripts, or in the restored
# copy — applied to a COPY of scripts/ops (the repository's files are never changed); the
# drill is then run against the copy and must fail at the step named for that mutant.
#   DRILL_ADMIN_URL=postgresql://…/postgres scripts/ops/restore-drill-mutants.sh
# Same database rules as restore-drill.sh (disposable local server, flexibx_drill_* only).
# Exit 0 = every mutant killed; 1 = a mutant survived, failed at the wrong step, or could
# not be applied (its target text is gone: update the mutant together with the script).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
: "${DRILL_ADMIN_URL:?set DRILL_ADMIN_URL to an admin connection on a disposable server}"

# A tree that is the repository except scripts/ops, which is a private copy per mutant.
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
for entry in "$root"/* "$root"/.[!.]*; do
  if [[ -e "$entry" && "$(basename "$entry")" != scripts ]]; then ln -s "$entry" "$sandbox/"; fi
done
mkdir "$sandbox/scripts"
for entry in "$root"/scripts/*; do
  if [[ "$(basename "$entry")" != ops ]]; then ln -s "$entry" "$sandbox/scripts/"; fi
done

exec python3 - "$here" "$sandbox" <<'PY'
import shutil, subprocess, sys
ops, sandbox = sys.argv[1], sys.argv[2]
copy = f"{sandbox}/scripts/ops"
STEP16 = 'echo "== 16. restored copy equals the source"'
STEP17 = 'echo "== 17. nothing else was touched"'
def before(marker, sql_db, sql):
    return (marker, f'on {sql_db} "{sql}" >/dev/null\n{marker}')
# (name, file, text to replace, replacement, FAIL line the drill must print)
MUTANTS = [
    ("backup leaves partial files", "db-backup.sh", "trap 'cleanup; echo", "trap 'echo",
     "…and left no partial file"),
    ("backup files readable by others", "db-backup.sh", "umask 077", "umask 022",
     "every backup file mode 600"),
    ("restore without one transaction", "db-restore.sh", " --single-transaction \\", " \\",
     "…and left the target empty"),
    ("restore into any database", "db-restore.sh", '[[ "$name" == "$confirm" ]] || refuse',
     "true || refuse", "restore naming another database is refused"),
    ("restore over a non-empty database", "db-restore.sh", '[[ "$tables" == "0" ]] || refuse',
     "true || refuse", "restore into a database holding another table is refused (exit 2)"),
    ("restore without the checksum", "db-restore.sh",
     '''[[ "$(sha256sum "$dump" | cut -d' ' -f1)" == "$(cat "$dump.sha256")" ]] || refuse''',
     "true || refuse", "restore of a tampered dump is refused"),
    ("verify ignores row counts", "db-verify.sh",
     'if diff <(sort "$counts") <(sort <<<"$actual") >/dev/null; then', "if true; then",
     "verification with a re-signed wrong manifest fails"),
    ("unmarked database accepted", "db-environment.sh", 'if [[ "$current" == "$wanted" ]]; then',
     'if [[ "$current" == "$wanted" || -z "$current" ]]; then', "a restored copy is not accepted as staging"),
    ("CHECK constraint loosened in the copy", "restore-drill.sh", *before(STEP16, "flexibx_drill_net",
     "ALTER TABLE workspaces DROP CONSTRAINT workspaces_slug_format_check, "
     "ADD CONSTRAINT workspaces_slug_format_check CHECK (slug IS NOT NULL)"), "same CHECK constraints"),
    ("index missing in the copy", "restore-drill.sh", *before(STEP16, "flexibx_drill_net",
     "DROP INDEX workspaces_parent_workspace_id_idx"), "same schema: tables, columns, indexes"),
    ("trigger disabled in the copy", "restore-drill.sh", *before(STEP16, "flexibx_drill_net",
     "ALTER TABLE credit_ledger_entries DISABLE TRIGGER USER"), "same schema: tables, columns, indexes"),
    ("audit log changed in the copy", "restore-drill.sh", *before(STEP16, "flexibx_drill_net",
     "DELETE FROM audit_logs WHERE ctid IN (SELECT ctid FROM audit_logs LIMIT 1)"),
     "same audit log, row for row"),
    ("another database touched", "restore-drill.sh", *before(STEP17, "flexibx_drill_bystander",
     "UPDATE sentinel SET v = 'changed'"), "an unrelated database is unchanged"),
]
bad = 0
for name, file, old, new, expected in MUTANTS:
    shutil.rmtree(copy, ignore_errors=True)
    shutil.copytree(ops, copy, symlinks=True)
    path = f"{copy}/{file}"
    text = open(path, encoding="utf-8").read()
    if old not in text:
        print(f"NOT APPLIED  {name} (target text not found in {file})"); bad += 1; continue
    open(path, "w", encoding="utf-8").write(text.replace(old, new, 1))
    run = subprocess.run([f"{copy}/restore-drill.sh"], capture_output=True, text=True)
    fails = [l for l in run.stdout.splitlines() if l.startswith("FAIL")]
    if run.returncode != 0 and any(l.startswith(f"FAIL  {expected}") for l in fails):
        print(f"KILLED       {name}")
    else:
        print(f"SURVIVED     {name} (drill exit {run.returncode}; expected a failure at: {expected})")
        for l in fails[:3]: print(f"             {l}")
        bad += 1
if bad:
    print(f'{{"status":"MUTANTS SURVIVED","survived":{bad},"total":{len(MUTANTS)}}}'); sys.exit(1)
print(f'{{"status":"ALL MUTANTS KILLED","total":{len(MUTANTS)}}}')
PY

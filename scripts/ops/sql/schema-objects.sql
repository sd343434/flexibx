-- The schema objects a restore must bring back, one "kind<TAB>table<TAB>name" line each,
-- sorted: every index (unique ones apart) and every CHECK, FOREIGN KEY, UNIQUE and
-- EXCLUDE constraint of the public schema. db-verify.sh compares this with
-- expected-schema-objects.tsv (the migrated schema; tests/integration/ops-restore-checks
-- fails when a migration changes it and the file was not regenerated). Names only.
SELECT kind, tbl, name FROM (
  SELECT CASE WHEN x.indisunique THEN 'unique_index' ELSE 'index' END AS kind,
         c.relname AS tbl, i.relname AS name
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class c ON c.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT x.indisprimary
  UNION ALL
  SELECT 'constraint_' || co.contype::text, cl.relname, co.conname
  FROM pg_constraint co
  JOIN pg_class cl ON cl.oid = co.conrelid
  JOIN pg_namespace n ON n.oid = co.connamespace
  WHERE n.nspname = 'public' AND co.contype IN ('c', 'f', 'u', 'x')
) objects
ORDER BY kind COLLATE "C", tbl COLLATE "C", name COLLATE "C";

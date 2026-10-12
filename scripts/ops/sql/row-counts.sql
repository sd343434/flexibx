-- Exact row count of every table in the public schema, one "table<TAB>count" line each.
-- Used at backup time (manifest) and after a restore (comparison). Counts only.
SELECT format('SELECT %L AS table_name, count(*) AS row_count FROM public.%I', table_name, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\gexec

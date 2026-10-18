-- Post-restore checks run by db-verify.sh next to integrity.sql. One "check<TAB>violations"
-- line each; every value must be 0. Counts only — no customer content is printed.

-- An index left invalid or not ready (a failed CREATE INDEX CONCURRENTLY in the source)
-- is ignored by the planner, and a unique one no longer refuses duplicates.
SELECT 'indexes_invalid', count(*) FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_namespace n ON n.oid = i.relnamespace
  WHERE n.nspname = 'public' AND (NOT x.indisvalid OR NOT x.indisready);

-- Credits never go below zero, in the balances or anywhere in their history.
SELECT 'credit_balances_negative', count(*) FROM credit_accounts
  WHERE subscription_credits < 0 OR purchased_credits < 0 OR held_credits < 0;
SELECT 'credit_ledger_negative_after', count(*) FROM credit_ledger_entries
  WHERE subscription_after < 0 OR purchased_after < 0 OR held_after < 0;

-- A settled or released hold has a settlement time; an open one has none.
SELECT 'credit_holds_settlement_mismatch', count(*) FROM credit_holds
  WHERE (status = 'HELD') <> (settled_at IS NULL);

-- Video money: each job's reserved, captured and released totals equal its usage ledger
-- (RESERVE, CAPTURE, RELEASE entries), and it never spends or returns more than it reserved.
SELECT 'video_usage_vs_jobs', count(*) FROM video_generation_jobs j
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(sum(amount_micros) FILTER (WHERE kind = 'RESERVE'), 0) AS reserved,
      COALESCE(sum(amount_micros) FILTER (WHERE kind = 'CAPTURE'), 0) AS captured,
      COALESCE(sum(amount_micros) FILTER (WHERE kind = 'RELEASE'), 0) AS released
    FROM usage_ledger_entries u WHERE u.job_id = j.id AND u.workspace_id = j.workspace_id
  ) l ON true
  WHERE l.reserved <> j.reserved_micros OR l.captured <> j.captured_micros
     OR l.released <> j.released_micros
     OR j.captured_micros + j.released_micros > j.reserved_micros;


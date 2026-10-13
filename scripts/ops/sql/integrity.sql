-- Post-restore integrity checks. One "check<TAB>violations" line each; every value must be
-- 0. Reads counts only — no customer content is printed.

-- Migrations not in a clean applied state: no attempt of the migration is applied
-- (finished and not rolled back), or an attempt failed and was never resolved (Prisma
-- refuses to deploy until it is). An attempt that was rolled back with
-- `prisma migrate resolve --rolled-back` and then re-applied is history, not a failure.
-- Whether every repository migration is present and unchanged is db-verify.sh's job.
SELECT 'migrations_unfinished', count(*) FROM (
  SELECT migration_name FROM _prisma_migrations GROUP BY migration_name
  HAVING NOT bool_or(finished_at IS NOT NULL AND rolled_back_at IS NULL)
      OR bool_or(finished_at IS NULL AND rolled_back_at IS NULL)
) unfinished;

-- Credit balances match the last ledger entry of each workspace (an account without any
-- entry must be all zero: it is created with a SUBSCRIPTION_GRANT entry when it has credits).
SELECT 'credit_balance_vs_ledger', count(*) FROM credit_accounts a
  LEFT JOIN LATERAL (
    SELECT subscription_after, purchased_after, held_after FROM credit_ledger_entries e
    WHERE e.workspace_id = a.workspace_id ORDER BY e.sequence DESC LIMIT 1
  ) last ON true
  WHERE COALESCE(last.subscription_after, 0) <> a.subscription_credits
     OR COALESCE(last.purchased_after, 0) <> a.purchased_credits
     OR COALESCE(last.held_after, 0) <> a.held_credits;

-- Held credits equal the open holds of each workspace.
SELECT 'credit_held_vs_open_holds', count(*) FROM credit_accounts a
  WHERE a.held_credits <> COALESCE(
    (SELECT sum(h.amount) FROM credit_holds h WHERE h.workspace_id = a.workspace_id AND h.status = 'HELD'), 0);

-- Append-only and same-workspace guards survived the restore (3 triggers, enabled).
SELECT 'ledger_guard_triggers_missing', 3 - count(*) FROM pg_trigger
  WHERE tgrelid = 'credit_ledger_entries'::regclass AND NOT tgisinternal AND tgenabled <> 'D';

-- Constraints that were restored NOT VALID would hide bad rows.
SELECT 'constraints_not_validated', count(*) FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND NOT c.convalidated;

-- Sessions and two-factor rows belong to existing users (cascades intact).
SELECT 'orphan_sessions', count(*) FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL;
SELECT 'orphan_two_factors', count(*) FROM two_factors t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL;

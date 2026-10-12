-- The credit ledger is append-only for deletes too. UPDATE was already refused; a DELETE
-- (raw SQL, or a nested write that slipped past the application guard) now fails as well.
--
-- The only legitimate delete is a deliberate workspace purge, which does not exist yet.
-- When it does, it must run inside a transaction that first sets
--   SET LOCAL flexibx.purge_workspace = '<workspace id>';
-- and may then delete that workspace's ledger rows (and nothing else).
CREATE FUNCTION "credit_ledger_no_delete_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('flexibx.purge_workspace', true) = OLD."workspace_id"::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'credit_ledger_entries is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "credit_ledger_entries_no_delete" BEFORE DELETE ON "credit_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "credit_ledger_no_delete_trigger"();

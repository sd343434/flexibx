-- Single-use TOTP codes through one narrow SECURITY DEFINER function (Phase D.2,
-- docs/runbooks/PHASE_D_2_SECURITY_HARDENING.md).
--
-- Before: the application claimed a code with two statements of its own (delete the
-- account's expired claims, then INSERT … ON CONFLICT). With the role model of
-- docs/runbooks/DATABASE_ROLES.md that needed DELETE on two_factor_used_codes for the
-- runtime and grant roles — and a table privilege cannot be limited to expired rows, so
-- either credential could delete an UNEXPIRED claim and have a used code accepted again.
--
-- Now: public.two_factor_claim_code() is the only write path. It removes only the given
-- account's claims that have expired by the DATABASE clock, then records the claim with
-- a fixed lifetime; of concurrent claims of one code exactly one gets true (the primary
-- key decides). scripts/ops/sql/db-roles.sql grants EXECUTE to the runtime and grant
-- roles and takes every table privilege on two_factor_used_codes away from them.
--
-- Hardening: fixed search_path (pg_catalog, pg_temp) and schema-qualified objects, so a
-- caller cannot substitute tables, functions or operators; no dynamic SQL; arguments
-- validated (the code arrives only as a SHA-256 hex digest — the database never sees the
-- code itself); EXECUTE revoked from PUBLIC here. Unknown accounts fail on the foreign
-- key (an error, never a "fresh code").
--
-- The lifetime (3 minutes) must stay longer than the TOTP acceptance window (±1 step of
-- 30 s) and equal USED_TOTP_CODE_TTL_MS in src/server/auth/totp-replay.ts (unit-tested).
-- Additive: the table is unchanged. The previous application version keeps working while
-- it connects as the table owner; with the role model, re-run db-roles.sql (which removes
-- the table privileges) only after the new application version is deployed.
BEGIN;

CREATE FUNCTION public.two_factor_claim_code(p_user_id uuid, p_code_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  claimed integer;
BEGIN
  IF p_user_id IS NULL OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'two_factor_claim_code: invalid arguments'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only this account, only claims expired by the database clock.
  DELETE FROM public.two_factor_used_codes
   WHERE user_id = p_user_id
     AND expires_at < pg_catalog.now();

  INSERT INTO public.two_factor_used_codes (user_id, code_hash, expires_at)
  VALUES (p_user_id, p_code_hash, pg_catalog.now() + interval '3 minutes')
  ON CONFLICT (user_id, code_hash) DO NOTHING;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed = 1;
END
$$;

REVOKE ALL ON FUNCTION public.two_factor_claim_code(uuid, text) FROM PUBLIC;

COMMIT;

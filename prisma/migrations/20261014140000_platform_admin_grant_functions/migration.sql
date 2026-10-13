-- The approved platform-admin grant and revoke paths as SECURITY DEFINER functions
-- (docs/runbooks/DATABASE_ROLES.md, docs/runbooks/ADMIN_PROVISIONING.md).
--
-- With the role model of DATABASE_ROLES.md, these functions are the ONLY way the flag
-- changes: the runtime role has no column privilege on users.is_platform_admin (setting
-- the old grant marker does not help it), owns nothing it could alter, and cannot execute
-- these functions. EXECUTE is granted to the operator grant role only, by
-- scripts/ops/sql/db-roles.sql; here it is revoked from PUBLIC.
--
-- Trust boundary: the database cannot verify a TOTP code (the secret is encrypted with
-- AUTH_SECRET, outside the database). Proof of possession is checked by `pnpm admin:grant`
-- before it calls platform_admin_grant(); the database guarantees that only the grant
-- role can call it, re-checks every account precondition under a row lock, and writes
-- the audit entry itself (including the database login that called it).
--
-- search_path is fixed to pg_catalog, pg_temp and every object is schema-qualified, so a
-- caller cannot substitute tables or functions.
BEGIN;

-- The guard (migration 20261014120000), tightened: a NEW row can never carry the flag, with
-- or without the grant marker (the grant function only UPDATEs existing accounts). This
-- lets the runtime role keep a plain INSERT privilege on users (Prisma writes every
-- column on insert) without being able to create an administrator.
CREATE OR REPLACE FUNCTION "platform_admin_grant_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."is_platform_admin" THEN
    RAISE EXCEPTION 'is_platform_admin is granted only through the admin grant workflow'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Two-factor turned off: the administrator flag goes with it.
  IF TG_OP = 'UPDATE' AND OLD."two_factor_enabled" AND NOT NEW."two_factor_enabled" THEN
    NEW."is_platform_admin" := false;
  END IF;
  IF NEW."is_platform_admin" AND TG_OP = 'UPDATE' AND NOT OLD."is_platform_admin" THEN
    IF current_setting('flexibx.platform_admin_grant', true) IS DISTINCT FROM NEW."id"::text THEN
      RAISE EXCEPTION 'is_platform_admin is granted only through the admin grant workflow'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT NEW."two_factor_enabled" OR NOT NEW."email_verified" THEN
      RAISE EXCEPTION 'is_platform_admin needs a verified email and two-factor authentication'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "public"."platform_admin_grant"(p_user_id uuid, p_operator text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account record;
  factor record;
BEGIN
  IF p_user_id IS NULL
     OR p_operator IS NULL OR char_length(btrim(p_operator)) NOT BETWEEN 2 AND 80
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'platform_admin_grant: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT u.id, u.email_verified, u.two_factor_enabled, u.is_platform_admin
    INTO account FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF account.is_platform_admin THEN RETURN 'ALREADY_ADMIN'; END IF;
  IF NOT account.email_verified THEN RETURN 'EMAIL_UNVERIFIED'; END IF;

  SELECT t.verified, t.locked_until INTO factor FROM public.two_factors t WHERE t.user_id = p_user_id;
  IF NOT account.two_factor_enabled OR NOT FOUND OR NOT factor.verified THEN
    RETURN 'MFA_NOT_ENROLLED';
  END IF;
  IF factor.locked_until IS NOT NULL AND factor.locked_until > pg_catalog.now() THEN
    RETURN 'MFA_LOCKED';
  END IF;

  -- The guard trigger (migration 20261014120000) accepts the change only with this
  -- transaction-local marker; it is set here, inside the function, and cleared again.
  PERFORM pg_catalog.set_config('flexibx.platform_admin_grant', p_user_id::text, true);
  UPDATE public.users SET is_platform_admin = true WHERE id = p_user_id;
  PERFORM pg_catalog.set_config('flexibx.platform_admin_grant', '', true);

  INSERT INTO public.audit_logs (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (NULL, NULL, 'platform_admin.granted', 'user', p_user_id,
          pg_catalog.jsonb_build_object('operator', p_operator, 'reason', p_reason,
                                        'databaseUser', session_user::text));
  RETURN 'GRANTED';
END $$;

CREATE FUNCTION "public"."platform_admin_revoke"(p_user_id uuid, p_operator text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  was_admin boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_operator IS NULL OR char_length(btrim(p_operator)) NOT BETWEEN 2 AND 80
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'platform_admin_revoke: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT u.is_platform_admin INTO was_admin FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF NOT was_admin THEN RETURN 'NOT_ADMIN'; END IF;
  UPDATE public.users SET is_platform_admin = false WHERE id = p_user_id;
  INSERT INTO public.audit_logs (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (NULL, NULL, 'platform_admin.revoked', 'user', p_user_id,
          pg_catalog.jsonb_build_object('cause', 'manual', 'operator', p_operator, 'reason', p_reason,
                                        'databaseUser', session_user::text));
  RETURN 'REVOKED';
END $$;

REVOKE ALL ON FUNCTION "public"."platform_admin_grant"(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."platform_admin_revoke"(uuid, text, text) FROM PUBLIC;

COMMIT;

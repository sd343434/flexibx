-- Platform-admin grants are enforced by the database (docs/runbooks/ADMIN_PROVISIONING.md).
--
-- 1. users.is_platform_admin can become true only inside a transaction that first runs
--      SELECT set_config('flexibx.platform_admin_grant', '<user id>', true);
--    (done by `pnpm admin:grant` after it has verified a fresh TOTP code from the person's
--    own authenticator), and only for an account with a verified email and two-factor on.
--    A plain UPDATE that sets the flag fails.
-- 2. Losing two-factor (the user turns it off, or an operator resets it) removes the flag
--    in the same statement: re-enrolling never restores administrator access by itself.
-- 3. Existing administrators without two-factor lose the flag now (they must be granted
--    again through the workflow; none exist in production at the time of writing).

CREATE FUNCTION "platform_admin_grant_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Two-factor turned off: the administrator flag goes with it.
  IF TG_OP = 'UPDATE' AND OLD."two_factor_enabled" AND NOT NEW."two_factor_enabled" THEN
    NEW."is_platform_admin" := false;
  END IF;
  IF NEW."is_platform_admin" AND (TG_OP = 'INSERT' OR NOT OLD."is_platform_admin") THEN
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

CREATE TRIGGER "users_platform_admin_grant_guard"
  BEFORE INSERT OR UPDATE OF "is_platform_admin", "two_factor_enabled" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "platform_admin_grant_guard"();

UPDATE "users" SET "is_platform_admin" = false
WHERE "is_platform_admin" AND NOT "two_factor_enabled";

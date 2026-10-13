-- Database role separation for Flexibx (docs/runbooks/DATABASE_ROLES.md).
--
--   psql -X -v ON_ERROR_STOP=1 -v owner_role=… -v app_role=… -v grant_role=… \
--        -f scripts/ops/sql/db-roles.sql          (connected to the TARGET database)
--
-- Roles (created beforehand by a DBA; this script never creates roles or passwords):
--   owner_role  owns the database, the schema and every object; used ONLY by migrations
--               (the one-off migrate job) and this script.
--   app_role    the application runtime (DATABASE_URL of the web app and scheduled jobs):
--               read/write on tables, but no ownership, no DDL, no UPDATE privilege on
--               users.is_platform_admin (new rows can never carry it: guard trigger), no
--               UPDATE/DELETE on audit_logs, and no EXECUTE
--               on the platform-admin functions.
--   grant_role  the operator credential of `pnpm admin:grant` (ADMIN_GRANT_DATABASE_URL):
--               reads what the grant needs, claims the TOTP code, writes denial audits,
--               and EXECUTEs public.platform_admin_grant / platform_admin_revoke.
--
-- Run by a superuser, or by owner_role itself when it already owns everything. Idempotent:
-- run it again after EVERY migration (new tables and new users columns need privileges).
-- Refuses (and changes nothing: one transaction) when app_role or grant_role are
-- privileged or can reach owner_role through role membership.

\set ON_ERROR_STOP 1
SELECT set_config('flexibx.roles_owner', :'owner_role', false),
       set_config('flexibx.roles_app', :'app_role', false),
       set_config('flexibx.roles_grant', :'grant_role', false) \g /dev/null

BEGIN;

DO $roles$
DECLARE
  owner_r text := current_setting('flexibx.roles_owner');
  app_r text := current_setting('flexibx.roles_app');
  grant_r text := current_setting('flexibx.roles_grant');
  limited text;
  obj record;
  cols text;
BEGIN
  -- 1. Preconditions.
  IF owner_r = '' OR app_r = '' OR grant_r = ''
     OR owner_r = app_r OR owner_r = grant_r OR app_r = grant_r THEN
    RAISE EXCEPTION 'db-roles: owner_role, app_role and grant_role must be three different roles';
  END IF;
  FOREACH limited IN ARRAY ARRAY[owner_r, app_r, grant_r] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = limited) THEN
      RAISE EXCEPTION 'db-roles: role % does not exist', limited;
    END IF;
  END LOOP;
  FOREACH limited IN ARRAY ARRAY[app_r, grant_r] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = limited
               AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)) THEN
      RAISE EXCEPTION 'db-roles: % must not be superuser, CREATEROLE, CREATEDB, BYPASSRLS or REPLICATION', limited;
    END IF;
    -- Membership is checked transitively (pg_has_role follows the whole membership chain).
    IF pg_has_role(limited, owner_r, 'MEMBER') THEN
      RAISE EXCEPTION 'db-roles: % can reach % through role membership', limited, owner_r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolsuper AND pg_has_role(limited, r.oid, 'MEMBER')) THEN
      RAISE EXCEPTION 'db-roles: % can reach a superuser through role membership', limited;
    END IF;
  END LOOP;
  IF pg_has_role(app_r, grant_r, 'MEMBER') OR pg_has_role(grant_r, app_r, 'MEMBER') THEN
    RAISE EXCEPTION 'db-roles: % and % must not be members of each other', app_r, grant_r;
  END IF;

  -- 2. Ownership: database, schema and every object that is not part of an extension.
  EXECUTE format('ALTER DATABASE %I OWNER TO %I', current_database(), owner_r);
  EXECUTE format('ALTER SCHEMA public OWNER TO %I', owner_r);
  FOR obj IN
    SELECT c.oid, c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
      -- Sequences owned by a column follow their table.
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s public.%I OWNER TO %I',
      CASE obj.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      obj.relname, owner_r);
  END LOOP;
  FOR obj IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', obj.oid::regprocedure, owner_r);
  END LOOP;
  FOR obj IN
    SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c', 'r')
      AND (t.typrelid = 0 OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO %I', obj.oid::regtype, owner_r);
  END LOOP;

  -- 3. Database and schema: no one but the owner creates objects.
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), app_r, grant_r);
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I, %I', app_r, grant_r);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I', app_r, grant_r);

  -- 4. Runtime role: read/write on tables, with the exceptions below.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, %I, %I', app_r, grant_r);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, %I, %I', app_r, grant_r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_r);
  -- UPDATE on users: every column except the flag (column privileges replace the table
  -- privilege). INSERT stays table-wide — Prisma writes every column on insert — and the
  -- guard trigger refuses any new row that carries the flag (migration 20261014140000).
  -- (A column privilege on the table must not exist either: the table-level REVOKE does
  -- not remove column grants, so they are revoked explicitly.)
  SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE ALL (%s) ON public.users FROM PUBLIC, %I, %I', cols, app_r, grant_r);
  EXECUTE format('REVOKE UPDATE ON public.users FROM %I', app_r);
  SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped
      AND attname <> 'is_platform_admin';
  EXECUTE format('GRANT UPDATE (%s) ON public.users TO %I', cols, app_r);
  -- The audit trail is append-only for the application (workspace deletions still cascade:
  -- referential actions run with the table owner's rights).
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM %I', app_r);
  -- Migration bookkeeping belongs to the migration role.
  EXECUTE format('REVOKE ALL ON public._prisma_migrations FROM %I', app_r);

  -- 5. Grant role: only what `pnpm admin:grant` needs.
  EXECUTE format('GRANT SELECT (id, email, email_verified, two_factor_enabled, is_platform_admin) ON public.users TO %I', grant_r);
  EXECUTE format('GRANT SELECT ON public.two_factors TO %I', grant_r);
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON public.two_factor_used_codes TO %I', grant_r);
  EXECUTE format('GRANT INSERT ON public.audit_logs TO %I', grant_r);

  -- 6. Functions: the SECURITY DEFINER pair is executable by the grant role only.
  REVOKE ALL ON FUNCTION public.platform_admin_grant(uuid, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.platform_admin_revoke(uuid, text, text) FROM PUBLIC;
  EXECUTE format('REVOKE ALL ON FUNCTION public.platform_admin_grant(uuid, text, text) FROM %I', app_r);
  EXECUTE format('REVOKE ALL ON FUNCTION public.platform_admin_revoke(uuid, text, text) FROM %I', app_r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.platform_admin_grant(uuid, text, text) TO %I', grant_r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.platform_admin_revoke(uuid, text, text) TO %I', grant_r);

  -- 7. Future objects created by the owner (new migrations).
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner_r, app_r);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', owner_r, app_r);

  -- 8. Postconditions (fail, and roll everything back, if any does not hold).
  IF has_column_privilege(app_r, 'public.users', 'is_platform_admin', 'UPDATE')
     OR has_function_privilege(app_r, 'public.platform_admin_grant(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege(app_r, 'public.platform_admin_revoke(uuid, text, text)', 'EXECUTE')
     OR has_table_privilege(app_r, 'public.audit_logs', 'UPDATE')
     OR has_table_privilege(app_r, 'public.audit_logs', 'DELETE')
     OR has_column_privilege(grant_r, 'public.users', 'is_platform_admin', 'UPDATE')
     OR has_schema_privilege(app_r, 'public', 'CREATE')
     OR has_schema_privilege(grant_r, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'db-roles: postcondition failed (privileges)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND (pg_has_role(app_r, c.relowner, 'MEMBER') OR pg_has_role(grant_r, c.relowner, 'MEMBER'))
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND (pg_has_role(app_r, p.proowner, 'MEMBER') OR pg_has_role(grant_r, p.proowner, 'MEMBER'))
  ) THEN
    RAISE EXCEPTION 'db-roles: postcondition failed (app_role or grant_role owns an object)';
  END IF;
END
$roles$;

COMMIT;

SELECT 'db-roles: applied (owner=' || current_setting('flexibx.roles_owner')
    || ', app=' || current_setting('flexibx.roles_app')
    || ', grant=' || current_setting('flexibx.roles_grant') || ')' AS result;

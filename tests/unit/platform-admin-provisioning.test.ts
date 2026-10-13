import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Platform administrators are provisioned only by an operator in the database. These
// static checks keep every other path closed and the documented procedure and production
// blockers in place. (Requests cannot set the flag either: tests/integration/auth.test.ts
// and auth-entry-points.test.ts; application code never writes it:
// tests/unit/tenancy-boundaries.test.ts.)

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const MIGRATIONS = "prisma/migrations";

function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name))
      : /\.(ts|mjs|js|sql|sh)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

describe("platform admin provisioning", () => {
  it("only the SECURITY DEFINER grant function sets the flag; otherwise it is created false", () => {
    const mentions = filesUnder(MIGRATIONS).filter((path) =>
      read(path).includes("is_platform_admin"),
    );
    expect(mentions).toEqual([
      join(MIGRATIONS, "20261006201052_init", "migration.sql"),
      // The grant guard (trigger): refuses the flag outside the workflow, revokes it with
      // two-factor, and only ever sets it to false.
      join(MIGRATIONS, "20261014120000_platform_admin_grant_guard", "migration.sql"),
      // The grant/revoke functions and the tightened guard (no new row may carry the flag).
      join(MIGRATIONS, "20261014140000_platform_admin_grant_functions", "migration.sql"),
    ]);
    const sql = read(mentions[0] ?? "");
    expect(sql).toMatch(/"is_platform_admin" BOOLEAN NOT NULL DEFAULT false/);
    const functions = join(
      MIGRATIONS,
      "20261014140000_platform_admin_grant_functions",
      "migration.sql",
    );
    for (const path of filesUnder(MIGRATIONS)) {
      if (path === functions) continue;
      expect(read(path), path).not.toMatch(/is_platform_admin"?\s*=\s*true/i);
    }
    // In that migration the one `= true` is inside platform_admin_grant, which is a
    // SECURITY DEFINER function with a fixed search_path, revoked from PUBLIC.
    const text = read(functions);
    expect(text.match(/is_platform_admin"?\s*=\s*true/gi)).toHaveLength(1);
    const start = text.indexOf('CREATE FUNCTION "public"."platform_admin_grant"');
    const body = text.slice(start, text.indexOf("END $$;", start));
    expect(body).toMatch(/is_platform_admin = true/);
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path = pg_catalog, pg_temp");
    expect(text).toContain(
      'REVOKE ALL ON FUNCTION "public"."platform_admin_grant"(uuid, text, text) FROM PUBLIC;',
    );
  });

  it("neither the seed nor any script sets the flag", () => {
    const roles = join("scripts", "ops", "sql", "db-roles.sql");
    for (const path of ["prisma/seed.ts", ...filesUnder("scripts")]) {
      if (path === roles) continue;
      expect(read(path), path).not.toMatch(/isPlatformAdmin|is_platform_admin/);
    }
    // The role script only ever withholds the column from the runtime role.
    const script = read(roles).replace(/^\s*--.*$/gm, "");
    expect(script).toContain("attname <> 'is_platform_admin'");
    expect(script).not.toMatch(/is_platform_admin"?\s*=\s*true/i);
  });

  it("the auth layer declares the flag as not settable by input", () => {
    expect(read("src/server/auth/auth-config.ts")).toMatch(
      /isPlatformAdmin:\s*\{\s*type:\s*"boolean",\s*required:\s*false,\s*input:\s*false\s*\}/,
    );
  });

  it("documents the grant workflow (no hand-written grant), and revocation", () => {
    const doc = read("docs/STORAGE_PROVIDERS.md");
    expect(doc).toContain("docs/runbooks/ADMIN_PROVISIONING.md");
    expect(doc).toContain("public.platform_admin_revoke");
    const runbook = read("docs/runbooks/ADMIN_PROVISIONING.md");
    expect(runbook).toContain("pnpm admin:grant --email <staff email> --confirm <staff email>");
    for (const text of [doc, runbook, read("docs/runbooks/INCIDENT_RESPONSE.md")]) {
      expect(text).not.toMatch(/SET is_platform_admin = true/);
    }
  });

  it("the database guards the flag (trigger in the guard migration)", () => {
    const sql = read(
      join(MIGRATIONS, "20261014120000_platform_admin_grant_guard", "migration.sql"),
    );
    expect(sql).toMatch(/CREATE TRIGGER "?users_platform_admin_grant_guard"?/);
    expect(sql).toContain("current_setting('flexibx.platform_admin_grant', true)");
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF/);
  });

  it("documents MFA and fresh-session checks as enforced, and the code enforces them", () => {
    const doc = read("docs/STORAGE_PROVIDERS.md");
    const gate = doc.slice(doc.indexOf("## 9. Production gate"));
    expect(gate).toMatch(/\*\*MFA for platform administrators\*\*[^\n]*\*\*Done — enforced\*\*/);
    expect(gate).toMatch(/\*\*Fresh session for changes\*\*[^\n]*\*\*Done — enforced\*\*/);
    const gateCode = read("src/server/admin/platform-admin.ts");
    expect(gateCode).toContain("Multi-factor authentication is mandatory, in every environment");
    // No bypass switch: the gate reads no environment variable.
    expect(gateCode).not.toMatch(/process\.env|getEnv\(/);
    expect(read("src/server/admin/platform-admin-access.ts")).not.toMatch(/process\.env/);
    // Every admin change action asks for the fresh second factor.
    for (const path of [
      "src/server/admin/storage-admin-actions.ts",
      "src/server/admin/credits-admin-actions.ts",
    ]) {
      expect(read(path).match(/requirePlatformAdmin\(\{ change: true \}\)/g), path).toHaveLength(2);
    }
  });
});

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
  it("no migration grants the flag: it is only created, defaulting to false", () => {
    const mentions = filesUnder(MIGRATIONS).filter((path) =>
      read(path).includes("is_platform_admin"),
    );
    expect(mentions).toEqual([join(MIGRATIONS, "20261006201052_init", "migration.sql")]);
    const sql = read(mentions[0] ?? "");
    expect(sql).toMatch(/"is_platform_admin" BOOLEAN NOT NULL DEFAULT false/);
    for (const path of filesUnder(MIGRATIONS)) {
      expect(read(path), path).not.toMatch(/is_platform_admin"?\s*=\s*true/i);
    }
  });

  it("neither the seed nor any script touches the flag", () => {
    for (const path of ["prisma/seed.ts", ...filesUnder("scripts")]) {
      expect(read(path), path).not.toMatch(/isPlatformAdmin|is_platform_admin/);
    }
  });

  it("the auth layer declares the flag as not settable by input", () => {
    expect(read("src/server/auth/auth-config.ts")).toMatch(
      /isPlatformAdmin:\s*\{\s*type:\s*"boolean",\s*required:\s*false,\s*input:\s*false\s*\}/,
    );
  });

  it("documents the operator procedure: verified email and two-factor required, revocation", () => {
    const doc = read("docs/STORAGE_PROVIDERS.md");
    // Granted only to an account that already has two-step verification on.
    expect(doc).toContain(
      "UPDATE users SET is_platform_admin = true\nWHERE email = '<staff email>' AND email_verified AND two_factor_enabled;",
    );
    expect(doc).toContain("Revoke with `SET is_platform_admin = false`");
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

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

  it("documents the operator procedure: verified email required, revocation", () => {
    const doc = read("docs/STORAGE_PROVIDERS.md");
    expect(doc).toContain(
      "UPDATE users SET is_platform_admin = true WHERE email = '<staff email>' AND email_verified;",
    );
    expect(doc).toContain("Revoke with `SET is_platform_admin = false`");
  });

  it("keeps MFA and fresh-session checks as open, mandatory production blockers", () => {
    const doc = read("docs/STORAGE_PROVIDERS.md");
    const gate = doc.slice(doc.indexOf("## 9. Production gate"));
    expect(gate).toContain("do **not** grant `is_platform_admin` in production");
    expect(gate).toMatch(
      /\*\*MFA for platform administrators\*\*[^\n]*\*\*Open — NOT enforced\*\*/,
    );
    expect(gate).toMatch(/\*\*Fresh session for changes\*\*[^\n]*\*\*Open — NOT enforced\*\*/);
    // The code says the same (no claim that these are enforced).
    expect(read("src/server/admin/platform-admin.ts")).toContain(
      "MFA and fresh-session checks\n// are NOT enforced yet",
    );
  });
});

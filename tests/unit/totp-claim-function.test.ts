import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { USED_TOTP_CODE_TTL_MS } from "@/server/auth/totp-replay";

// Static guarantees of the TOTP claim path (migration 20261014150000, db-roles.sql,
// src/server/auth/totp-replay.ts). Behaviour, concurrency and role limits are tested
// against a database in tests/integration/totp-claim-roles.test.ts and admin-mfa.test.ts.

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const migration = read("prisma/migrations/20261014150000_totp_claim_function/migration.sql");
const code = (text: string) => text.replace(/^\s*--.*$/gm, "");

describe("TOTP claim function", () => {
  it("is SECURITY DEFINER with a fixed search_path, schema-qualified, no dynamic SQL, not for PUBLIC", () => {
    const sql = code(migration);
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog, pg_temp");
    expect(sql).not.toMatch(/\bEXECUTE\s+(format|'|\$)/i);
    for (const statement of sql.match(/\b(DELETE FROM|INSERT INTO)\s+\S+/g) ?? []) {
      expect(statement).toMatch(/public\.two_factor_used_codes$/);
    }
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.two_factor_claim_code(uuid, text) FROM PUBLIC;",
    );
  });

  it("deletes only the caller's account and only expired claims, by the database clock", () => {
    const sql = code(migration);
    const deletion = sql.slice(
      sql.indexOf("DELETE FROM"),
      sql.indexOf(";", sql.indexOf("DELETE FROM")),
    );
    expect(deletion).toMatch(/WHERE user_id = p_user_id\s+AND expires_at < pg_catalog\.now\(\)/);
    expect(sql.match(/DELETE FROM/g)).toHaveLength(1);
    expect(sql).toContain("ON CONFLICT (user_id, code_hash) DO NOTHING");
    expect(sql).toMatch(/p_code_hash !~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  it("keeps the lifetime equal to USED_TOTP_CODE_TTL_MS", () => {
    const minutes = /pg_catalog\.now\(\) \+ interval '(\d+) minutes'/.exec(code(migration));
    expect(Number(minutes?.[1]) * 60_000).toBe(USED_TOTP_CODE_TTL_MS);
  });

  it("the application claims only through the function", () => {
    const replay = code(
      read("src/server/auth/totp-replay.ts").replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""),
    );
    expect(replay).toContain("public.two_factor_claim_code(");
    expect(replay).not.toMatch(/two_factor_used_codes|twoFactorUsedCode/);
  });

  it("the role script gives the limited roles EXECUTE and no table privilege", () => {
    const script = code(read("scripts/ops/sql/db-roles.sql"));
    expect(script).toContain(
      "GRANT EXECUTE ON FUNCTION public.two_factor_claim_code(uuid, text) TO %I, %I', app_r, grant_r",
    );
    expect(script).toContain("REVOKE ALL ON public.two_factor_used_codes FROM %I', app_r");
    expect(script).not.toMatch(/GRANT[^;]*ON public\.two_factor_used_codes/);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Static guards for the runtime tenancy layer (Phase 2, step 3).

const ROOT = join(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(join(ROOT, "src"))
  .map((path) => relative(ROOT, path).split("\\").join("/"))
  .filter((path) => !path.startsWith("src/generated/"));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("tenancy boundaries", () => {
  it("only the tenancy layer constructs a TenantContext", () => {
    const offenders = files.filter(
      (path) =>
        !path.startsWith("src/server/tenancy/") && /\bcreateTenantContext\s*\(/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the session, access and context modules server-only", () => {
    for (const path of [
      "src/server/auth/session.ts",
      "src/server/tenancy/access.ts",
      "src/server/tenancy/context.ts",
      "src/server/http/action-handler.ts",
    ]) {
      expect(read(path).startsWith('import "server-only";')).toBe(true);
    }
  });

  it("client components never import server modules", () => {
    const clientFiles = files.filter((path) => /^\s*["']use client["']/.test(read(path)));
    expect(clientFiles.length).toBeGreaterThan(0);
    const offenders = clientFiles.filter((path) =>
      /from\s+["'](@\/server|\.\.?\/.*server)/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the unguarded system client to reviewed call sites", () => {
    const users = files.filter(
      (path) => path !== "src/server/db/client.ts" && /\bgetSystemDb\s*\(/.test(read(path)),
    );
    expect(users.sort()).toEqual([
      "src/server/auth/auth.ts",
      "src/server/health/health-service.ts",
      "src/server/tenancy/access.ts",
    ]);
  });
});

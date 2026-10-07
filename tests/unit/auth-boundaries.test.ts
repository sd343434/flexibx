import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Static guard: raw session tokens and auth tables stay inside the auth layer.
// (The tenant guard enforces the same at runtime for the application client.)

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");
const ALLOWED = ["src/server/auth/", "src/generated/"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC)
  .map((path) => relative(ROOT, path).split("\\").join("/"))
  .filter((path) => !ALLOWED.some((prefix) => path.startsWith(prefix)));

describe("auth data boundaries", () => {
  it("scans application sources", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each([
    [
      "Prisma access to auth tables",
      /\.\s*(session|account|verification)\s*\.\s*(find|create|update|upsert|delete|count|aggregate|groupBy)\w*\s*\(/,
    ],
    [
      "raw SQL on auth tables",
      /\b(from|into|update|join)\s+"?(sessions|accounts|verifications)\b/i,
    ],
    ["reading a session token", /\bsession\s*\??\.\s*token\b/],
  ])("no application code outside src/server/auth uses %s", (_label, pattern) => {
    const offenders = files.filter((path) => pattern.test(readFileSync(join(ROOT, path), "utf8")));
    expect(offenders).toEqual([]);
  });
});

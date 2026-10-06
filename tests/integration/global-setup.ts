import { execFileSync } from "node:child_process";

import { resolveTestDatabaseUrl } from "./test-database";

/** Applies all committed migrations to the dedicated test database once per run. */
export default function setup() {
  const url = resolveTestDatabaseUrl();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}

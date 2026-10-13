// The only supported way to make someone a platform administrator
// (src/server/admin/platform-admin-grant.ts, docs/runbooks/ADMIN_PROVISIONING.md).
//
//   pnpm admin:grant --email staff@example.com --confirm staff@example.com \
//     --operator "name" --reason "TICKET-123: identity verified by video call"
//
// The script then asks for the CURRENT code from the person's own authenticator, read to
// the operator during the identity-verified call. On a terminal the code is typed without
// echo (code-input.ts); it is never accepted on the command line (shell history, process
// list), never printed and never logged, and it is single-use.
//
// Database credential: ADMIN_GRANT_DATABASE_URL — the operator grant role of
// docs/runbooks/DATABASE_ROLES.md, the only role allowed to execute
// public.platform_admin_grant. Without it, DATABASE_URL is used (single-role development
// databases; with the production role model the runtime role is refused by the database).
// Also needs AUTH_SECRET (to read the enrolled secret). A local .env file is loaded when
// present. Prints one JSON line. Exit code 0 = granted (or already an administrator),
// 2 = refused or denied, 1 = error, 130 = cancelled.

import { parseArgs } from "node:util";

import { grantPlatformAdmin } from "@/server/admin/platform-admin-grant";
import { createPrismaClient } from "@/server/db/prisma";

import { CodeInputCancelled, readCode, restoreTerminal } from "./code-input";

function print(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// A signal while the code is being typed must not leave the terminal without echo.
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
for (const signal of Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]) {
  process.once(signal, () => {
    restoreTerminal();
    process.exit(SIGNAL_EXIT[signal]);
  });
}
process.once("exit", restoreTerminal);

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: "string" },
        confirm: { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // Unknown options (e.g. a code passed on the command line) are refused, not echoed.
    print({ status: "REFUSED", why: "unknown argument; the code is read from standard input" });
    process.exitCode = 2;
    return;
  }
  const email = values.email?.trim().toLowerCase() ?? "";
  if (email === "" || values.confirm?.trim().toLowerCase() !== email) {
    print({ status: "REFUSED", why: "--confirm must repeat --email" });
    process.exitCode = 2;
    return;
  }
  const authSecret = process.env.AUTH_SECRET ?? "";
  if (authSecret.length < 32) {
    print({ status: "REFUSED", why: "AUTH_SECRET is not configured" });
    process.exitCode = 2;
    return;
  }
  const databaseUrl = (
    process.env.ADMIN_GRANT_DATABASE_URL ??
    process.env.DATABASE_URL ??
    ""
  ).trim();
  if (databaseUrl === "") {
    print({ status: "REFUSED", why: "ADMIN_GRANT_DATABASE_URL is not configured" });
    process.exitCode = 2;
    return;
  }

  let code: string;
  try {
    code = await readCode("Current 6-digit code from the person's authenticator: ");
  } catch (error) {
    if (!(error instanceof CodeInputCancelled)) throw error;
    print({ status: "CANCELLED" });
    process.exitCode = 130;
    return;
  }

  const system = createPrismaClient(databaseUrl);
  try {
    const result = await grantPlatformAdmin(
      { system, authSecret },
      { email, operator: values.operator ?? "", reason: values.reason ?? "", code },
    );
    print(result);
    if (result.status === "DENIED") process.exitCode = 2;
  } finally {
    await system.$disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  restoreTerminal();
  // The error class only: messages may contain SQL or connection details.
  process.stderr.write(
    `${JSON.stringify({ status: "FAILED", error: error instanceof Error ? error.name : "unknown" })}\n`,
  );
  process.exitCode = 1;
});

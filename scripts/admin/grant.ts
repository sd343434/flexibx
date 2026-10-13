// The only supported way to make someone a platform administrator
// (src/server/admin/platform-admin-grant.ts, docs/runbooks/ADMIN_PROVISIONING.md).
//
//   pnpm admin:grant --email staff@example.com --confirm staff@example.com \
//     --operator "name" --reason "TICKET-123: identity verified by video call"
//
// The script then asks for the CURRENT code from the person's own authenticator, read to
// the operator during the identity-verified call. The code is read from standard input,
// never from the command line (shell history, process list); it is single-use and is
// never printed or logged. Needs DATABASE_URL and AUTH_SECRET (a local .env file is loaded
// when present). Prints one JSON line. Exit code 0 = granted (or already an administrator),
// 2 = refused or denied, 1 = error.

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { grantPlatformAdmin } from "@/server/admin/platform-admin-grant";
import { getSystemDb } from "@/server/db/client";

function print(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function readCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    process.stderr.write("Current 6-digit code from the person's authenticator: ");
    for await (const line of rl) return line.trim();
    return "";
  } finally {
    rl.close();
  }
}

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
  const code = await readCode();
  const result = await grantPlatformAdmin(
    { system: getSystemDb(), authSecret },
    { email, operator: values.operator ?? "", reason: values.reason ?? "", code },
  );
  print(result);
  if (result.status === "DENIED") process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ status: "FAILED", error: error instanceof Error ? error.name : "unknown" })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([Promise.resolve().then(() => getSystemDb().$disconnect())]);
  });

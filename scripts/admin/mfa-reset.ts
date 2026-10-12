// Operator recovery: turns off two-factor authentication for one account and ends all of
// its sessions (src/server/auth/mfa-reset.ts). Only for a user who lost the authenticator
// AND every backup code, after verifying their identity out of band (runbook:
// docs/runbooks/INCIDENT_RESPONSE.md, "Lost administrator second factor").
//
//   pnpm admin:mfa-reset --email user@example.com --confirm user@example.com \
//     --operator "name or ticket" --reason "TICKET-123: identity verified by video call"
//
// Needs DATABASE_URL (a local .env file is loaded when present). Prints one JSON line
// with the outcome; never prints secrets. Exit code 0 = reset, 2 = refused or not found.

import { parseArgs } from "node:util";

import { resetUserMfa } from "@/server/auth/mfa-reset";
import { getSystemDb } from "@/server/db/client";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      confirm: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
  });
  const email = values.email?.trim().toLowerCase() ?? "";
  if (email === "" || values.confirm?.trim().toLowerCase() !== email) {
    process.stdout.write(
      `${JSON.stringify({ status: "REFUSED", why: "--confirm must repeat --email" })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const result = await resetUserMfa(getSystemDb(), {
    email,
    operator: values.operator ?? "",
    reason: values.reason ?? "",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "RESET") process.exitCode = 2;
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

import { createHash } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";

// TOTP replay guard. Better Auth accepts a TOTP code again for as long as it is valid
// (±1 step of 30 s); Flexibx accepts each code once per account. Pure (no `server-only`).

/**
 * How long a used TOTP code is remembered: longer than its acceptance window (±1 step).
 * Enforced by the database function (migration 20261014150000: `interval '3 minutes'`);
 * this constant documents it and a unit test keeps the two equal.
 */
export const USED_TOTP_CODE_TTL_MS = 3 * 60_000;

/**
 * Records that `code` was used by `userId`; false when it already was (a replay). One call
 * of `public.two_factor_claim_code` (SECURITY DEFINER): it removes only this account's
 * claims expired by the database clock and inserts the claim with INSERT … ON CONFLICT,
 * so of concurrent uses of one code exactly one gets true. The runtime and grant roles
 * have no table privilege on two_factor_used_codes (scripts/ops/sql/db-roles.sql), so they
 * cannot delete an unexpired claim. Only a hash of the account and code reaches the
 * database. A database error is thrown, never reported as a fresh code.
 */
export async function claimTotpCode(
  db: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  code: string,
): Promise<boolean> {
  const codeHash = createHash("sha256").update(`${userId}:${code}`).digest("hex");
  const rows = await db.$queryRaw<{ claimed: boolean }[]>`
    SELECT public.two_factor_claim_code(${userId}::uuid, ${codeHash}) AS "claimed"`;
  return rows.length === 1 && rows[0]?.claimed === true;
}

import { createHash } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";

// TOTP replay guard. Better Auth accepts a TOTP code again for as long as it is valid
// (±1 step of 30 s); Flexibx accepts each code once per account. Pure (no `server-only`).

/** How long a used TOTP code is remembered: longer than its acceptance window (±1 step). */
export const USED_TOTP_CODE_TTL_MS = 3 * 60_000;

/**
 * Records that `code` was used by `userId`; false when it already was (a replay). One
 * atomic INSERT … ON CONFLICT: of concurrent uses of one code exactly one gets true. A
 * database error is thrown, never reported as a fresh code. Expired records of the user
 * are removed first (bounded: one user, a few minutes of codes).
 */
export async function claimTotpCode(
  db: Pick<PrismaClient, "twoFactorUsedCode" | "$queryRaw">,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const codeHash = createHash("sha256").update(`${userId}:${code}`).digest("hex");
  await db.twoFactorUsedCode.deleteMany({ where: { userId, expiresAt: { lt: now } } });
  const inserted = await db.$queryRaw<{ userId: string }[]>`
    INSERT INTO "two_factor_used_codes" ("user_id", "code_hash", "expires_at")
    VALUES (${userId}::uuid, ${codeHash}, ${new Date(now.getTime() + USED_TOTP_CODE_TTL_MS)})
    ON CONFLICT ("user_id", "code_hash") DO NOTHING
    RETURNING "user_id" AS "userId"`;
  return inserted.length === 1;
}

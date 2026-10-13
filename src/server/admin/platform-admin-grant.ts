import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";

import { decryptTotpSecret, verifyTotpCode } from "../auth/totp";
import { claimTotpCode } from "../auth/totp-replay";
import { redactString } from "../redact";

// The only way to make someone a platform administrator (scripts/admin/grant.ts,
// docs/runbooks/ADMIN_PROVISIONING.md). Pure (no `server-only`) for tests.
//
// Proof of possession: the person reads a current code from THEIR authenticator to the
// operator, who has verified their identity out of band. The code must match the secret
// stored for that account and is consumed (replay guard), so an attacker who merely knows
// the password — and enrolled their own device — cannot pass: the real person's code will
// not match, which also exposes the hijacked enrollment. The database refuses the flag
// without this transaction's grant marker, a verified email and two-factor
// (migration 20261014120000_platform_admin_grant_guard).

export const grantInputSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  operator: z.string().trim().min(2).max(80),
  reason: z.string().trim().min(5).max(500),
  code: z.string().trim().max(16),
});

export type GrantInput = z.input<typeof grantInputSchema>;

export type GrantDenial =
  "NOT_FOUND" | "EMAIL_UNVERIFIED" | "MFA_NOT_ENROLLED" | "MFA_LOCKED" | "INVALID_CODE";

export type GrantResult =
  | { readonly status: "GRANTED"; readonly userId: string }
  | { readonly status: "ALREADY_ADMIN"; readonly userId: string }
  | { readonly status: "DENIED"; readonly reason: GrantDenial };

export interface GrantDeps {
  readonly system: PrismaClient;
  /** AUTH_SECRET: Better Auth encrypted the TOTP secret with it. */
  readonly authSecret: string;
  readonly now?: () => Date;
}

export async function grantPlatformAdmin(deps: GrantDeps, input: GrantInput): Promise<GrantResult> {
  const { email, operator, reason, code } = grantInputSchema.parse(input);
  const now = deps.now?.() ?? new Date();
  const metadata = { operator: redactString(operator), reason: redactString(reason) };

  const outcome = await deps.system.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string; emailVerified: boolean; twoFactorEnabled: boolean; isPlatformAdmin: boolean }[]
    >`SELECT id, email_verified AS "emailVerified", two_factor_enabled AS "twoFactorEnabled",
             is_platform_admin AS "isPlatformAdmin"
      FROM users WHERE email = ${email} FOR UPDATE`;
    const user = rows[0];
    if (user === undefined) return { status: "DENIED" as const, reason: "NOT_FOUND" as const };
    if (user.isPlatformAdmin) return { status: "ALREADY_ADMIN" as const, userId: user.id };

    const factor = await tx.twoFactor.findUnique({
      where: { userId: user.id },
      select: { secret: true, verified: true, lockedUntil: true },
    });
    const denial: GrantDenial | null = !user.emailVerified
      ? "EMAIL_UNVERIFIED"
      : !user.twoFactorEnabled || !factor?.verified
        ? "MFA_NOT_ENROLLED"
        : factor.lockedUntil !== null && factor.lockedUntil > now
          ? "MFA_LOCKED"
          : null;
    if (denial !== null || factor === null) {
      return { status: "DENIED" as const, reason: denial ?? "MFA_NOT_ENROLLED", userId: user.id };
    }

    const secret = await decryptTotpSecret(deps.authSecret, factor.secret);
    // The code is checked against the stored secret, then consumed: the same code can
    // never also complete a sign-in (or a second grant).
    if (!verifyTotpCode(secret, code, now)) {
      return { status: "DENIED" as const, reason: "INVALID_CODE" as const, userId: user.id };
    }
    if (!(await claimTotpCode(tx, user.id, code, now))) {
      return { status: "DENIED" as const, reason: "INVALID_CODE" as const, userId: user.id };
    }

    await tx.$queryRaw`SELECT set_config('flexibx.platform_admin_grant', ${user.id}, true)`;
    await tx.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
    await tx.auditLog.create({
      data: {
        workspaceId: null,
        actorUserId: null,
        action: "platform_admin.granted",
        entityType: "user",
        entityId: user.id,
        metadata,
      },
    });
    return { status: "GRANTED" as const, userId: user.id };
  });

  // A denial for a known account is audited (outside the transaction, which only read).
  if (outcome.status === "DENIED" && "userId" in outcome) {
    await deps.system.auditLog.create({
      data: {
        workspaceId: null,
        actorUserId: null,
        action: "platform_admin.grant_denied",
        entityType: "user",
        entityId: outcome.userId,
        metadata: { ...metadata, denial: outcome.reason },
      },
    });
    return { status: "DENIED", reason: outcome.reason };
  }
  return outcome;
}

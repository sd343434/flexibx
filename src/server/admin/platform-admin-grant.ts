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
// not match, which also exposes the hijacked enrollment.
//
// The flag itself is set by the SECURITY DEFINER function public.platform_admin_grant
// (migration 20261014140000), in the same transaction as the code check and claim. With
// the role model of docs/runbooks/DATABASE_ROLES.md only the operator grant role can
// execute it, and the runtime role has no privilege on the column at all. The database
// cannot verify the TOTP code itself (the secret is encrypted with AUTH_SECRET): that
// check is this service's, run by an operator who holds the grant credential.

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

const DATABASE_DENIALS = new Set<string>([
  "NOT_FOUND",
  "EMAIL_UNVERIFIED",
  "MFA_NOT_ENROLLED",
  "MFA_LOCKED",
] satisfies GrantDenial[]);

/** The function refused after the checks here passed (a concurrent change): roll back. */
class GrantRefusedByDatabase extends Error {
  constructor(
    readonly result: string,
    readonly userId: string,
  ) {
    super("platform_admin_grant refused");
  }
}

export async function grantPlatformAdmin(deps: GrantDeps, input: GrantInput): Promise<GrantResult> {
  const { email, operator, reason, code } = grantInputSchema.parse(input);
  const now = deps.now?.() ?? new Date();
  const metadata = { operator: redactString(operator), reason: redactString(reason) };

  type Outcome =
    | { status: "DENIED"; reason: GrantDenial; userId?: string }
    | { status: "ALREADY_ADMIN" | "GRANTED"; userId: string };
  let outcome: Outcome;
  try {
    outcome = await deps.system.$transaction(async (tx): Promise<Outcome> => {
      // No row lock here (the grant role has no UPDATE privilege); the database function
      // locks the account and re-checks every precondition before it changes anything.
      const rows = await tx.$queryRaw<
        {
          id: string;
          emailVerified: boolean;
          twoFactorEnabled: boolean;
          isPlatformAdmin: boolean;
        }[]
      >`SELECT id, email_verified AS "emailVerified", two_factor_enabled AS "twoFactorEnabled",
             is_platform_admin AS "isPlatformAdmin"
      FROM users WHERE email = ${email}`;
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
      if (!(await claimTotpCode(tx, user.id, code))) {
        return { status: "DENIED" as const, reason: "INVALID_CODE" as const, userId: user.id };
      }

      // Sets the flag and writes the `platform_admin.granted` audit entry.
      const granted = await tx.$queryRaw<{ result: string }[]>`
      SELECT public.platform_admin_grant(${user.id}::uuid, ${metadata.operator}, ${metadata.reason}) AS result`;
      const result = granted[0]?.result ?? "";
      if (result === "GRANTED") return { status: "GRANTED" as const, userId: user.id };
      // Changed between the checks above and the function's locked re-check: nothing is
      // kept (the code claim is rolled back too).
      throw new GrantRefusedByDatabase(result, user.id);
    });
  } catch (error) {
    if (!(error instanceof GrantRefusedByDatabase)) throw error;
    outcome =
      error.result === "ALREADY_ADMIN"
        ? { status: "ALREADY_ADMIN", userId: error.userId }
        : {
            status: "DENIED",
            reason: DATABASE_DENIALS.has(error.result)
              ? (error.result as GrantDenial)
              : "NOT_FOUND",
            userId: error.userId,
          };
  }

  // A denial for a known account is audited (outside the transaction, which only read).
  if (outcome.status === "DENIED" && outcome.userId !== undefined) {
    // createMany: no RETURNING, so the grant role needs INSERT only (DATABASE_ROLES.md).
    await deps.system.auditLog.createMany({
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

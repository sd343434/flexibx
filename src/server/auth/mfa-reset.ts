import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";

import { redactString } from "../redact";

// Operator recovery for a user who lost both the authenticator and every backup code
// (scripts/admin/mfa-reset.ts; runbook docs/runbooks/INCIDENT_RESPONSE.md). Needs direct
// database access — no web or API path reaches it. In one transaction it removes the
// account's two-factor secret and backup codes, turns two-factor off and ENDS EVERY
// SESSION of the account (so nothing signed in keeps any access), removes the platform
// administrator flag (database trigger) and writes audit entries. The user then signs in
// with the password and enrolls again; a former administrator needs a NEW grant
// (docs/runbooks/ADMIN_PROVISIONING.md) — re-enrolling never restores admin access.
// Pure (no `server-only`) so integration tests drive it directly.

export const mfaResetInputSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  /** Who performed the reset (operator name or ticket), for the audit trail. */
  operator: z.string().trim().min(2).max(80),
  /** Why (ticket reference and identity check performed). Never a secret. */
  reason: z.string().trim().min(5).max(500),
});

export type MfaResetInput = z.input<typeof mfaResetInputSchema>;

export type MfaResetResult =
  | { readonly status: "RESET"; readonly userId: string; readonly sessionsEnded: number }
  | { readonly status: "NOT_FOUND" };

export async function resetUserMfa(
  system: PrismaClient,
  input: MfaResetInput,
): Promise<MfaResetResult> {
  const { email, operator, reason } = mfaResetInputSchema.parse(input);
  return system.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email },
      select: { id: true, isPlatformAdmin: true },
    });
    if (user === null) return { status: "NOT_FOUND" as const };
    await tx.twoFactor.deleteMany({ where: { userId: user.id } });
    // Turning two-factor off also removes the administrator flag (database trigger,
    // migration 20261014120000).
    await tx.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false } });
    const sessions = await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.create({
      data: {
        workspaceId: null,
        actorUserId: null,
        action: "user.mfa_reset_by_operator",
        entityType: "user",
        entityId: user.id,
        // Free text from the operator: credentials pasted by mistake are redacted.
        metadata: {
          operator: redactString(operator),
          reason: redactString(reason),
          sessionsEnded: sessions.count,
        },
      },
    });
    if (user.isPlatformAdmin) {
      await tx.auditLog.create({
        data: {
          workspaceId: null,
          actorUserId: null,
          action: "platform_admin.revoked",
          entityType: "user",
          entityId: user.id,
          metadata: { cause: "mfa_reset", operator: redactString(operator) },
        },
      });
    }
    return { status: "RESET" as const, userId: user.id, sessionsEnded: sessions.count };
  });
}

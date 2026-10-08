import { AppError } from "../errors/app-error";

// Email-verification enforcement (decision C6). Sign-in, the session and workspace
// creation never depend on it (decision C1). When the policy applies
// (AUTH_REQUIRE_EMAIL_VERIFICATION; default: production only), an operation that relies on
// the account owning its email address calls `requireVerifiedEmail` before doing anything
// else. In Phase 2 that is accepting (and previewing) a workspace invitation, whose only
// proof of identity is the invited address (decision C4). Pure, for unit tests.

export function emailNotVerified(): AppError {
  return new AppError("FORBIDDEN", {
    message: "A verified email address is required for this operation",
    fields: [{ path: "email", code: "email_not_verified" }],
    metadata: { reason: "email_not_verified" },
  });
}

/** Whether `user` may run a verified-only operation under the given policy. */
export function hasRequiredEmailVerification(
  user: { readonly emailVerified: boolean },
  policy: { readonly requireEmailVerification: boolean },
): boolean {
  return !policy.requireEmailVerification || user.emailVerified;
}

/** Throws FORBIDDEN `email_not_verified` unless `user` may run a verified-only operation. */
export function requireVerifiedEmail(
  user: { readonly emailVerified: boolean },
  policy: { readonly requireEmailVerification: boolean },
): void {
  if (!hasRequiredEmailVerification(user, policy)) throw emailNotVerified();
}

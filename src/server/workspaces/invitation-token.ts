import { createHash, randomBytes } from "node:crypto";

import type { Locale } from "@/i18n/config";

// One-time invitation tokens. Pure (no `server-only`) for unit tests.
//
// The plaintext token is 32 random bytes (base64url, 43 characters). It exists only in
// the link shown once to the inviter (and in the email, once a provider exists); the
// database stores its SHA-256 hash. A fast hash is enough here: the input is 256 bits of
// randomness, not a guessable secret, so a stolen hash cannot be brute-forced back.

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && INVITATION_TOKEN_PATTERN.test(value);
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

/** The accept link. The origin is always APP_URL — never a request header or input. */
export function buildInvitationUrl(appUrl: string, locale: Locale, token: string): string {
  return new URL(`/${locale}/invite/${token}`, appUrl).toString();
}

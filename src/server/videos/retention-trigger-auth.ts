import { createHash, timingSafeEqual } from "node:crypto";

// Authorization for the scheduler-facing retention endpoint. Pure (no `server-only`) for
// unit tests. The secret is compared in constant time via fixed-length digests, so
// neither its value nor its length leaks through timing.

const BEARER = /^Bearer ([^\s]+)$/;

export function isAuthorizedRetentionTrigger(
  authorization: string | null,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length < 32 || authorization === null) return false;
  const match = BEARER.exec(authorization.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(secret));
}

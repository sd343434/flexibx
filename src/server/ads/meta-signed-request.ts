import { createHmac, timingSafeEqual } from "node:crypto";

// Meta's `signed_request` (deauthorize and data deletion callbacks): two base64url parts,
// `signature.payload`, where signature = HMAC-SHA256(payload part, app secret). Pure (no
// `server-only`) for unit tests. Nothing in the payload is trusted before the signature
// is verified in constant time.
// https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow#deauth-callback

export interface MetaSignedRequest {
  /** The app-scoped user id, the same id Flexibx stores when the person connects. */
  readonly userId: string;
  readonly issuedAt: number | null;
}

const MAX_SIGNED_REQUEST_LENGTH = 4096;
const PART = /^[A-Za-z0-9_-]+$/;

export function parseMetaSignedRequest(
  value: string | null,
  appSecret: string,
): MetaSignedRequest | null {
  if (value === null || value.length > MAX_SIGNED_REQUEST_LENGTH) return null;
  const [signaturePart, payloadPart, extra] = value.split(".");
  if (extra !== undefined || signaturePart === undefined || payloadPart === undefined) return null;
  if (!PART.test(signaturePart) || !PART.test(payloadPart)) return null;
  const presented = Buffer.from(signaturePart, "base64url");
  const expected = createHmac("sha256", appSecret).update(payloadPart, "utf8").digest();
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  if (typeof fields.algorithm !== "string" || fields.algorithm.toUpperCase() !== "HMAC-SHA256") {
    return null;
  }
  const userId = fields.user_id;
  if (typeof userId !== "string" || !/^\d{1,64}$/.test(userId)) return null;
  const issuedAt = fields.issued_at;
  return {
    userId,
    issuedAt: typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) ? issuedAt : null,
  };
}

/** Builds a signed_request (tests and local verification only). */
export function signMetaRequest(payload: Record<string, unknown>, appSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", appSecret).update(body, "utf8").digest("base64url");
  return `${signature}.${body}`;
}

/**
 * The confirmation code Meta shows the person after a data deletion request: derived from
 * the request (no table needed), not reversible to the user id without the app secret.
 */
export function deletionConfirmationCode(request: MetaSignedRequest, appSecret: string): string {
  return createHmac("sha256", appSecret)
    .update(`data-deletion:${request.userId}:${String(request.issuedAt ?? 0)}`, "utf8")
    .digest("hex")
    .slice(0, 20);
}

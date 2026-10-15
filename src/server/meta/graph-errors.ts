// Graph API error codes → the failure kinds every Meta Graph client shares (advertising,
// WhatsApp, Page publishing and the Social Manager). Pure. Each client adds only its own
// cases on top: the advertising adapters fall back on the HTTP status, the Social
// Manager recognizes a closed messaging window. Codes:
// https://developers.facebook.com/docs/graph-api/guides/error-handling

export type GraphFailureKind =
  "token_expired" | "permission_missing" | "rate_limited" | "invalid_request";

/** The shared kind for a Graph error code, or null when the code says nothing usable. */
export function graphFailureKind(code: number | null): GraphFailureKind | null {
  if (code === null) return null;
  // 190 invalid/expired token, 102 session, 463/467 expired or invalid access token.
  if (code === 190 || code === 102 || code === 463 || code === 467) return "token_expired";
  // 10 and 200–299 missing permission, 3 capability missing.
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) return "permission_missing";
  // 4 app, 17 user, 32 Page, 613 custom rate limits; 80000–80014 business use case limits.
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    (code >= 80000 && code <= 80014)
  ) {
    return "rate_limited";
  }
  if (code === 100) return "invalid_request";
  return null;
}

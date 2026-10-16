// The content page's publishing card turns hold reasons and post error codes into
// messages: every reason and every error kind needs an Arabic and an English text, and
// every error code the server can store on a post maps to a kind a person can act on.
import { describe, expect, it } from "vitest";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { AD_FAILURES } from "@/server/ads/adapter";
import {
  PUBLICATION_ERROR_KINDS,
  PUBLISHING_BLOCKERS,
  publicationErrorKind,
} from "@/server/social/publishing-readiness";

const publishing = { ar: ar.social.publishing, en: en.social.publishing } as const;

// SocialFailure (meta-social.ts) — the kinds a Page write can fail with.
const SOCIAL_FAILURES = [
  "token_expired",
  "permission_missing",
  "rate_limited",
  "invalid_request",
  "provider_error",
];
// Codes written by publishing.ts, queued-posts.ts and the stuck-post recovery.
const POST_CODES = [
  "content_not_approved",
  "unscheduled",
  "marked_published",
  "channel_disabled",
  "missed_window",
  "not_published_confirmed",
  "no_answer",
  "page_unavailable",
];
// AppError field codes pageFor can surface (social_* and the ads token helpers).
const APP_CODES = [
  "social_not_configured",
  "social_page_unavailable",
  "ads_not_configured",
  "ads_not_connected",
  "ads_outcome_unknown",
  ...AD_FAILURES.map(
    (kind) =>
      ({
        oauth_invalid: "ads_oauth_invalid",
        permission_missing: "ads_permission_missing",
        token_expired: "ads_token_expired",
        rate_limited: "ads_rate_limited",
        invalid_request: "ads_provider_error",
        provider_error: "ads_provider_error",
        unavailable: "ads_operation_unavailable",
      })[kind],
  ),
];

describe("publishing card messages", () => {
  it.each(["ar", "en"] as const)("%s: every hold reason and error kind has a text", (locale) => {
    const messages = publishing[locale];
    for (const blocker of PUBLISHING_BLOCKERS) {
      expect(messages.onHold[blocker], blocker).toEqual(expect.any(String));
    }
    for (const kind of PUBLICATION_ERROR_KINDS) {
      expect(messages.errors[kind], kind).toEqual(expect.any(String));
    }
    expect(messages.onHold.scheduler_stale).toContain("{last}");
    // The old "publish now" label promised instant publishing.
    expect("publishNow" in messages).toBe(false);
  });

  it("every code the server stores on a post has a specific kind", () => {
    for (const code of [...SOCIAL_FAILURES, ...POST_CODES, ...APP_CODES]) {
      expect(publicationErrorKind(code), code).not.toBe("other");
    }
  });

  it("maps codes to what a person should do", () => {
    expect(publicationErrorKind(null)).toBeNull();
    expect(publicationErrorKind("ads_token_expired")).toBe("reconnect");
    expect(publicationErrorKind("token_expired")).toBe("reconnect");
    expect(publicationErrorKind("missed_window")).toBe("missed_window");
    expect(publicationErrorKind("ads_outcome_unknown")).toBe("no_answer");
    expect(publicationErrorKind("CONFLICT")).toBe("other");
    expect(publicationErrorKind("something_new")).toBe("other");
  });
});

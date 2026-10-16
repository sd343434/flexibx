// The content page's publishing card turns hold reasons and post error codes into
// messages: every reason and every error kind needs an Arabic and an English text, and
// every error code the server can store on a post maps to a kind a person can act on.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { LtrText } from "@/components/common/ltr-text";
import { AD_FAILURES } from "@/server/ads/adapter";
import { hasImageSignature } from "@/server/social/publishing";
import {
  PUBLICATION_DISPLAY_STATES,
  PUBLICATION_ERROR_KINDS,
  PUBLISHING_BLOCKERS,
  publicationDisplayState,
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
  "image_missing",
  "image_unavailable",
  "image_invalid",
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
    for (const state of PUBLICATION_DISPLAY_STATES) {
      expect(messages.display[state], state).toEqual(expect.any(String));
    }
    // The post id is rendered separately, isolated left-to-right (LtrText).
    expect(messages.publishedRef).not.toContain("{id}");
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

describe("publication display state", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
  const post = (status: string, offsetMs = -60_000) => ({ status, scheduledAt: at(offsetMs) });

  it("tells queued, scheduled and held posts apart", () => {
    expect(publicationDisplayState(post("SCHEDULED", 60_000), now, [])).toBe("scheduled");
    expect(publicationDisplayState(post("SCHEDULED"), now, [])).toBe("queued");
    // Due exactly now counts as due.
    expect(publicationDisplayState(post("SCHEDULED", 0), now, [])).toBe("queued");
    expect(publicationDisplayState(post("SCHEDULED"), now, ["scheduler_stale"])).toBe("on_hold");
    // A future post is "scheduled" even while the server would hold it later.
    expect(publicationDisplayState(post("SCHEDULED", 60_000), now, ["sending_disabled"])).toBe(
      "scheduled",
    );
  });

  it("only a confirmed outcome reads as published; uncertain stays uncertain", () => {
    expect(publicationDisplayState(post("PUBLISHING"), now, [])).toBe("publishing");
    expect(publicationDisplayState(post("PUBLISHED"), now, [])).toBe("published");
    expect(publicationDisplayState(post("UNCERTAIN"), now, [])).toBe("uncertain");
    expect(publicationDisplayState(post("UNCERTAIN"), now, ["sending_disabled"])).toBe("uncertain");
    expect(publicationDisplayState(post("FAILED"), now, [])).toBe("failed");
    expect(publicationDisplayState(post("CANCELLED"), now, [])).toBe("cancelled");
    // Anything unknown is never shown as published.
    expect(publicationDisplayState(post("SOMETHING_NEW"), now, [])).toBe("failed");
  });
});

describe("image signature check", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

  it("accepts real PNG and JPEG headers only for their declared type", () => {
    expect(hasImageSignature(png, "image/png")).toBe(true);
    expect(hasImageSignature(jpeg, "image/jpeg")).toBe(true);
    expect(hasImageSignature(png, "image/jpeg")).toBe(false);
    expect(hasImageSignature(jpeg, "image/png")).toBe(false);
    expect(hasImageSignature(png, "image/webp")).toBe(false);
    expect(hasImageSignature(new TextEncoder().encode("<svg/>"), "image/png")).toBe(false);
    expect(hasImageSignature(new Uint8Array(), "image/jpeg")).toBe(false);
  });
});

describe("post ids in right-to-left text", () => {
  it("are isolated left-to-right so their parts keep their order", () => {
    const html = renderToStaticMarkup(
      createElement(
        "p",
        { dir: "rtl" },
        "منشور فيسبوك ",
        createElement(LtrText, null, "777000_1029"),
      ),
    );
    expect(html).toContain('<bdi dir="ltr">777000_1029</bdi>');
  });
});

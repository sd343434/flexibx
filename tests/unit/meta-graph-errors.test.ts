import { describe, expect, it } from "vitest";

import { AdPlatformError } from "@/server/ads/adapter";
import { metaFailure } from "@/server/ads/adapters/meta";
import { graphFailureKind } from "@/server/meta/graph-errors";
import {
  createMetaSocial,
  SocialPlatformError,
  type ManagedPage,
} from "@/server/social/meta-social";

// One Graph error table for advertising and the Social Manager, with each path's own
// cases on top: the advertising adapters fall back on the HTTP status, the Social Manager
// recognizes the closed 24-hour messaging window. Whether a failed write is "uncertain"
// (reconciled, never retried blindly) stays decided by each path, not by the table.

const SHARED: readonly [number, ReturnType<typeof graphFailureKind>][] = [
  [190, "token_expired"],
  [102, "token_expired"],
  [463, "token_expired"],
  [467, "token_expired"],
  [10, "permission_missing"],
  [3, "permission_missing"],
  [200, "permission_missing"],
  [299, "permission_missing"],
  [4, "rate_limited"],
  [17, "rate_limited"],
  [32, "rate_limited"],
  [613, "rate_limited"],
  [80000, "rate_limited"],
  [80004, "rate_limited"],
  [80014, "rate_limited"],
  [100, "invalid_request"],
  [1, null],
  [2, null],
  [300, null],
  [79999, null],
  [80015, null],
];

describe("the shared Graph error table", () => {
  it("classifies every known code, and nothing else", () => {
    for (const [code, kind] of SHARED) expect(graphFailureKind(code), String(code)).toBe(kind);
    expect(graphFailureKind(null)).toBeNull();
  });

  it("advertising: the same kinds, then the HTTP status, then provider_error", () => {
    for (const [code, kind] of SHARED) {
      const failure = metaFailure(code, 400);
      expect(failure, String(code)).toBeInstanceOf(AdPlatformError);
      expect(failure.kind, String(code)).toBe(kind ?? "provider_error");
      expect(failure.platformCode).toBe(code);
    }
    expect(metaFailure(null, 401).kind).toBe("token_expired");
    expect(metaFailure(null, 403).kind).toBe("permission_missing");
    expect(metaFailure(null, 500).kind).toBe("provider_error");
    // A known code wins over the status.
    expect(metaFailure(80001, 403).kind).toBe("rate_limited");
  });
});

const PAGE: ManagedPage = {
  id: "700001",
  name: "Page",
  accessToken: "PAGE-TOKEN",
  tasks: ["MODERATE"],
  instagram: null,
};

function social(status: number, body: unknown) {
  return createMetaSocial({
    appSecret: "x".repeat(32),
    version: "v26.0",
    fetch: () =>
      Promise.resolve(
        new Response(body === null ? "not json" : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
  });
}

async function socialFailure(
  status: number,
  body: unknown,
  method: "GET" | "POST",
): Promise<SocialPlatformError> {
  const meta = social(status, body);
  try {
    if (method === "POST") await meta.replyToComment(PAGE, "FACEBOOK", "123_456", "thanks");
    else await meta.recentComments(PAGE, "FACEBOOK", "700001");
  } catch (error) {
    if (error instanceof SocialPlatformError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

const graphError = (code: number, subcode?: number) => ({
  error: { code, ...(subcode === undefined ? {} : { error_subcode: subcode }), message: "x" },
});

describe("the Social Manager uses the same table", () => {
  it("classifies every shared code like advertising does (reads and writes)", async () => {
    for (const [code, kind] of SHARED) {
      for (const method of ["GET", "POST"] as const) {
        const failure = await socialFailure(400, graphError(code), method);
        expect(failure.kind, `${method} ${String(code)}`).toBe(kind ?? "provider_error");
      }
    }
  });

  it("keeps its own case: the closed 24-hour window", async () => {
    expect((await socialFailure(400, graphError(10, 2018278), "POST")).kind).toBe("window_closed");
    expect((await socialFailure(400, graphError(10, 1), "POST")).kind).toBe("permission_missing");
  });

  it("reconnect: expired tokens (463/467 too) are token_expired, not a retryable provider error", async () => {
    for (const code of [190, 463, 467]) {
      const failure = await socialFailure(400, graphError(code), "POST");
      expect(failure.kind).toBe("token_expired");
      expect(failure.uncertain).toBe(false);
    }
  });

  it("retry: a definite refusal is final, only a write that may have happened is uncertain", async () => {
    // Rate limits and permission errors are definite answers: FAILED, not reconciled.
    for (const code of [4, 80001, 3, 100]) {
      expect((await socialFailure(400, graphError(code), "POST")).uncertain, String(code)).toBe(
        false,
      );
    }
    // Unknown/transient Graph errors, 5xx and unreadable answers to a write: uncertain.
    expect(await socialFailure(400, graphError(1), "POST")).toMatchObject({
      kind: "provider_error",
      uncertain: true,
    });
    expect(await socialFailure(400, graphError(2), "POST")).toMatchObject({
      kind: "provider_error",
      uncertain: true,
    });
    expect(await socialFailure(503, null, "POST")).toMatchObject({
      kind: "provider_error",
      uncertain: true,
    });
    // A rate limit answered with a 5xx is still a write that may have happened.
    expect(await socialFailure(500, graphError(80001), "POST")).toMatchObject({
      kind: "rate_limited",
      uncertain: true,
    });
    // Reads are never uncertain.
    expect((await socialFailure(503, null, "GET")).uncertain).toBe(false);
  });
});

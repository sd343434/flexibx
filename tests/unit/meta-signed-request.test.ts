import { describe, expect, it } from "vitest";

import {
  deletionConfirmationCode,
  parseMetaSignedRequest,
  signMetaRequest,
} from "@/server/ads/meta-signed-request";

const SECRET = "unit-meta-app-secret-0123456789";
const payload = { algorithm: "HMAC-SHA256", user_id: "1234567890", issued_at: 1_790_000_000 };

describe("parseMetaSignedRequest", () => {
  it("accepts a request signed with the app secret", () => {
    expect(parseMetaSignedRequest(signMetaRequest(payload, SECRET), SECRET)).toEqual({
      userId: "1234567890",
      issuedAt: 1_790_000_000,
    });
  });

  it("refuses another secret, a changed payload and malformed input", () => {
    const signed = signMetaRequest(payload, SECRET);
    expect(parseMetaSignedRequest(signed, "another-secret-0123456789abcdef")).toBeNull();
    const [signature] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, user_id: "999" })).toString(
      "base64url",
    );
    expect(parseMetaSignedRequest(`${signature ?? ""}.${forged}`, SECRET)).toBeNull();
    for (const value of [null, "", "abc", `${signed}.extra`, "a.b c", "x".repeat(5000)]) {
      expect(parseMetaSignedRequest(value, SECRET)).toBeNull();
    }
  });

  it("refuses another algorithm or a user id that is not numeric", () => {
    expect(
      parseMetaSignedRequest(signMetaRequest({ ...payload, algorithm: "none" }, SECRET), SECRET),
    ).toBeNull();
    expect(
      parseMetaSignedRequest(signMetaRequest({ ...payload, user_id: "abc" }, SECRET), SECRET),
    ).toBeNull();
    expect(
      parseMetaSignedRequest(signMetaRequest({ ...payload, user_id: 123 }, SECRET), SECRET),
    ).toBeNull();
  });
});

describe("deletionConfirmationCode", () => {
  it("is stable per request, 20 hex characters, and does not reveal the user id", () => {
    const request = { userId: "1234567890", issuedAt: 1 };
    const code = deletionConfirmationCode(request, SECRET);
    expect(code).toMatch(/^[0-9a-f]{20}$/);
    expect(deletionConfirmationCode(request, SECRET)).toBe(code);
    expect(deletionConfirmationCode({ ...request, issuedAt: 2 }, SECRET)).not.toBe(code);
    expect(code).not.toContain("1234567890");
  });
});

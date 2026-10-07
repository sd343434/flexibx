import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/server/auth/safe-redirect";

describe("safeNextPath", () => {
  it.each([
    ["/ar", "/ar"],
    ["/ar/w/acme", "/ar/w/acme"],
    ["/en/w/acme/settings?tab=members#roles", "/en/w/acme/settings?tab=members#roles"],
    ["/ar/w/acme/../other", "/ar/w/other"],
  ])("keeps the internal path %s", (input, expected) => {
    expect(safeNextPath(input, "ar")).toBe(expected);
  });

  it.each([
    "https://evil.example/ar",
    "http://evil.example",
    "//evil.example/ar",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/ar\\..\\..\\evil",
    "javascript:alert(1)",
    "data:text/html,x",
    " /ar",
    "/ar/\u0000x",
    "/ar/\nx",
    "/ar//evil.example",
    "/fr/w/acme",
    "/api/auth/sign-out",
    "/ar/../../evil",
    "ar/w/acme",
    "",
    "/".padEnd(600, "a"),
  ])("rejects %j", (input) => {
    expect(safeNextPath(input, "en")).toBe("/en");
  });

  it("rejects non-string values", () => {
    for (const value of [undefined, null, 42, ["/ar"], { href: "/ar" }]) {
      expect(safeNextPath(value, "ar")).toBe("/ar");
    }
  });
});

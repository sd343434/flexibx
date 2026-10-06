import { describe, expect, it } from "vitest";

import { API_CONTENT_SECURITY_POLICY, buildContentSecurityPolicy } from "@/security/csp";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe("buildContentSecurityPolicy", () => {
  it("requires the nonce for scripts and blocks framing, plugins and base hijacking", () => {
    const policy = directives(
      buildContentSecurityPolicy({
        nonce: "abc",
        isDevelopment: false,
        upgradeInsecureRequests: true,
      }),
    );
    expect(policy.get("script-src")).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.has("upgrade-insecure-requests")).toBe(true);
  });

  it("only relaxes eval and websockets in development", () => {
    const dev = directives(
      buildContentSecurityPolicy({
        nonce: "n",
        isDevelopment: true,
        upgradeInsecureRequests: false,
      }),
    );
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toContain("ws:");
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
  });

  it("locks down API responses", () => {
    expect(API_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import {
  AUTH_ERROR_MESSAGE_KEYS,
  authErrorMessageKey,
  type AuthFailure,
} from "@/server/auth/auth-messages";
import { postSignInPath, signInPath } from "@/server/auth/safe-redirect";
import { ERROR_CODE_LIST } from "@/server/errors/codes";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const ROOT = join(import.meta.dirname, "../..");

describe("authErrorMessageKey", () => {
  it("maps every failure to a Flexibx auth message, never to library text", () => {
    expect(authErrorMessageKey("INVALID_CREDENTIALS")).toBe("auth.errors.invalidCredentials");
    expect(authErrorMessageKey("VALIDATION_FAILED")).toBe("auth.errors.invalidInput");
    expect(authErrorMessageKey("RATE_LIMITED")).toBe("auth.errors.rateLimited");
    expect(authErrorMessageKey("EMAIL_NOT_VERIFIED")).toBe("auth.errors.emailNotVerified");
    expect(authErrorMessageKey("INVALID_PASSWORD")).toBe("auth.errors.wrongPassword");
    const mapped = new Set(["VALIDATION_FAILED", "RATE_LIMITED"]);
    for (const code of ERROR_CODE_LIST.filter((candidate) => !mapped.has(candidate))) {
      expect(authErrorMessageKey(code as AuthFailure)).toBe("auth.errors.unavailable");
    }
  });

  it.each([
    ["ar", ar],
    ["en", en],
  ] as const)("every auth message key exists in %s", (locale, messages) => {
    const t = createTranslator({
      locale,
      messages,
      onError: (error) => {
        throw error;
      },
    });
    for (const key of Object.values(AUTH_ERROR_MESSAGE_KEYS)) {
      expect(t(key).length).toBeGreaterThan(0);
    }
  });

  it("uses one sign-in failure message that does not mention which part was wrong", () => {
    expect(en.auth.errors.invalidCredentials).toBe("The email or password is incorrect.");
    expect(ar.auth.errors.invalidCredentials).toContain("أو");
  });
});

describe("postSignInPath", () => {
  it.each([
    [undefined, "/en/workspaces"],
    ["", "/en/workspaces"],
    ["/en", "/en"],
    ["/en/w/acme", "/en/w/acme"],
    ["/ar/workspaces/new?x=1", "/ar/workspaces/new?x=1"],
    ["https://evil.example", "/en/workspaces"],
    ["//evil.example/en", "/en/workspaces"],
    ["/fr/w/acme", "/en/workspaces"],
    ["/api/auth/sign-out", "/en/workspaces"],
  ])("next=%j → %s", (next, expected) => {
    expect(postSignInPath(next, "en")).toBe(expected);
  });
});

describe("signInPath", () => {
  it("adds only a safe return path", () => {
    expect(signInPath("ar")).toBe("/ar/sign-in");
    expect(signInPath("ar", "/ar/w/acme")).toBe("/ar/sign-in?next=%2Far%2Fw%2Facme");
    expect(signInPath("en", "https://evil.example")).toBe("/en/sign-in");
    expect(signInPath("en", "//evil.example")).toBe("/en/sign-in");
  });
});

describe("step 5 module boundaries", () => {
  it("keeps the auth actions server-only", () => {
    expect(
      readFileSync(join(ROOT, "src/server/auth/auth-actions.ts"), "utf8").startsWith(
        'import "server-only";',
      ),
    ).toBe(true);
  });

  it("auth forms keep email and password inputs left-to-right", () => {
    for (const path of [
      "src/app/[locale]/(auth)/sign-in/sign-in-form.tsx",
      "src/app/[locale]/(auth)/sign-up/sign-up-form.tsx",
    ]) {
      const source = readFileSync(join(ROOT, path), "utf8");
      const inputs = source.match(/<Input[\s\S]*?\/>/g) ?? [];
      const ltrFields = inputs.filter((input) => /type="(email|password)"/.test(input));
      expect(ltrFields.length).toBeGreaterThan(0);
      for (const input of ltrFields) expect(input).toContain('dir="ltr"');
    }
  });
});

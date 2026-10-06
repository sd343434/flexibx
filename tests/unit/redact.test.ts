import { describe, expect, it } from "vitest";

import { REDACTED, redactSecrets, redactString } from "@/server/redact";

describe("redactSecrets", () => {
  it("redacts secret-looking keys at any depth", () => {
    const result = redactSecrets({
      password: "p",
      user: { accessToken: "t", refresh_token: "r", apiKey: "k", name: "Sara" },
      headers: { authorization: "Bearer abc", cookie: "sid=1", "set-cookie": "x" },
      config: { DATABASE_URL: "postgres://u:p@h/db", clientSecret: "s" },
    });
    expect(result).toEqual({
      password: REDACTED,
      user: { accessToken: REDACTED, refresh_token: REDACTED, apiKey: REDACTED, name: "Sara" },
      headers: { authorization: REDACTED, cookie: REDACTED, "set-cookie": REDACTED },
      config: { DATABASE_URL: REDACTED, clientSecret: REDACTED },
    });
  });

  it("keeps AI usage counters visible", () => {
    expect(
      redactSecrets({ inputTokens: 120, outputTokens: 80, tokenUsage: { total: 200 } }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      tokenUsage: { total: 200 },
    });
  });

  it("redacts credentials embedded in strings and errors", () => {
    // Fake credential assembled at runtime so repository secret scanners don't flag test data.
    const fakePassword = ["not", "a", "real", "password"].join("-");
    expect(redactString(`connect postgresql://flexibx:${fakePassword}@db:5432/x`)).toBe(
      `connect postgresql://flexibx:${REDACTED}@db:5432/x`,
    );
    expect(redactString("Authorization: Bearer eyJhbGciOi.abc.def")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    const error = redactSecrets(new Error("failed for redis://default:pw123@cache:6379")) as {
      message: string;
    };
    expect(error.message).not.toContain("pw123");
  });

  it("handles arrays, dates, primitives and deep nesting safely", () => {
    const date = new Date(0);
    expect(redactSecrets([{ token: "x" }, 1, null, date])).toEqual([
      { token: REDACTED },
      1,
      null,
      date,
    ]);
    let deep: Record<string, unknown> = { value: "end" };
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain("[Truncated]");
  });
});

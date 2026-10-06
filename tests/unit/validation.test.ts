import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "@/server/errors/app-error";
import { zodIssuesToFieldErrors } from "@/server/validation/field-errors";
import { parseInput } from "@/server/validation/parse";

const schema = z
  .object({
    name: z.string().min(3).max(10),
    email: z.email(),
    website: z.url().optional(),
    role: z.enum(["OWNER", "ADMIN"]),
    tags: z.array(z.string()).min(1),
    count: z.number().int().multipleOf(5).max(100),
  })
  .strict();

function fieldsFor(input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected failure");
  return zodIssuesToFieldErrors(result.error.issues, input);
}

describe("zodIssuesToFieldErrors", () => {
  it("maps Zod issues to translation codes with interpolation params", () => {
    const fields = fieldsFor({
      name: "ab",
      email: "x",
      website: "not a url",
      role: "GUEST",
      tags: [],
      count: 7,
      extra: true,
    });
    expect(fields).toEqual(
      expect.arrayContaining([
        { path: "name", code: "too_small", params: { origin: "string", minimum: 3 } },
        { path: "email", code: "invalid_format", params: { format: "email" } },
        { path: "website", code: "invalid_format", params: { format: "url" } },
        { path: "role", code: "invalid_value" },
        { path: "tags", code: "too_small", params: { origin: "array", minimum: 1 } },
        { path: "count", code: "not_multiple_of", params: { divisor: 5 } },
        { path: "", code: "unrecognized_keys", params: { keys: "extra" } },
      ]),
    );
  });

  it("distinguishes missing values from wrong types", () => {
    const fields = fieldsFor({ name: 5 });
    expect(fields).toEqual(
      expect.arrayContaining([
        { path: "name", code: "invalid_type", params: { expected: "string" } },
        { path: "email", code: "required" },
      ]),
    );
  });

  it("falls back to invalid_type when the original input is unavailable", () => {
    const result = z.object({ a: z.string() }).safeParse({});
    if (result.success) throw new Error("expected failure");
    expect(zodIssuesToFieldErrors(result.error.issues)).toEqual([
      { path: "a", code: "invalid_type", params: { expected: "string" } },
    ]);
  });

  it("reports too_big with the maximum", () => {
    expect(fieldsFor({ name: "a".repeat(11) })).toEqual(
      expect.arrayContaining([
        { path: "name", code: "too_big", params: { origin: "string", maximum: 10 } },
      ]),
    );
  });
});

describe("parseInput", () => {
  it("returns parsed data on success", () => {
    expect(parseInput(z.object({ n: z.coerce.number() }), { n: "4" })).toEqual({ n: 4 });
  });

  it("throws VALIDATION_FAILED with field errors on failure", () => {
    try {
      parseInput(z.object({ n: z.number() }), {}, "body");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_FAILED");
      expect((error as AppError).fields).toEqual([{ path: "n", code: "required" }]);
    }
  });
});

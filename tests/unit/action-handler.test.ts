import { notFound, redirect } from "next/navigation";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "@/server/errors/app-error";
import { withAction } from "@/server/http/action-handler";

const rename = withAction({
  name: "test.rename",
  input: z.object({ slug: z.string().min(3), name: z.string().min(1).max(20) }).strict(),
  handler: (input) => ({ renamed: input.name }),
});

describe("withAction", () => {
  it("validates the input and returns data", async () => {
    expect(await rename({ slug: "acme", name: "New" })).toEqual({
      ok: true,
      data: { renamed: "New" },
    });
  });

  it("rejects invalid or extra input (e.g. a client-supplied role) with field codes only", async () => {
    const result = await rename({ slug: "acme", name: "", role: "OWNER" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(result.error.fields)).toContain("unrecognized_keys");
  });

  it.each(["UNAUTHENTICATED", "NOT_FOUND", "FORBIDDEN"] as const)(
    "maps %s from the authorization layer to a code-only result",
    async (code) => {
      const action = withAction({
        name: "test.denied",
        input: z.object({}),
        handler: () => {
          throw new AppError(code, { message: "internal detail", metadata: { userId: "u" } });
        },
      });
      const result = await action({});
      expect(result).toMatchObject({ ok: false, error: { code, messageKey: `errors.${code}` } });
      expect(JSON.stringify(result)).not.toContain("internal detail");
    },
  );

  it("never leaks unexpected errors", async () => {
    const action = withAction({
      name: "test.crash",
      input: z.object({}),
      handler: () => {
        throw new Error("db password=leak exploded");
      },
    });
    const result = await action({});
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("lets Next.js redirect and notFound control flow through", async () => {
    const redirecting = withAction({
      name: "test.redirect",
      input: z.object({}),
      handler: () => redirect("/ar"),
    });
    await expect(redirecting({})).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT/) as unknown,
    });
    const missing = withAction({ name: "test.nf", input: z.object({}), handler: () => notFound() });
    await expect(missing({})).rejects.toBeDefined();
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError, isAppError } from "@/server/errors/app-error";
import { ERROR_CODE_LIST, ERROR_CODES } from "@/server/errors/codes";
import { errorResponse, toAppError, toErrorResponseBody } from "@/server/errors/http";

describe("AppError", () => {
  it("carries code, status, translation key and metadata", () => {
    const error = new AppError("FORBIDDEN", {
      message: "Role VIEWER may not edit",
      metadata: { action: "brand.edit" },
    });
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.httpStatus).toBe(403);
    expect(error.userMessageKey).toBe("errors.FORBIDDEN");
    expect(error.metadata).toEqual({ action: "brand.edit" });
    expect(error.message).toBe("Role VIEWER may not edit");
  });

  it("maps every registered code to an HTTP status", () => {
    for (const code of ERROR_CODE_LIST) {
      expect(new AppError(code).httpStatus).toBe(ERROR_CODES[code].httpStatus);
    }
  });
});

describe("toAppError", () => {
  it("turns unknown errors into INTERNAL", () => {
    const error = toAppError(new Error("relation users does not exist at db.internal"));
    expect(error.code).toBe("INTERNAL");
    expect(error.httpStatus).toBe(500);
  });

  it("turns ZodErrors into VALIDATION_FAILED with field codes", () => {
    const result = z.object({ email: z.email() }).safeParse({ email: "nope" });
    expect(result.success).toBe(false);
    const error = toAppError(result.error);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.fields).toEqual([
      { path: "email", code: "invalid_format", params: { format: "email" } },
    ]);
  });

  it("returns AppErrors unchanged", () => {
    const original = new AppError("NOT_FOUND");
    expect(toAppError(original)).toBe(original);
  });
});

describe("error responses", () => {
  it("never leak messages, metadata, stacks or causes", async () => {
    const error = new AppError("INTERNAL", {
      message: "password=hunter2 at /srv/app.ts:10",
      metadata: { sql: "SELECT secret" },
      fields: [{ path: "x", code: "invalid" }],
      cause: new Error("boom"),
    });
    const response = errorResponse(error, "req-12345678");
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("req-12345678");
    expect(text).not.toMatch(/hunter2|SELECT|boom|app\.ts|stack/);
    expect(JSON.parse(text)).toEqual({
      error: { code: "INTERNAL", messageKey: "errors.INTERNAL", requestId: "req-12345678" },
    });
  });

  it("exposes field errors for client-correctable failures", () => {
    const body = toErrorResponseBody(
      new AppError("VALIDATION_FAILED", { fields: [{ path: "name", code: "required" }] }),
      "req-abcdefgh",
    );
    expect(body.error.fields).toEqual([{ path: "name", code: "required" }]);
  });
});

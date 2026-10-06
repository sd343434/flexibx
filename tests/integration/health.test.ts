import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("reports readiness with the database up", async () => {
    const response = await GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toEqual({
      status: "ok",
      scope: "readiness",
      checks: { db: "up" },
    });
  });

  it("supports a dependency-free liveness probe", async () => {
    const response = await GET(new Request("http://localhost/api/health?scope=liveness"));
    expect(await response.json()).toEqual({ status: "ok", scope: "liveness" });
  });

  it("validates the query string", async () => {
    const response = await GET(new Request("http://localhost/api/health?scope=everything"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; fields: unknown[] } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.fields).toEqual([{ path: "scope", code: "invalid_value" }]);
  });
});

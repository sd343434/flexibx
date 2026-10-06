import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "@/server/errors/app-error";
import { withRoute } from "@/server/http/route-handler";

const echo = withRoute({
  name: "test.echo",
  query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
  body: z.object({ title: z.string().min(1) }).strict(),
  maxBodyBytes: 64,
  handler: ({ query, body, requestId }) => ({ page: query.page, title: body.title, requestId }),
});

function post(
  body: string,
  init: { contentType?: string; url?: string; headers?: Record<string, string> } = {},
) {
  return new Request(init.url ?? "http://localhost/api/echo?page=2", {
    method: "POST",
    headers: { "content-type": init.contentType ?? "application/json", ...init.headers },
    body,
  });
}

describe("withRoute", () => {
  it("validates query and body and returns JSON", async () => {
    const response = await echo(post(JSON.stringify({ title: "مرحبا" })));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { page: number; title: string; requestId: string };
    expect(json).toMatchObject({ page: 2, title: "مرحبا" });
    expect(response.headers.get("x-request-id")).toBe(json.requestId);
  });

  it("propagates a well-formed incoming request id and replaces malformed ones", async () => {
    const kept = await echo(
      post(JSON.stringify({ title: "x" }), { headers: { "x-request-id": "trace-abc-12345" } }),
    );
    expect(kept.headers.get("x-request-id")).toBe("trace-abc-12345");
    const replaced = await echo(
      post(JSON.stringify({ title: "x" }), { headers: { "x-request-id": "<script>" } }),
    );
    expect(replaced.headers.get("x-request-id")).not.toBe("<script>");
  });

  it("returns 400 with localized field codes for invalid input", async () => {
    const response = await echo(
      post(JSON.stringify({ title: "", extra: 1 }), { url: "http://localhost/api/echo?page=0" }),
    );
    expect(response.status).toBe(400);
    const json = (await response.json()) as {
      error: { code: string; fields: { path: string; code: string }[] };
    };
    expect(json.error.code).toBe("VALIDATION_FAILED");
    expect(json.error.fields.map((field) => field.path)).toEqual(["page"]);
  });

  it("rejects malformed JSON, wrong content types and oversized bodies", async () => {
    expect((await echo(post("{oops"))).status).toBe(400);
    expect(
      (await echo(post("title=x", { contentType: "application/x-www-form-urlencoded" }))).status,
    ).toBe(415);
    expect((await echo(post(JSON.stringify({ title: "x".repeat(100) })))).status).toBe(413);
    expect((await echo(post("{}", { headers: { "content-length": "1000000" } }))).status).toBe(413);
  });

  it("maps AppErrors to their status and hides unknown errors as INTERNAL", async () => {
    const forbidden = withRoute({
      name: "test.forbidden",
      handler: () => {
        throw new AppError("FORBIDDEN", { message: "internal detail" });
      },
    });
    const crash = withRoute({
      name: "test.crash",
      handler: () => {
        throw new Error("db password=hunter2 exploded");
      },
    });

    const forbiddenResponse = await forbidden(new Request("http://localhost/x"));
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.text()).not.toContain("internal detail");

    const crashResponse = await crash(new Request("http://localhost/x"));
    expect(crashResponse.status).toBe(500);
    const text = await crashResponse.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "INTERNAL", messageKey: "errors.INTERNAL" },
    });
  });

  it("validates route params", async () => {
    const byId = withRoute({
      name: "test.params",
      params: z.object({ id: z.uuid() }),
      handler: ({ params }) => ({ id: params.id }),
    });
    const ok = await byId(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10" }),
    });
    expect(ok.status).toBe(200);
    const bad = await byId(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(bad.status).toBe(400);
  });
});

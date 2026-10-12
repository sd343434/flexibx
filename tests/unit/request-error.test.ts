import { beforeEach, describe, expect, it, vi } from "vitest";

// Next.js onRequestError → log + alert, without the error message (it can carry customer
// content) and ignoring Next.js control flow (redirect / notFound).

const recorded = vi.hoisted(() => ({
  logs: [] as Record<string, unknown>[],
  alerts: [] as Record<string, unknown>[],
}));
vi.mock("@/server/logger", () => ({
  logger: {
    error: (object: Record<string, unknown>) => {
      recorded.logs.push(object);
    },
  },
}));
vi.mock("@/server/monitoring/alerts", () => ({
  reportServerError: (input: Record<string, unknown>) => {
    recorded.alerts.push(input);
  },
}));

const { handleRequestError } = await import("@/server/monitoring/request-error");
const { onRequestError } = await import("@/instrumentation");

beforeEach(() => {
  recorded.logs.length = 0;
  recorded.alerts.length = 0;
});

const context = { routePath: "/[locale]/w/[workspaceSlug]/page", routeType: "render" };

describe("request error reporting", () => {
  it("logs the route and error class only, and raises a server-error alert", () => {
    const error = Object.assign(new TypeError("customer said: secret plan"), { digest: "123" });
    handleRequestError(error, { method: "GET" }, context);
    expect(recorded.logs).toEqual([
      {
        event: "request.unhandled_error",
        routePath: context.routePath,
        routeType: "render",
        method: "GET",
        error: "TypeError",
        digest: "123",
      },
    ]);
    expect(JSON.stringify(recorded.logs)).not.toContain("secret plan");
    expect(recorded.alerts).toEqual([
      { source: "render", name: context.routePath, code: "TypeError", requestId: "123" },
    ]);
  });

  it("ignores redirects and not-found responses", () => {
    for (const digest of ["NEXT_REDIRECT;replace;/en;307;", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      handleRequestError(Object.assign(new Error("x"), { digest }), { method: "GET" }, context);
    }
    expect(recorded.logs).toEqual([]);
    expect(recorded.alerts).toEqual([]);
  });

  it("maps route handlers and actions, and never throws", async () => {
    handleRequestError("boom", { method: "POST" }, { routePath: "/api/x", routeType: "route" });
    handleRequestError(
      new Error("y"),
      { method: "POST" },
      { routePath: "/a", routeType: "action" },
    );
    expect(recorded.alerts.map((entry) => entry.source)).toEqual(["route", "action"]);
    expect(recorded.alerts[0]).toMatchObject({ code: "string" });
    // Edge runtime: nothing is loaded or reported.
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await onRequestError(new Error("z"), { path: "/x?q=1", method: "GET" }, context);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await onRequestError(new Error("z"), { path: "/x?q=1", method: "GET" }, context);
    vi.unstubAllEnvs();
    expect(recorded.alerts).toHaveLength(3);
    expect(JSON.stringify(recorded.logs)).not.toContain("q=1");
  });
});

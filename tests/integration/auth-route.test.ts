// The real Next.js route module: route.ts → getAuth() → getSystemDb() + env.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as RouteModule from "@/app/api/auth/[...all]/route";

const BASE = "http://localhost:3000";
let route: typeof RouteModule;

beforeAll(async () => {
  process.env.APP_URL = BASE;
  process.env.AUTH_SECRET = ["route", "test", "only", "secret", "0123456789abcdef"].join("-");
  route = await import("@/app/api/auth/[...all]/route");
});

afterAll(async () => {
  const { getSystemDb } = await import("@/server/db/client");
  await getSystemDb().$disconnect();
});

const request = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}/api/auth${path}`, init);

describe("/api/auth/[...all] route", () => {
  it("serves get-session (no session → null)", async () => {
    const response = await route.GET(request("/get-session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("does not expose email/password sign-up or sign-in", async () => {
    for (const path of ["/sign-up/email", "/sign-in/email"]) {
      const response = await route.POST(
        request(path, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ email: "a@example.com", password: "long enough pw", name: "A" }),
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  it("rejects a cookie-bearing mutation from an untrusted origin", async () => {
    const response = await route.POST(
      request("/sign-out", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          cookie: "flexibx.session_token=x.y",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });
});

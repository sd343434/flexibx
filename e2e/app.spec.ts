import { expect, test } from "@playwright/test";

test("the theme toggle switches to dark mode and persists across reloads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/en");
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/dark/);

  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveClass(/dark/);

  await page.reload();
  await expect(html).toHaveClass(/dark/);
});

test("pages are served with security headers and a nonce-based CSP", async ({ request }) => {
  const response = await request.get("/ar");
  const headers = response.headers();
  expect(headers["content-security-policy"]).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("GET /api/health reports readiness without internals", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", scope: "readiness", checks: { db: "up" } });
  expect(response.headers()["content-security-policy"]).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(response.headers()["x-request-id"]).toBeTruthy();
});

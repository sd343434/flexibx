import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

import { E2E_IP_HEADER, MAIL_OUTBOX_DIR } from "./e2e/env";

const PORT = Number(process.env.E2E_PORT ?? 3100);

const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT.toString()}`;

// Use an explicitly configured Chromium, or the one preinstalled in this dev container
// (its revision can differ from the one bundled with @playwright/test). CI installs the
// matching browser with `playwright install --with-deps chromium` instead.
const containerChromium = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (!process.env.CI && existsSync(containerChromium) ? containerChromium : undefined);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
      },
    },
  ],
  // Runs the production build (`pnpm build` must have been run first).
  webServer: {
    command: "pnpm start",
    // Production build with production policy: email verification required (default),
    // emails written to the test outbox instead of sent, media kept in memory, and a
    // trusted client-IP header so rate limits are per test client.
    env: {
      PORT: PORT.toString(),
      HOSTNAME: "127.0.0.1",
      MAIL_TRANSPORT: "test-outbox",
      MAIL_OUTBOX_DIR,
      AUTH_IP_HEADER: E2E_IP_HEADER,
      // Media uploads are kept in the server process (no object storage in E2E runs).
      STORAGE_DRIVER: "test-memory",
    },
    url: `${baseURL}/api/health?scope=liveness`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

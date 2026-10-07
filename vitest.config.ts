import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors tsconfig `paths` so `@/…` imports work in tests.
      "@": src,
      // `server-only` throws outside React Server Components; tests run in plain Node.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: false,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/setup-env.ts"],
          // One shared test database: run files sequentially to keep tests deterministic.
          fileParallelism: false,
          // Process these through Vite instead of loading them as raw Node ESM: next-intl's
          // middleware imports `next/server` without an extension (Node cannot resolve it),
          // and Better Auth's nextCookies() imports `next/headers.js`, which tests replace.
          server: { deps: { inline: ["better-auth", "next-intl"] } },
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

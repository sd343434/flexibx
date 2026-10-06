// Completes the Next.js standalone output so `node .next/standalone/server.js` serves
// static assets (Next does not copy them itself). Used by `pnpm build` and the Dockerfile.
import { cpSync, existsSync } from "node:fs";

const standalone = ".next/standalone";
if (!existsSync(standalone)) {
  throw new Error('Standalone output not found. Is `output: "standalone"` set in next.config.ts?');
}

cpSync(".next/static", `${standalone}/.next/static`, { recursive: true });
if (existsSync("public")) cpSync("public", `${standalone}/public`, { recursive: true });

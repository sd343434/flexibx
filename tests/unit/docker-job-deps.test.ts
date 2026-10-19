// scripts/docker/job-deps.mjs (Pass 14): what the job images keep of node_modules. The
// worker and ops images get only the packages their commands load, traced from the code —
// so the selection must contain what those commands need and none of the build and test
// tooling that made the images 2+ GB. Runs the real script against this checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "scripts/docker/job-deps.mjs");

function list(profile: "worker" | "ops") {
  const out = execFileSync(process.execPath, [SCRIPT, "--list", profile], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out) as { roots: string[]; packages: string[] };
}

/** Build, test and app-only tooling: never needed by a job command. */
const TOOLING = [
  "next",
  "@next/swc-linux-x64-gnu",
  "@next/swc-linux-x64-musl",
  "typescript",
  "vitest",
  "eslint",
  "prettier",
  "@playwright/test",
  "playwright-core",
  "tailwindcss",
  "lucide-react",
  "radix-ui",
];

describe("job image dependencies", () => {
  const worker = list("worker");
  const ops = list("ops");

  it("keeps what the worker's commands load: database, storage, logging, tsx", () => {
    expect(worker.roots).toEqual(
      expect.arrayContaining([
        "@aws-sdk/client-s3",
        "@aws-sdk/s3-request-presigner",
        "@prisma/adapter-pg",
        "@prisma/client",
        "pino",
        "tsx",
        "zod",
      ]),
    );
    // Reached through those roots, not imported directly.
    expect(worker.packages).toEqual(expect.arrayContaining(["pg", "esbuild"]));
  });

  it("leaves the build and test tooling out of both job images", () => {
    for (const name of TOOLING) {
      expect(worker.packages).not.toContain(name);
      expect(ops.packages).not.toContain(name);
    }
    // The worker never migrates: no Prisma CLI (the client's peer on it is optional).
    expect(worker.packages).not.toContain("prisma");
  });

  it("keeps the Prisma CLI with its engines, auth and the mail templates' i18n in ops", () => {
    expect(ops.roots).toEqual(expect.arrayContaining(["prisma", "better-auth", "next-intl"]));
    expect(ops.packages).toEqual(expect.arrayContaining(["@prisma/engines", "use-intl", "react"]));
  });

  describe("--verify (run in the final image)", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-deps-"));
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function verifyIn(roots: string[], present: string[]) {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      for (const name of present) {
        mkdirSync(join(dir, "node_modules", name), { recursive: true });
        writeFileSync(join(dir, "node_modules", name, "package.json"), "{}");
      }
      writeFileSync(join(dir, "node_modules", ".job-deps.json"), JSON.stringify({ roots }));
      return spawnSync(process.execPath, [SCRIPT, "--verify"], { cwd: dir, encoding: "utf8" });
    }

    it("passes when every root package is present", () => {
      const result = verifyIn(["pino", "@scope/kit"], ["pino", "@scope/kit"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("all 2 root packages present");
    });

    it("fails the image build when one is missing", () => {
      const result = verifyIn(["pino", "zod"], ["pino"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing in this image: zod");
    });
  });

  it("refuses an unknown profile", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "/tmp/unused", "web"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
});

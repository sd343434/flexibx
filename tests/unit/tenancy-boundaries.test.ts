import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Static guards for the runtime tenancy layer (Phase 2, step 3).

const ROOT = join(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(join(ROOT, "src"))
  .map((path) => relative(ROOT, path).split("\\").join("/"))
  .filter((path) => !path.startsWith("src/generated/"));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("tenancy boundaries", () => {
  it("only the tenancy layer constructs a TenantContext", () => {
    const offenders = files.filter(
      (path) =>
        !path.startsWith("src/server/tenancy/") && /\bcreateTenantContext\s*\(/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the session, access and context modules server-only", () => {
    for (const path of [
      "src/server/auth/session.ts",
      "src/server/tenancy/access.ts",
      "src/server/tenancy/context.ts",
      "src/server/http/action-handler.ts",
    ]) {
      expect(read(path).startsWith('import "server-only";')).toBe(true);
    }
  });

  it("client components never import server modules", () => {
    const clientFiles = files.filter((path) => /^\s*["']use client["']/.test(read(path)));
    expect(clientFiles.length).toBeGreaterThan(0);
    const offenders = clientFiles.filter((path) =>
      /from\s+["'](@\/server|\.\.?\/.*server)/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the unguarded system client to reviewed call sites", () => {
    const users = files.filter(
      (path) => path !== "src/server/db/client.ts" && /\bgetSystemDb\s*\(/.test(read(path)),
    );
    expect(users.sort()).toEqual([
      // Platform admin: the admin flag lookup, platform-wide storage settings and
      // per-provider object counts (no workspace data is read or written).
      // Platform admin credits: the workspace is found by slug; every credit read and
      // write then goes through the guarded client with its id.
      "src/server/admin/credits-admin-actions.ts",
      "src/server/admin/platform-admin.ts",
      "src/server/admin/storage-admin-actions.ts",
      // Advertising OAuth callback: looks the single-use state up by its hash (the
      // redirect carries no workspace); every write goes through the guarded client.
      "src/server/ads/connections.ts",
      // Meta deauthorize / data deletion callbacks: a verified signed_request carries no
      // workspace; connections are found by the platform user id, and each one is
      // revoked through the guarded client with its own workspace id.
      "src/server/ads/meta-deauthorization.ts",
      "src/server/auth/auth.ts",
      "src/server/health/health-service.ts",
      // Scheduler tick (POST /api/internal/automation-tick): cross-workspace selection of
      // due policies, stale tasks and active runs only; every run executes per workspace
      // through the guarded client (scheduler.ts, engine.ts), as `pnpm automation:tick`.
      "src/server/orchestration/runtime.ts",
      // AI Social Manager: the signed Page/Instagram webhook carries no workspace (channels
      // are found by account id) and the scheduler sweep selects due work across
      // workspaces; every row is then read and written through the guarded client.
      "src/server/social/social-runtime.ts",
      // Storage router: reads the platform storage settings singleton only.
      "src/server/storage/providers.ts",
      "src/server/tenancy/access.ts",
      "src/server/tenancy/invitation-acceptance.ts",
      // Generated video retention job: cross-workspace candidate selection only; every
      // per-video read/write goes through the guarded client (retention-job.ts).
      "src/server/videos/retention-runtime.ts",
      // WhatsApp webhook: a signed notification carries no session; the WABA is resolved
      // to the workspaces that connected and selected it, and each event row is written
      // with that explicit workspace id (deduplicated per workspace).
      "src/server/whatsapp/webhook-handler.ts",
    ]);
  });

  it("never sets the platform admin flag from application code", () => {
    // Platform administrators are granted by an operator directly in the database
    // (docs/ARCHITECTURE.md). Every mention of the flag is a reviewed read; nothing writes it.
    const scanned = [...files, "prisma/seed.ts"];
    const mentions = scanned.filter((path) => /isPlatformAdmin|is_platform_admin/.test(read(path)));
    expect(mentions.sort()).toEqual([
      // Read-only lookup: `select: { isPlatformAdmin: true, emailVerified: true }`.
      "src/server/admin/platform-admin.ts",
      // Better Auth field declaration with `input: false` (requests cannot set it).
      "src/server/auth/auth-config.ts",
      // Doc comment only.
      "src/server/auth/session.ts",
    ]);
    const writes = scanned.filter((path) =>
      /(data|create|update)\s*:\s*\{[^}]*isPlatformAdmin|is_platform_admin\s*=/.test(
        // Comments may document the operator procedure; only code counts.
        read(path).replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""),
      ),
    );
    expect(writes).toEqual([]);
  });

  it("keeps the bounded (also unguarded) retention pool to the retention runtime", () => {
    const users = files.filter(
      (path) =>
        path !== "src/server/db/client.ts" && /\bgetBoundedRetentionDb\s*\(/.test(read(path)),
    );
    expect(users).toEqual(["src/server/videos/retention-runtime.ts"]);
  });
});

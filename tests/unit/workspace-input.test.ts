import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeWorkspaceSlug, WORKSPACE_SLUG_PATTERN } from "@/server/tenancy/slug";
import { decideWorkspaceLanding, type WorkspaceSummary } from "@/server/workspaces/landing";
import { createWorkspaceInputSchema } from "@/server/workspaces/workspace-input";

const valid = { name: "Acme", slug: "acme-store", defaultLocale: "ar" };
const ROOT = join(import.meta.dirname, "../..");

describe("createWorkspaceInputSchema", () => {
  it("accepts name, slug and default locale, trimming and lowercasing", () => {
    expect(
      createWorkspaceInputSchema.parse({
        name: "  Acme  ",
        slug: " Acme-Store ",
        defaultLocale: "en",
      }),
    ).toEqual({ name: "Acme", slug: "acme-store", defaultLocale: "en" });
  });

  it.each(["type", "role", "ownerId", "userId", "workspaceId", "parentWorkspaceId", "id"])(
    "rejects the server-decided key %s",
    (key) => {
      const result = createWorkspaceInputSchema.safeParse({ ...valid, [key]: "x" });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    },
  );

  it.each([
    ["missing name", { slug: "acme", defaultLocale: "ar" }],
    ["blank name", { ...valid, name: "   " }],
    ["name over 120 characters", { ...valid, name: "x".repeat(121) }],
    ["unsupported locale", { ...valid, defaultLocale: "fr" }],
    ["non-string slug", { ...valid, slug: 123 }],
    ["slug of 2 characters", { ...valid, slug: "ab" }],
    ["slug of 49 characters", { ...valid, slug: "a".repeat(49) }],
    ["slug with a dot", { ...valid, slug: "acme.store" }],
    ["slug with Arabic letters", { ...valid, slug: "متجر" }],
  ])("rejects %s", (_label, input) => {
    expect(createWorkspaceInputSchema.safeParse(input).success).toBe(false);
  });

  it("uses exactly the database CHECK rule for slugs", () => {
    const migration = readFileSync(
      join(ROOT, "prisma/migrations/20261006201052_init/migration.sql"),
      "utf8",
    );
    expect(migration).toContain(`'${WORKSPACE_SLUG_PATTERN.source}'`);
    expect(normalizeWorkspaceSlug("  MiXeD-1 ")).toBe("mixed-1");
  });
});

describe("decideWorkspaceLanding", () => {
  const ws = (slug: string): WorkspaceSummary => ({ name: slug, slug, role: "OWNER" });

  it("sends a user without workspaces to creation", () => {
    expect(decideWorkspaceLanding([])).toEqual({ kind: "create" });
  });

  it("opens the only workspace directly", () => {
    expect(decideWorkspaceLanding([ws("only-one")])).toEqual({ kind: "open", slug: "only-one" });
  });

  it("lists several workspaces in the given order", () => {
    const list = [ws("first"), ws("second")];
    expect(decideWorkspaceLanding(list)).toEqual({ kind: "choose", workspaces: list });
  });
});

describe("step 4 module boundaries", () => {
  it.each([
    "src/server/tenancy/workspace-creation.ts",
    "src/server/workspaces/workspace-actions.ts",
    "src/server/workspaces/workspace-queries.ts",
  ])("%s is server-only", (path) => {
    expect(readFileSync(join(ROOT, path), "utf8").startsWith('import "server-only";')).toBe(true);
  });
});

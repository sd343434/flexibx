// Phase 2, step 4: workspace creation and selection on the real database, with real
// Better Auth sessions. Only `next/headers` is replaced, to hand each call the request
// headers a real Next.js request would carry.
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitCreateWorkspace } from "@/app/[locale]/workspaces/new/actions";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { getAuth, getRateLimiter } from "@/server/auth/auth";
import { signInWithEmail, signUpWithEmail } from "@/server/auth/credentials";
import { getSystemDb } from "@/server/db/client";
import { createGuardedClient, type GuardedPrismaClient } from "@/server/db/prisma";
import { AppError } from "@/server/errors/app-error";
import {
  listMyWorkspaces,
  listWorkspacesForUser,
  requireWorkspaceAccess,
} from "@/server/tenancy/access";
import { createWorkspace } from "@/server/tenancy/workspace-creation";
import { decideWorkspaceLanding } from "@/server/workspaces/landing";
import { createWorkspaceAction } from "@/server/workspaces/workspace-actions";
import { getWorkspaceOverview } from "@/server/workspaces/workspace-queries";

import { createTestDb, resetDatabase } from "./helpers";

const request = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["workspace", "creation", "test", "only", "0123456789abcdef"].join("-");
  return { headers: new Headers() };
});
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(request.headers),
  // Outside a Next.js request scope cookies() throws; Better Auth's nextCookies()
  // plugin treats that as "nothing to write".
  cookies: () => Promise.reject(new Error("`cookies` was called outside a request scope.")),
}));

const { system, db } = createTestDb();
const PASSWORD = "correct horse battery";
const COOKIE = "flexibx.session_token";

beforeEach(async () => {
  await resetDatabase(system);
  request.headers = new Headers();
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

let counter = 0;

/** A real account + session (email NOT verified); returns the user id and cookie. */
async function signedInUser(name = "User") {
  counter += 1;
  const email = `creator-${String(counter)}-${Date.now().toString(36)}@example.com`;
  const deps = { limit: getRateLimiter(), headers: new Headers() };
  await signUpWithEmail(getAuth(), { email, password: PASSWORD, name }, deps, "en");
  const result = await signInWithEmail(getAuth(), { email, password: PASSWORD }, deps);
  if (result.status !== "SIGNED_IN") throw new Error("sign-in failed");
  const setCookie = result.setCookie.find((c) => c.startsWith(`${COOKIE}=`)) ?? "";
  const user = await system.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, cookie: setCookie.split(";")[0] ?? "" };
}

const actAs = (cookie: string | null) => {
  request.headers = new Headers(cookie === null ? {} : { cookie });
};

const valid = { name: "Acme Store", slug: "acme-store", defaultLocale: "ar" } as const;

const counts = async () => ({
  workspaces: await system.workspace.count(),
  members: await system.workspaceMember.count(),
  audits: await system.auditLog.count(),
});
const EMPTY = { workspaces: 0, members: 0, audits: 0 };

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function redirectLocation(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a redirect");
    },
    (caught: unknown) => caught,
  );
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) throw error;
  return digest.split(";")[2] ?? "";
}

// ── creation ─────────────────────────────────────────────────────────────────

describe("createWorkspaceAction", () => {
  it("rejects an unauthenticated request and writes nothing", async () => {
    actAs(null);
    const result = await createWorkspaceAction(valid);
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await counts()).toEqual(EMPTY);
  });

  it("creates a BUSINESS workspace owned by the session user — unverified email is fine", async () => {
    const creator = await signedInUser();
    expect((await system.user.findUniqueOrThrow({ where: { id: creator.id } })).emailVerified).toBe(
      false,
    );
    actAs(creator.cookie);

    const result = await createWorkspaceAction({ ...valid, defaultLocale: "en" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ name: "Acme Store", slug: "acme-store" });
    expect(Object.keys(result.data).sort()).toEqual(["id", "name", "slug"]);

    const workspace = await system.workspace.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(workspace).toMatchObject({
      name: "Acme Store",
      slug: "acme-store",
      type: "BUSINESS",
      parentWorkspaceId: null,
      defaultLocale: "en",
      deletedAt: null,
    });

    const members = await system.workspaceMember.findMany({ where: { workspaceId: workspace.id } });
    expect(members).toEqual([
      expect.objectContaining({ userId: creator.id, role: WorkspaceRole.OWNER }),
    ]);

    // The new workspace resolves through the normal access path with the stored role.
    const ctx = await requireWorkspaceAccess("acme-store", "workspace.delete");
    expect(ctx).toEqual({ userId: creator.id, workspaceId: workspace.id, role: "OWNER" });
  });

  it("records exactly one workspace.created audit entry for the actor and workspace", async () => {
    const creator = await signedInUser();
    actAs(creator.cookie);
    const result = await createWorkspaceAction(valid);
    if (!result.ok) throw new Error("creation failed");

    const audits = await system.auditLog.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: result.data.id,
      actorUserId: creator.id,
      action: "workspace.created",
      entityType: "workspace",
      entityId: result.data.id,
      metadata: { slug: "acme-store", type: "BUSINESS", defaultLocale: "ar", ownerRole: "OWNER" },
    });
    const stored = JSON.stringify(audits[0]);
    expect(stored).not.toContain(creator.cookie.split("=")[1] ?? "<none>");
    expect(stored).not.toContain(PASSWORD);
  });

  it.each([
    ["an AGENCY type", { type: "AGENCY" }],
    ["a parent workspace", { parentWorkspaceId: randomUUID() }],
    ["another owner", { ownerId: "OTHER" }],
    ["another user id", { userId: "OTHER" }],
    ["an initial role", { role: "OWNER" }],
    ["a workspace id", { id: randomUUID() }],
  ])("rejects a client-supplied %s and writes nothing", async (_label, extra) => {
    const creator = await signedInUser();
    const other = await signedInUser("Other");
    actAs(creator.cookie);
    const injected = Object.fromEntries(
      Object.entries(extra).map(([key, value]) => [key, value === "OTHER" ? other.id : value]),
    );

    const result = await createWorkspaceAction({ ...valid, ...injected });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    if (result.ok) return;
    expect(result.error.fields).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        params: { keys: Object.keys(extra)[0] },
      }),
    ]);
    expect(await counts()).toEqual(EMPTY);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(49)],
    ["with spaces", "acme store"],
    ["with an underscore", "acme_store"],
    ["with a slash", "acme/store"],
    ["path traversal", "../admin"],
    ["Arabic letters", "متجر-acme"],
    ["URL-encoded", "acme%2fstore"],
    ["empty", ""],
  ])("rejects a malformed slug (%s) and writes nothing", async (_label, slug) => {
    const creator = await signedInUser();
    actAs(creator.cookie);
    const result = await createWorkspaceAction({ ...valid, slug });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    if (result.ok) return;
    expect(result.error.fields?.map((field) => field.path)).toEqual(["slug"]);
    expect(await counts()).toEqual(EMPTY);
  });

  it("normalizes the slug to the stored lowercase form", async () => {
    actAs((await signedInUser()).cookie);
    const result = await createWorkspaceAction({ ...valid, slug: "  Acme-Store-2  " });
    expect(result).toMatchObject({ ok: true, data: { slug: "acme-store-2" } });
  });

  it("reports a taken slug (any case, including soft-deleted workspaces) as a slug field error", async () => {
    const first = await signedInUser();
    actAs(first.cookie);
    expect((await createWorkspaceAction(valid)).ok).toBe(true);
    const before = await counts();

    actAs((await signedInUser("Second")).cookie);
    for (const slug of ["acme-store", "ACME-STORE"]) {
      const result = await createWorkspaceAction({ ...valid, slug });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "CONFLICT", fields: [{ path: "slug", code: "slug_taken" }] },
      });
    }
    expect(await counts()).toEqual(before);

    await system.workspace.updateMany({ data: { deletedAt: new Date() } });
    expect(await createWorkspaceAction(valid)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });

  it("lets exactly one of two concurrent creations with the same slug succeed", async () => {
    const a = await signedInUser("A");
    const b = await signedInUser("B");
    const results = await Promise.allSettled([
      createWorkspace(db, { id: a.id }, valid),
      createWorkspace(db, { id: b.id }, valid),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(AppError);
    expect((rejected?.reason as AppError).code).toBe("CONFLICT");
    expect(await counts()).toEqual({ workspaces: 1, members: 1, audits: 1 });
  });
});

describe("createWorkspace atomicity", () => {
  it("rolls back the workspace and membership when the audit write fails", async () => {
    const creator = await signedInUser();
    const failingAudit = createGuardedClient(system).$extends({
      query: {
        auditLog: {
          create: () => Promise.reject(new Error("audit write failed")),
        },
      },
    }) as unknown as GuardedPrismaClient;

    await expect(createWorkspace(failingAudit, { id: creator.id }, valid)).rejects.toThrow(
      "audit write failed",
    );
    expect(await counts()).toEqual(EMPTY);
  });

  it("rolls back the workspace when the owner membership cannot be created", async () => {
    // A well-formed id with no user row: the membership insert fails (FK) after the
    // workspace insert succeeded.
    await expect(createWorkspace(db, { id: randomUUID() }, valid)).rejects.toThrow();
    expect(await counts()).toEqual(EMPTY);
  });

  it("runs on the tenant-guarded client and refuses a malformed creator id", async () => {
    await expect(createWorkspace(db, { id: "not-a-uuid" }, valid)).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(await counts()).toEqual(EMPTY);
  });
});

describe("form submission (submitCreateWorkspace)", () => {
  it("never forwards extra form fields and redirects into the new workspace", async () => {
    const creator = await signedInUser();
    const other = await signedInUser("Other");
    actAs(creator.cookie);

    const location = await redirectLocation(
      submitCreateWorkspace(
        "en",
        null,
        formData({
          ...valid,
          type: "AGENCY",
          role: "VIEWER",
          ownerId: other.id,
          userId: other.id,
        }),
      ),
    );
    expect(location).toBe("/en/w/acme-store");

    const workspace = await system.workspace.findUniqueOrThrow({ where: { slug: "acme-store" } });
    expect(workspace.type).toBe("BUSINESS");
    expect(await system.workspaceMember.findMany({ select: { userId: true, role: true } })).toEqual(
      [{ userId: creator.id, role: "OWNER" }],
    );
  });

  it("returns the code-only error and the submitted values on failure", async () => {
    actAs((await signedInUser()).cookie);
    const state = await submitCreateWorkspace(
      "ar",
      null,
      formData({ name: "", slug: "x", defaultLocale: "ar" }),
    );
    expect(state?.error.code).toBe("VALIDATION_FAILED");
    expect(state?.error.fields?.map((field) => field.path).sort()).toEqual(["name", "slug"]);
    expect(state?.values).toEqual({ name: "", slug: "x", defaultLocale: "ar" });
    expect(await counts()).toEqual(EMPTY);
  });

  it("is UNAUTHENTICATED without a session", async () => {
    actAs(null);
    const state = await submitCreateWorkspace("ar", null, formData(valid));
    expect(state?.error.code).toBe("UNAUTHENTICATED");
    expect(await counts()).toEqual(EMPTY);
  });
});

// ── selection ────────────────────────────────────────────────────────────────

describe("workspace list and landing", () => {
  it("requires a session", async () => {
    actAs(null);
    await expect(listMyWorkspaces()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("zero workspaces → create, one → open it, several → choose", async () => {
    const user = await signedInUser();
    actAs(user.cookie);
    expect(decideWorkspaceLanding(await listMyWorkspaces())).toEqual({ kind: "create" });

    await createWorkspace(db, user, { ...valid, name: "First", slug: "first-ws" });
    expect(decideWorkspaceLanding(await listMyWorkspaces())).toEqual({
      kind: "open",
      slug: "first-ws",
    });

    await createWorkspace(db, user, { ...valid, name: "Second", slug: "second-ws" });
    expect(decideWorkspaceLanding(await listMyWorkspaces())).toEqual({
      kind: "choose",
      workspaces: [
        { name: "First", slug: "first-ws", role: "OWNER" },
        { name: "Second", slug: "second-ws", role: "OWNER" },
      ],
    });
  });

  it("lists only the user's own memberships in non-deleted workspaces", async () => {
    const user = await signedInUser("Me");
    const stranger = await signedInUser("Stranger");
    const mine = await createWorkspace(db, user, { ...valid, name: "Mine", slug: "mine-ws" });
    await createWorkspace(db, stranger, { ...valid, name: "Theirs", slug: "theirs-ws" });
    const shared = await createWorkspace(db, stranger, {
      ...valid,
      name: "Shared",
      slug: "shared-ws",
    });
    await system.workspaceMember.create({
      data: { workspaceId: shared.id, userId: user.id, role: WorkspaceRole.EDITOR },
    });
    const gone = await createWorkspace(db, user, { ...valid, name: "Gone", slug: "gone-ws" });
    await system.workspace.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    actAs(user.cookie);
    expect(await listMyWorkspaces()).toEqual([
      { name: "Mine", slug: "mine-ws", role: "OWNER" },
      { name: "Shared", slug: "shared-ws", role: "EDITOR" },
    ]);
    expect(await listWorkspacesForUser(system, stranger.id)).toEqual([
      { name: "Theirs", slug: "theirs-ws", role: "OWNER" },
      { name: "Shared", slug: "shared-ws", role: "OWNER" },
    ]);
    expect(mine.slug).toBe("mine-ws");
  });

  it("opens the user's own workspace and hides other users' workspaces as NOT_FOUND", async () => {
    const owner = await signedInUser("Owner");
    const intruder = await signedInUser("Intruder");
    await createWorkspace(db, owner, { ...valid, name: "Private", slug: "private-ws" });

    actAs(owner.cookie);
    expect(await getWorkspaceOverview("private-ws")).toEqual({
      name: "Private",
      slug: "private-ws",
      role: "OWNER",
    });

    actAs(intruder.cookie);
    await expect(getWorkspaceOverview("private-ws")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getWorkspaceOverview("no-such-ws")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listMyWorkspaces()).toEqual([]);

    actAs(null);
    await expect(getWorkspaceOverview("private-ws")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});

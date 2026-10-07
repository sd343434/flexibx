// Phase 2, step 3: runtime session access and workspace authorization on the real
// database with real Better Auth sessions. Only `next/headers` is replaced, to hand
// each call the request headers a real Next.js request would carry.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { getAuth } from "@/server/auth/auth";
import { signInWithEmail, signUpWithEmail } from "@/server/auth/credentials";
import { getCurrentUser, requireUser } from "@/server/auth/session";
import { getSystemDb } from "@/server/db/client";
import { AppError } from "@/server/errors/app-error";
import { withAction } from "@/server/http/action-handler";
import { withRoute } from "@/server/http/route-handler";
import { requireWorkspaceAccess } from "@/server/tenancy/access";
import { listMembers } from "@/server/workspaces/member-repository";

import { createTestDb, resetDatabase } from "./helpers";

const request = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["workspace", "access", "test", "only", "0123456789abcdef"].join("-");
  return { headers: new Headers() };
});
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(request.headers),
  // These calls run outside a Next.js request scope, where cookies() throws; Better
  // Auth's nextCookies() plugin treats that as "nothing to write".
  cookies: () => Promise.reject(new Error("`cookies` was called outside a request scope.")),
}));

const { system, db } = createTestDb();
const APP = "http://localhost:3000";
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

/** A real account + session; returns the user id and the signed cookie header. */
async function signedInUser(name = "User") {
  counter += 1;
  const email = `user-${String(counter)}-${Date.now().toString(36)}@example.com`;
  await signUpWithEmail(getAuth(), { email, password: PASSWORD, name });
  const result = await signInWithEmail(getAuth(), { email, password: PASSWORD }, new Headers());
  if (result.status !== "SIGNED_IN") throw new Error("sign-in failed");
  const setCookie = result.setCookie.find((c) => c.startsWith(`${COOKIE}=`)) ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const user = await system.user.findUniqueOrThrow({ where: { email } });
  return {
    id: user.id,
    email,
    cookie,
    token: decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "",
  };
}

async function workspace(slug: string, members: { userId: string; role: WorkspaceRole }[]) {
  const ws = await system.workspace.create({ data: { name: slug, slug } });
  for (const member of members) {
    await system.workspaceMember.create({ data: { workspaceId: ws.id, ...member } });
  }
  return ws;
}

const actAs = (cookie: string | null, extra: Record<string, string> = {}) => {
  request.headers = new Headers({ ...(cookie === null ? {} : { cookie }), ...extra });
};

async function errorOf(promise: Promise<unknown>): Promise<{ code: string; metadata: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, metadata: error.metadata };
    throw error;
  }
  throw new Error("expected an AppError");
}

// ── user context ─────────────────────────────────────────────────────────────

describe("current user", () => {
  it("is null without a session and requireUser throws UNAUTHENTICATED", async () => {
    actAs(null);
    expect(await getCurrentUser()).toBeNull();
    expect((await errorOf(requireUser())).code).toBe("UNAUTHENTICATED");

    actAs(`${COOKIE}=forged.value`);
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns the signed-in user's own context, without any session data", async () => {
    const alice = await signedInUser("Alice");
    actAs(alice.cookie);
    const user = await requireUser();
    expect(user).toEqual({
      id: alice.id,
      email: alice.email,
      name: "Alice",
      image: null,
      locale: "ar",
      emailVerified: false,
    });
    expect(Object.isFrozen(user)).toBe(true);
    expect(JSON.stringify(user)).not.toContain(alice.token);
  });

  it("is UNAUTHENTICATED after sign-out-style revocation and after expiry", async () => {
    const bob = await signedInUser();
    actAs(bob.cookie);
    expect((await requireUser()).id).toBe(bob.id);

    await system.session.updateMany({
      where: { userId: bob.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await errorOf(requireUser())).code).toBe("UNAUTHENTICATED");

    const carol = await signedInUser();
    actAs(carol.cookie);
    await (await getAuth().$context).internalAdapter.deleteUserSessions(carol.id);
    expect((await errorOf(requireUser())).code).toBe("UNAUTHENTICATED");
  });
});

// ── workspace access ─────────────────────────────────────────────────────────

describe("requireWorkspaceAccess", () => {
  it("requires a session before anything else", async () => {
    const owner = await signedInUser();
    await workspace("acme-team", [{ userId: owner.id, role: WorkspaceRole.OWNER }]);
    actAs(null);
    expect((await errorOf(requireWorkspaceAccess("acme-team"))).code).toBe("UNAUTHENTICATED");
  });

  it("grants a member a TenantContext built from the membership row", async () => {
    const owner = await signedInUser();
    const ws = await workspace("acme-team", [{ userId: owner.id, role: WorkspaceRole.OWNER }]);
    actAs(owner.cookie);
    const ctx = await requireWorkspaceAccess("acme-team");
    expect(ctx).toEqual({ userId: owner.id, workspaceId: ws.id, role: "OWNER" });
    expect(Object.isFrozen(ctx)).toBe(true);
    // Slugs are case-insensitive routing ids.
    expect((await requireWorkspaceAccess("  ACME-Team ")).workspaceId).toBe(ws.id);
  });

  it("denies non-members, cross-tenant users, unknown and deleted workspaces identically", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    await workspace("alpha-ws", [{ userId: alice.id, role: WorkspaceRole.OWNER }]);
    const beta = await workspace("beta-ws", [{ userId: bob.id, role: WorkspaceRole.OWNER }]);
    await workspace("gone-ws", [{ userId: alice.id, role: WorkspaceRole.OWNER }]);
    await system.workspace.update({ where: { slug: "gone-ws" }, data: { deletedAt: new Date() } });

    actAs(alice.cookie);
    const crossTenant = await errorOf(requireWorkspaceAccess("beta-ws"));
    const unknown = await errorOf(requireWorkspaceAccess("does-not-exist"));
    const deleted = await errorOf(requireWorkspaceAccess("gone-ws"));
    const malformed = await errorOf(requireWorkspaceAccess("../beta-ws"));
    expect(crossTenant).toEqual({ code: "NOT_FOUND", metadata: { resource: "workspace" } });
    for (const other of [unknown, deleted, malformed]) expect(other).toEqual(crossTenant);

    // The workspace id itself is not a valid routing key, even for a member.
    actAs(bob.cookie);
    expect(await errorOf(requireWorkspaceAccess(beta.id))).toEqual(crossTenant);
  });

  it("ignores client-supplied workspace ids and roles", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const alpha = await workspace("alpha-ws", [{ userId: alice.id, role: WorkspaceRole.VIEWER }]);
    const beta = await workspace("beta-ws", [{ userId: bob.id, role: WorkspaceRole.OWNER }]);

    actAs(alice.cookie, {
      "x-workspace-id": beta.id,
      "x-workspace-role": "OWNER",
      "x-user-id": bob.id,
    });
    expect((await errorOf(requireWorkspaceAccess("beta-ws"))).code).toBe("NOT_FOUND");
    const ctx = await requireWorkspaceAccess("alpha-ws");
    expect(ctx).toEqual({ userId: alice.id, workspaceId: alpha.id, role: "VIEWER" });
  });

  it("enforces permissions from the stored role", async () => {
    const viewer = await signedInUser();
    const admin = await signedInUser();
    await workspace("acme-team", [
      { userId: viewer.id, role: WorkspaceRole.VIEWER },
      { userId: admin.id, role: WorkspaceRole.ADMIN },
    ]);
    actAs(viewer.cookie);
    expect((await requireWorkspaceAccess("acme-team", "workspace.view")).role).toBe("VIEWER");
    expect((await errorOf(requireWorkspaceAccess("acme-team", "workspace.update"))).code).toBe(
      "FORBIDDEN",
    );
    actAs(admin.cookie);
    expect((await requireWorkspaceAccess("acme-team", "workspace.update")).role).toBe("ADMIN");
  });

  it("feeds the guarded repositories, which stay scoped to that workspace", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const alpha = await workspace("alpha-ws", [{ userId: alice.id, role: WorkspaceRole.OWNER }]);
    await workspace("beta-ws", [{ userId: bob.id, role: WorkspaceRole.OWNER }]);
    actAs(alice.cookie);
    const ctx = await requireWorkspaceAccess("alpha-ws", "member.view");
    const members = await listMembers(db, ctx);
    expect(members.map((m) => m.workspaceId)).toEqual([alpha.id]);
    await expect(db.workspaceMember.findMany()).rejects.toSatisfy(
      (error) => error instanceof AppError && error.code === "TENANT_SCOPE_MISSING",
    );
  });
});

// ── withRoute / withAction with the authorization primitives ─────────────────

describe("route and action wrappers", () => {
  const membersRoute = withRoute({
    name: "test.members",
    params: z.object({ slug: z.string() }),
    handler: async ({ request: req, params }) => {
      request.headers = req.headers; // what next/headers would expose for this request
      const ctx = await requireWorkspaceAccess(params.slug, "member.view");
      return { count: (await listMembers(db, ctx)).length };
    },
  });
  const call = (slug: string, init: RequestInit = {}) =>
    membersRoute(new Request(`${APP}/api/w/${slug}/members`, init), {
      params: Promise.resolve({ slug }),
    });

  it("maps no session / other tenant / allowed to 401 / 404 / 200", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    await workspace("alpha-ws", [{ userId: alice.id, role: WorkspaceRole.OWNER }]);
    await workspace("beta-ws", [{ userId: bob.id, role: WorkspaceRole.OWNER }]);

    expect((await call("alpha-ws")).status).toBe(401);
    expect((await call("beta-ws", { headers: { cookie: alice.cookie } })).status).toBe(404);
    const ok = await call("alpha-ws", { headers: { cookie: alice.cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ count: 1 });
  });

  it("rejects a cookie-bearing cross-origin mutation before the handler runs", async () => {
    const alice = await signedInUser();
    await workspace("alpha-ws", [{ userId: alice.id, role: WorkspaceRole.OWNER }]);
    let ran = false;
    const mutate = withRoute({
      name: "test.mutate",
      handler: () => {
        ran = true;
        return { ok: true };
      },
    });
    const response = await mutate(
      new Request(`${APP}/api/w/alpha-ws/x`, {
        method: "POST",
        headers: { cookie: alice.cookie, origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect(ran).toBe(false);
  });

  it("server actions authorize from the session and stored role, not from input", async () => {
    const viewer = await signedInUser();
    await workspace("acme-team", [{ userId: viewer.id, role: WorkspaceRole.VIEWER }]);
    const rename = withAction({
      name: "test.workspace.rename",
      input: z.object({ slug: z.string(), name: z.string().min(1) }).strict(),
      handler: async ({ slug }) => {
        const ctx = await requireWorkspaceAccess(slug, "workspace.update");
        return { workspaceId: ctx.workspaceId };
      },
    });

    actAs(viewer.cookie);
    expect(await rename({ slug: "acme-team", name: "x" })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await rename({ slug: "acme-team", name: "x", role: "OWNER" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    actAs(null);
    expect(await rename({ slug: "acme-team", name: "x" })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });
});

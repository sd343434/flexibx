// Phase 2, step 7: member management and invitations on the real database, through
// the tenant-guarded client. Contexts are built as `requireWorkspaceAccess` would
// build them; the session/action layer is covered in members-flow.test.ts.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import { type AppError, isAppError } from "@/server/errors/app-error";
import { MemoryMailer, UnconfiguredMailer, type Mailer } from "@/server/mail/mailer";
import { resolveWorkspaceAccess } from "@/server/tenancy/access";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";
import { acceptInvitation, previewInvitation } from "@/server/tenancy/invitation-acceptance";
import {
  createInvitation,
  listPendingInvitations,
  revokeInvitation,
} from "@/server/workspaces/invitation-service";
import { hashInvitationToken } from "@/server/workspaces/invitation-token";
import { listMembers } from "@/server/workspaces/member-repository";
import { changeMemberRole, leaveWorkspace, removeMember } from "@/server/workspaces/member-service";

import { createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();
const APP_URL = "https://app.flexibx.test";

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

let counter = 0;
async function user(name = "User", email?: string) {
  counter += 1;
  return system.user.create({
    data: {
      name,
      email: email ?? `member-${String(counter)}-${Date.now().toString(36)}@example.com`,
    },
  });
}

async function workspace(slug = `ws-${String(++counter)}`) {
  return system.workspace.create({ data: { name: `Workspace ${slug}`, slug } });
}

/** Adds `userId` to the workspace and returns the context `requireWorkspaceAccess` would. */
async function join(workspaceId: string, userId: string, role: WorkspaceRole) {
  const member = await system.workspaceMember.create({ data: { workspaceId, userId, role } });
  return { member, ctx: createTenantContext({ workspaceId, userId, role }) };
}

/** A workspace with an OWNER and one member of each other team role. */
async function team() {
  const ws = await workspace();
  const roles = [
    WorkspaceRole.OWNER,
    WorkspaceRole.ADMIN,
    WorkspaceRole.MANAGER,
    WorkspaceRole.EDITOR,
    WorkspaceRole.VIEWER,
    WorkspaceRole.CLIENT,
  ] as const;
  const entries = await Promise.all(
    roles.map(async (role) => {
      const u = await user(role);
      return [role, { user: u, ...(await join(ws.id, u.id, role)) }] as const;
    }),
  );
  return {
    ws,
    ...(Object.fromEntries(entries) as Record<
      (typeof roles)[number],
      Awaited<ReturnType<typeof join>> & { user: Awaited<ReturnType<typeof user>> }
    >),
  };
}

const deps = (mailer: Mailer = new MemoryMailer()) => ({
  mailer,
  appUrl: APP_URL,
  inviterName: "Reem",
});
const tokenOf = (url: string) => url.split("/invite/")[1] ?? "";

async function invite(
  ctx: TenantContext,
  email: string,
  role: "ADMIN" | "MANAGER" | "EDITOR" | "VIEWER" = "EDITOR",
  mailer?: Mailer,
) {
  const created = await createInvitation(db, ctx, { email, role, locale: "en" }, deps(mailer));
  return { ...created, token: tokenOf(created.acceptUrl) };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected an AppError");
    },
    (caught: unknown) => caught,
  );
  if (!isAppError(error)) throw error;
  return error;
}
/** A promise with its resolver (Promise.withResolvers is outside the TS lib target). */
function deferred() {
  let resolve: (value: undefined) => void = () => undefined;
  const promise = new Promise<undefined>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fieldCodes = (error: AppError) => error.fields.map((field) => field.code);

const auditActions = async (workspaceId: string) =>
  (await system.auditLog.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } })).map(
    (row) => row.action,
  );

// ── listing ──────────────────────────────────────────────────────────────────

describe("members list", () => {
  it("shows only the context workspace's members, for every role with member.view", async () => {
    const { ws, OWNER, VIEWER, CLIENT } = await team();
    const other = await workspace();
    const outsider = await user("Outsider");
    await join(other.id, outsider.id, WorkspaceRole.OWNER);

    const members = await listMembers(db, VIEWER.ctx);
    expect(members).toHaveLength(6);
    expect(members.every((member) => member.workspaceId === ws.id)).toBe(true);
    expect(members.map((member) => member.user.email)).not.toContain(outsider.email);
    expect((await listMembers(db, OWNER.ctx)).length).toBe(6);
    expect((await errorOf(listMembers(db, CLIENT.ctx))).code).toBe("FORBIDDEN");
  });
});

// ── invitations ──────────────────────────────────────────────────────────────

describe("creating invitations", () => {
  it("OWNER and ADMIN can invite; every other role is FORBIDDEN", async () => {
    const t = await team();
    for (const role of ["OWNER", "ADMIN"] as const) {
      const created = await invite(t[role].ctx, `${role.toLowerCase()}-invitee@example.com`);
      expect(created.role).toBe("EDITOR");
    }
    for (const role of ["MANAGER", "EDITOR", "VIEWER", "CLIENT"] as const) {
      expect((await errorOf(invite(t[role].ctx, `x-${role}@example.com`))).code).toBe("FORBIDDEN");
    }
    expect(await system.workspaceInvitation.count()).toBe(2);
  });

  it("stores only the token hash, expires in 7 days and audits without secrets", async () => {
    const { ws, OWNER } = await team();
    const now = new Date("2026-10-07T10:00:00Z");
    const created = await createInvitation(
      db,
      OWNER.ctx,
      { email: "new@example.com", role: "VIEWER", locale: "ar" },
      { ...deps(), now: () => now },
    );
    expect(created.acceptUrl).toMatch(new RegExp(`^${APP_URL}/ar/invite/[A-Za-z0-9_-]{43}$`));
    const token = tokenOf(created.acceptUrl);

    const row = await system.workspaceInvitation.findFirstOrThrow({
      where: { workspaceId: ws.id },
    });
    expect(row.tokenHash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.toISOString()).toBe("2026-10-14T10:00:00.000Z");
    expect(row.invitedByUserId).toBe(OWNER.user.id);

    const audit = await system.auditLog.findFirstOrThrow({ where: { action: "member.invited" } });
    expect(audit.workspaceId).toBe(ws.id);
    expect(audit.actorUserId).toBe(OWNER.user.id);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(row.tokenHash);
  });

  it("rejects existing members and duplicate pending invitations (case-insensitive)", async () => {
    const { OWNER, EDITOR } = await team();
    const asMember = await errorOf(
      invite(OWNER.ctx, EDITOR.user.email.toUpperCase().toLowerCase()),
    );
    expect(asMember.code).toBe("CONFLICT");
    expect(fieldCodes(asMember)).toEqual(["already_member"]);

    await invite(OWNER.ctx, "dup@example.com");
    const duplicate = await errorOf(invite(OWNER.ctx, "dup@example.com"));
    expect(duplicate.code).toBe("CONFLICT");
    expect(fieldCodes(duplicate)).toEqual(["invitation_pending"]);
  });

  it("replaces an expired pending invitation for the same address", async () => {
    const { OWNER } = await team();
    const first = await createInvitation(
      db,
      OWNER.ctx,
      { email: "late@example.com", role: "EDITOR", locale: "en" },
      { ...deps(), now: () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    );
    const second = await invite(OWNER.ctx, "late@example.com");
    expect(second.invitationId).not.toBe(first.invitationId);
    expect(await system.workspaceInvitation.count()).toBe(1);
  });

  it("ADMIN's grant ceiling: OWNER is never invitable, and the database refuses it too", async () => {
    const { ws, OWNER } = await team();
    await expect(
      createInvitation(
        db,
        OWNER.ctx,
        { email: "o@example.com", role: "OWNER" as "ADMIN", locale: "en" },
        deps(),
      ),
    ).rejects.toThrow();
    await expect(
      system.workspaceInvitation.create({
        data: {
          workspaceId: ws.id,
          email: "o@example.com",
          role: WorkspaceRole.OWNER,
          tokenHash: "a".repeat(64),
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    ).rejects.toThrow(/workspace_invitations_role_not_owner_check/);
  });

  it("reports delivery honestly and keeps the invitation when email fails", async () => {
    const { OWNER } = await team();
    const memory = new MemoryMailer();
    const dev = await invite(OWNER.ctx, "dev@example.com", "EDITOR", memory);
    expect(dev.delivery).toEqual({ status: "not_sent", reason: "development" });
    expect(memory.outbox).toHaveLength(1);
    expect(memory.outbox[0]?.to).toBe("dev@example.com");
    expect(memory.outbox[0]?.text).toContain(dev.acceptUrl);

    const none = await invite(OWNER.ctx, "prod@example.com", "EDITOR", new UnconfiguredMailer());
    expect(none.delivery).toEqual({ status: "not_sent", reason: "not_configured" });

    const broken: Mailer = {
      transport: "broken",
      send: () => Promise.reject(new Error("smtp down")),
    };
    const failed = await invite(OWNER.ctx, "fail@example.com", "EDITOR", broken);
    expect(failed.delivery).toEqual({ status: "not_sent", reason: "failed" });

    const sent: Mailer = {
      transport: "fake-provider",
      send: () => Promise.resolve({ status: "sent" }),
    };
    expect((await invite(OWNER.ctx, "ok@example.com", "EDITOR", sent)).delivery).toEqual({
      status: "sent",
    });
    expect(await system.workspaceInvitation.count()).toBe(4);
  });

  it("uses the actor's current role, not the one in a stale context", async () => {
    const { ADMIN } = await team();
    await system.workspaceMember.update({
      where: { id: ADMIN.member.id },
      data: { role: WorkspaceRole.VIEWER },
    });
    expect((await errorOf(invite(ADMIN.ctx, "late@example.com"))).code).toBe("FORBIDDEN");
    await system.workspaceMember.delete({ where: { id: ADMIN.member.id } });
    expect((await errorOf(invite(ADMIN.ctx, "late@example.com"))).code).toBe("NOT_FOUND");
  });
});

describe("pending invitations and revocation", () => {
  it("lists open invitations (flagging expired ones) to inviters only", async () => {
    const { OWNER, ADMIN, MANAGER } = await team();
    await invite(OWNER.ctx, "a@example.com");
    await createInvitation(
      db,
      OWNER.ctx,
      { email: "old@example.com", role: "VIEWER", locale: "en" },
      { ...deps(), now: () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    );
    const revoked = await invite(OWNER.ctx, "gone@example.com");
    await revokeInvitation(db, OWNER.ctx, { invitationId: revoked.invitationId });

    const pending = await listPendingInvitations(db, ADMIN.ctx);
    expect(pending.map((row) => [row.email, row.expired])).toEqual([
      ["a@example.com", false],
      ["old@example.com", true],
    ]);
    expect(pending[0]?.invitedBy).toBe("OWNER");
    expect((await errorOf(listPendingInvitations(db, MANAGER.ctx))).code).toBe("FORBIDDEN");
  });

  it("revoking stops the link; revoking twice, foreign or unknown ids are NOT_FOUND", async () => {
    const { ws, OWNER, ADMIN, MANAGER } = await team();
    const invitee = await user("Invitee", "revoked@example.com");
    const created = await invite(OWNER.ctx, invitee.email);

    expect(
      (await errorOf(revokeInvitation(db, MANAGER.ctx, { invitationId: created.invitationId })))
        .code,
    ).toBe("FORBIDDEN");
    await revokeInvitation(db, ADMIN.ctx, { invitationId: created.invitationId });
    expect(
      (await errorOf(revokeInvitation(db, ADMIN.ctx, { invitationId: created.invitationId }))).code,
    ).toBe("NOT_FOUND");
    expect((await errorOf(acceptInvitation(system, db, invitee, created.token))).code).toBe(
      "NOT_FOUND",
    );
    expect(await auditActions(ws.id)).toContain("invitation.revoked");

    const other = await team();
    const foreign = await invite(other.OWNER.ctx, "foreign@example.com");
    expect(
      (await errorOf(revokeInvitation(db, OWNER.ctx, { invitationId: foreign.invitationId }))).code,
    ).toBe("NOT_FOUND");
    expect(
      (await system.workspaceInvitation.findUniqueOrThrow({ where: { id: foreign.invitationId } }))
        .revokedAt,
    ).toBeNull();
    expect(
      (await errorOf(revokeInvitation(db, OWNER.ctx, { invitationId: crypto.randomUUID() }))).code,
    ).toBe("NOT_FOUND");
  });
});

// ── acceptance ───────────────────────────────────────────────────────────────

describe("accepting invitations", () => {
  it("creates the membership with the invited role, consumes the token and audits", async () => {
    const { ws, OWNER } = await team();
    const invitee = await user("Invitee", "Join.Me@Example.com");
    const created = await invite(OWNER.ctx, "join.me@example.com", "MANAGER");

    expect(await previewInvitation(system, invitee, created.token)).toMatchObject({
      status: "valid",
      workspaceName: ws.name,
      role: "MANAGER",
      inviterName: "OWNER",
    });
    expect(await acceptInvitation(system, db, invitee, created.token)).toEqual({ slug: ws.slug });

    const ctx = await resolveWorkspaceAccess(system, invitee.id, ws.slug);
    expect(ctx.role).toBe("MANAGER");
    const row = await system.workspaceInvitation.findUniqueOrThrow({
      where: { id: created.invitationId },
    });
    expect(row.acceptedAt).not.toBeNull();
    expect(await auditActions(ws.id)).toEqual(
      expect.arrayContaining(["member.invited", "invitation.accepted", "member.added"]),
    );
    const added = await system.auditLog.findFirstOrThrow({ where: { action: "member.added" } });
    expect(added.actorUserId).toBe(invitee.id);
  });

  it("is single-use: a replay is the same NOT_FOUND as an unknown token", async () => {
    const { OWNER } = await team();
    const invitee = await user("Invitee", "once@example.com");
    const created = await invite(OWNER.ctx, invitee.email);
    await acceptInvitation(system, db, invitee, created.token);

    const replay = await errorOf(acceptInvitation(system, db, invitee, created.token));
    const unknown = await errorOf(acceptInvitation(system, db, invitee, "x".repeat(43)));
    const malformed = await errorOf(acceptInvitation(system, db, invitee, "../../etc/passwd"));
    for (const error of [replay, unknown, malformed]) {
      expect(error.code).toBe("NOT_FOUND");
      expect(fieldCodes(error)).toEqual(["invitation_invalid"]);
    }
    expect(await previewInvitation(system, invitee, created.token)).toEqual({ status: "invalid" });
  });

  it("concurrent accepts of one token create exactly one membership", async () => {
    const { ws, OWNER } = await team();
    const invitee = await user("Invitee", "race@example.com");
    const created = await invite(OWNER.ctx, invitee.email);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => acceptInvitation(system, db, invitee, created.token)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await system.workspaceMember.count({ where: { workspaceId: ws.id, userId: invitee.id } }),
    ).toBe(1);
    expect(await system.auditLog.count({ where: { action: "invitation.accepted" } })).toBe(1);
  });

  it("accepts that all passed the pre-check still claim the token only once", async () => {
    const { ws, OWNER } = await team();
    const invitee = await user("Invitee", "queued@example.com");
    const created = await invite(OWNER.ctx, invitee.email);

    // Hold the workspace's membership lock so every accept passes its pre-check and then
    // queues on the lock; only the claim inside the transaction can tell them apart.
    const held = deferred();
    const lockTaken = deferred();
    const holder = system.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ws.id}::uuid FOR UPDATE`;
        lockTaken.resolve(undefined);
        await held.promise;
      },
      { timeout: 20_000 },
    );
    await lockTaken.promise;
    const attempts = Array.from({ length: 3 }, () =>
      acceptInvitation(system, db, invitee, created.token),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    held.resolve(undefined);
    await holder;
    const results = await Promise.allSettled(attempts);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "NOT_FOUND",
          fields: [{ code: "invitation_invalid" }],
        });
      }
    }
    expect(await system.auditLog.count({ where: { action: "invitation.accepted" } })).toBe(1);
  });

  it("expired, revoked and deleted-workspace invitations are all 'invalid'", async () => {
    const { ws, OWNER } = await team();
    const invitee = await user("Invitee", "late@example.com");
    const expired = await invite(OWNER.ctx, invitee.email);
    const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000);
    expect(await previewInvitation(system, invitee, expired.token, later)).toEqual({
      status: "invalid",
    });
    expect(
      fieldCodes(await errorOf(acceptInvitation(system, db, invitee, expired.token, later))),
    ).toEqual(["invitation_invalid"]);

    await system.workspace.update({ where: { id: ws.id }, data: { deletedAt: new Date() } });
    expect(await previewInvitation(system, invitee, expired.token)).toEqual({ status: "invalid" });
    expect((await errorOf(acceptInvitation(system, db, invitee, expired.token))).code).toBe(
      "NOT_FOUND",
    );
    expect(await system.workspaceMember.count({ where: { userId: invitee.id } })).toBe(0);
  });

  it("only the invited address can accept, and other accounts learn nothing", async () => {
    const { ws, OWNER } = await team();
    const stranger = await user("Stranger", "stranger@example.com");
    const created = await invite(OWNER.ctx, "invitee@example.com");
    expect(await previewInvitation(system, stranger, created.token)).toEqual({
      status: "email_mismatch",
    });
    const error = await errorOf(acceptInvitation(system, db, stranger, created.token));
    expect(error.code).toBe("FORBIDDEN");
    expect(fieldCodes(error)).toEqual(["invitation_email_mismatch"]);
    expect(
      await system.workspaceMember.count({ where: { workspaceId: ws.id, userId: stranger.id } }),
    ).toBe(0);
    expect(
      (await system.workspaceInvitation.findUniqueOrThrow({ where: { id: created.invitationId } }))
        .acceptedAt,
    ).toBeNull();
  });

  it("an existing member gets CONFLICT and the invitation stays open", async () => {
    const { ws, OWNER } = await team();
    const invitee = await user("Invitee", "twice@example.com");
    const created = await invite(OWNER.ctx, invitee.email, "ADMIN");
    await join(ws.id, invitee.id, WorkspaceRole.VIEWER);

    expect(await previewInvitation(system, invitee, created.token)).toEqual({
      status: "already_member",
      slug: ws.slug,
    });
    const error = await errorOf(acceptInvitation(system, db, invitee, created.token));
    expect(error.code).toBe("CONFLICT");
    expect((await resolveWorkspaceAccess(system, invitee.id, ws.slug)).role).toBe("VIEWER");
    expect(
      (await system.workspaceInvitation.findUniqueOrThrow({ where: { id: created.invitationId } }))
        .acceptedAt,
    ).toBeNull();
  });

  it("a token only ever joins its own workspace", async () => {
    const a = await team();
    const b = await team();
    const invitee = await user("Invitee", "scoped@example.com");
    const created = await invite(a.OWNER.ctx, invitee.email);
    await acceptInvitation(system, db, invitee, created.token);
    expect(
      await system.workspaceMember.count({ where: { workspaceId: b.ws.id, userId: invitee.id } }),
    ).toBe(0);
    await expect(resolveWorkspaceAccess(system, invitee.id, b.ws.slug)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ── role changes, removal, leaving ───────────────────────────────────────────

describe("changing roles", () => {
  it("ADMIN and OWNER change non-owner roles, with an audit entry", async () => {
    const { ws, OWNER, ADMIN, EDITOR, VIEWER } = await team();
    expect(
      await changeMemberRole(db, ADMIN.ctx, { memberId: EDITOR.member.id, role: "VIEWER" }),
    ).toEqual({
      memberId: EDITOR.member.id,
      role: "VIEWER",
      changed: true,
    });
    await changeMemberRole(db, OWNER.ctx, { memberId: VIEWER.member.id, role: "ADMIN" });
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: VIEWER.member.id } })).role,
    ).toBe("ADMIN");
    const audit = await system.auditLog.findFirstOrThrow({
      where: { workspaceId: ws.id, action: "member.role_changed" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.metadata).toMatchObject({ from: "EDITOR", to: "VIEWER" });

    // Setting the same role is a no-op without an audit entry.
    expect(
      (await changeMemberRole(db, OWNER.ctx, { memberId: VIEWER.member.id, role: "ADMIN" }))
        .changed,
    ).toBe(false);
    expect(await system.auditLog.count({ where: { action: "member.role_changed" } })).toBe(2);
  });

  it("refuses roles without member.updateRole, self changes and ADMIN touching an OWNER", async () => {
    const { OWNER, ADMIN, MANAGER, EDITOR } = await team();
    expect(
      (
        await errorOf(
          changeMemberRole(db, MANAGER.ctx, { memberId: EDITOR.member.id, role: "VIEWER" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await errorOf(
          changeMemberRole(db, ADMIN.ctx, { memberId: ADMIN.member.id, role: "VIEWER" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (await errorOf(changeMemberRole(db, OWNER.ctx, { memberId: OWNER.member.id, role: "ADMIN" })))
        .code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await errorOf(
          changeMemberRole(db, ADMIN.ctx, { memberId: OWNER.member.id, role: "VIEWER" }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: OWNER.member.id } })).role,
    ).toBe("OWNER");
  });

  it("member ids from another workspace are NOT_FOUND and untouched", async () => {
    const { OWNER } = await team();
    const other = await team();
    const error = await errorOf(
      changeMemberRole(db, OWNER.ctx, { memberId: other.EDITOR.member.id, role: "VIEWER" }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: other.EDITOR.member.id } }))
        .role,
    ).toBe("EDITOR");
  });

  it("re-checks the grant ceiling with the actor's current role", async () => {
    const { ws, OWNER } = await team();
    const second = await user("Second owner");
    const co = await join(ws.id, second.id, WorkspaceRole.OWNER);
    // OWNER is demoted to ADMIN after their context was built: still allowed to manage
    // members, but no longer allowed to touch an OWNER.
    await system.workspaceMember.update({
      where: { id: OWNER.member.id },
      data: { role: WorkspaceRole.ADMIN },
    });
    expect(
      (await errorOf(changeMemberRole(db, OWNER.ctx, { memberId: co.member.id, role: "VIEWER" })))
        .code,
    ).toBe("FORBIDDEN");
    expect((await errorOf(removeMember(db, OWNER.ctx, { memberId: co.member.id }))).code).toBe(
      "FORBIDDEN",
    );
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: co.member.id } })).role,
    ).toBe("OWNER");
  });

  it("an OWNER can demote a co-owner, but two owners demoting each other leave one owner", async () => {
    const { ws, OWNER } = await team();
    const second = await user("Second owner");
    const co = await join(ws.id, second.id, WorkspaceRole.OWNER);
    const results = await Promise.allSettled([
      changeMemberRole(db, OWNER.ctx, { memberId: co.member.id, role: "ADMIN" }),
      changeMemberRole(db, co.ctx, { memberId: OWNER.member.id, role: "ADMIN" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await system.workspaceMember.count({ where: { workspaceId: ws.id, role: "OWNER" } }),
    ).toBe(1);
  });
});

describe("removing members", () => {
  it("removes a member, who then loses access immediately", async () => {
    const { ws, ADMIN, EDITOR } = await team();
    await removeMember(db, ADMIN.ctx, { memberId: EDITOR.member.id });
    await expect(resolveWorkspaceAccess(system, EDITOR.user.id, ws.slug)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const audit = await system.auditLog.findFirstOrThrow({ where: { action: "member.removed" } });
    expect(audit.metadata).toMatchObject({ userId: EDITOR.user.id, role: "EDITOR" });
  });

  it("refuses non-admins, self removal, ADMIN removing an OWNER and foreign ids", async () => {
    const { OWNER, ADMIN, MANAGER, VIEWER } = await team();
    const other = await team();
    expect(
      (await errorOf(removeMember(db, MANAGER.ctx, { memberId: VIEWER.member.id }))).code,
    ).toBe("FORBIDDEN");
    expect((await errorOf(removeMember(db, ADMIN.ctx, { memberId: ADMIN.member.id }))).code).toBe(
      "FORBIDDEN",
    );
    expect((await errorOf(removeMember(db, ADMIN.ctx, { memberId: OWNER.member.id }))).code).toBe(
      "FORBIDDEN",
    );
    expect(
      (await errorOf(removeMember(db, OWNER.ctx, { memberId: other.VIEWER.member.id }))).code,
    ).toBe("NOT_FOUND");
    expect(await system.workspaceMember.count({ where: { workspaceId: other.ws.id } })).toBe(6);
  });

  it("never removes the last OWNER, even concurrently", async () => {
    const { ws, OWNER } = await team();
    const second = await user("Second owner");
    const co = await join(ws.id, second.id, WorkspaceRole.OWNER);
    const results = await Promise.allSettled([
      removeMember(db, OWNER.ctx, { memberId: co.member.id }),
      removeMember(db, co.ctx, { memberId: OWNER.member.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await system.workspaceMember.count({ where: { workspaceId: ws.id, role: "OWNER" } }),
    ).toBe(1);
  });
});

describe("leaving a workspace", () => {
  it("any member can leave; the action is audited", async () => {
    const { ws, VIEWER, CLIENT } = await team();
    await leaveWorkspace(db, VIEWER.ctx);
    await leaveWorkspace(db, CLIENT.ctx);
    expect(await system.workspaceMember.count({ where: { workspaceId: ws.id } })).toBe(4);
    expect((await auditActions(ws.id)).filter((action) => action === "member.left")).toHaveLength(
      2,
    );
    expect((await errorOf(leaveWorkspace(db, VIEWER.ctx))).code).toBe("NOT_FOUND");
  });

  it("the last OWNER cannot leave; with a co-owner, one of two simultaneous leaves fails", async () => {
    const { ws, OWNER } = await team();
    const error = await errorOf(leaveWorkspace(db, OWNER.ctx));
    expect(error.code).toBe("CONFLICT");
    expect(fieldCodes(error)).toEqual(["last_owner"]);

    const second = await user("Second owner");
    const co = await join(ws.id, second.id, WorkspaceRole.OWNER);
    const results = await Promise.allSettled([
      leaveWorkspace(db, OWNER.ctx),
      leaveWorkspace(db, co.ctx),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await system.workspaceMember.count({ where: { workspaceId: ws.id, role: "OWNER" } }),
    ).toBe(1);
  });
});

describe("invitation table constraints", () => {
  it("allow one pending invitation per address and workspace, and a hex token hash only", async () => {
    const { ws } = await team();
    const base = {
      workspaceId: ws.id,
      email: "c@example.com",
      role: WorkspaceRole.EDITOR,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await system.workspaceInvitation.create({ data: { ...base, tokenHash: "a".repeat(64) } });
    await expect(
      system.workspaceInvitation.create({
        data: { ...base, email: "C@EXAMPLE.COM", tokenHash: "b".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      system.workspaceInvitation.create({
        data: { ...base, email: "d@example.com", tokenHash: "PLAINTEXT".padEnd(64, "x") },
      }),
    ).rejects.toThrow(/token_hash_check/);
    await expect(
      system.workspaceInvitation.create({
        data: {
          ...base,
          email: "e@example.com",
          tokenHash: "c".repeat(64),
          acceptedAt: new Date(),
          revokedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/single_outcome_check/);
  });
});

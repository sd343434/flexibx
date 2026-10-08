// Phase 2, step 7: members and invitations through the real entry points — server
// actions, pages and Better Auth sessions — on the real database. The request double
// is the one from app-shell.test.ts: `next/headers` carries the "browser" cookies.
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignUp } from "@/app/[locale]/(auth)/actions";
import { submitAcceptInvitation } from "@/app/[locale]/invite/[token]/actions";
import InvitePage from "@/app/[locale]/invite/[token]/page";
import {
  submitChangeRole,
  submitInvite,
  submitLeaveWorkspace,
  submitRemoveMember,
  submitRevokeInvitation,
} from "@/app/[locale]/w/[workspaceSlug]/members/actions";
import { InviteForm } from "@/app/[locale]/w/[workspaceSlug]/members/member-forms";
import MembersRoute from "@/app/[locale]/w/[workspaceSlug]/members/page";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { getSystemDb } from "@/server/db/client";
import { previewInvitationForCurrentUser } from "@/server/tenancy/invitation-acceptance";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
} from "@/server/workspaces/member-actions";
import { getMembersPage, getWorkspaceShell } from "@/server/workspaces/workspace-queries";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["members", "flow", "test", "only", "secret", "0123456789abcdef"].join(
    "-",
  );
  const jar = new Map<string, string>();

  function requestHeaders(): Headers {
    const cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
    return new Headers({
      origin: "http://localhost:3000",
      "next-action": "test-action",
      ...(cookie.length === 0 ? {} : { cookie: cookie.join("; ") }),
    });
  }

  const nextHeaders = () => ({
    headers: () => Promise.resolve(requestHeaders()),
    cookies: () =>
      Promise.resolve({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name: string, value: string, options: Record<string, unknown>) => {
          if (options.maxAge === 0 || value === "") jar.delete(name);
          else jar.set(name, value);
        },
      }),
  });
  return { jar, requestHeaders, nextHeaders };
});
vi.mock("next/headers", () => browser.nextHeaders());
// next-intl's <Link> reads the router's pathname, which only exists inside Next.js;
// everything else in next/navigation (redirect, notFound) stays real.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/",
}));
vi.mock("next/headers.js", () => browser.nextHeaders());
// revalidatePath needs a Next.js request store; here it only has to be called.
const cache = vi.hoisted(() => ({ revalidated: [] as string[] }));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    cache.revalidated.push(path);
  },
}));

const { system } = createTestDb();
const PASSWORD = "correct horse battery";
const SESSION_COOKIE = "flexibx.session_token";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
  cache.revalidated.length = 0;
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** The digest of a Next control-flow error (redirect / notFound), or rethrows. */
async function controlFlow(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    (value) => {
      throw new Error(`expected a redirect or notFound, got ${typeof value}`);
    },
    (caught: unknown) => caught,
  );
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string") throw error;
  return digest;
}
const redirectTarget = async (promise: Promise<unknown>) => {
  const digest = await controlFlow(promise);
  expect(digest.startsWith("NEXT_REDIRECT")).toBe(true);
  return digest.split(";")[2];
};
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

let counter = 0;
/** A real account, signed in (session cookie in the jar). Returns its user id. */
async function signedInUser(name = "Reem") {
  counter += 1;
  const email = `flow-${String(counter)}-${Date.now().toString(36)}@example.com`;
  browser.jar.clear();
  await controlFlow(submitSignUp("en", null, form({ name, email, password: PASSWORD })));
  await controlFlow(submitSignIn("en", null, form({ email, password: PASSWORD })));
  expect(browser.jar.has(SESSION_COOKIE)).toBe(true);
  const user = await system.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, email, cookies: new Map(browser.jar) };
}
const actAs = (user: { cookies: Map<string, string> } | null) => {
  browser.jar.clear();
  if (user !== null) for (const [name, value] of user.cookies) browser.jar.set(name, value);
};

async function workspace(
  slug: string,
  members: { userId: string; role: WorkspaceRole }[],
  name = slug.toUpperCase(),
) {
  const ws = await system.workspace.create({ data: { name, slug } });
  for (const member of members) {
    await system.workspaceMember.create({ data: { workspaceId: ws.id, ...member } });
  }
  return ws;
}

const params = (slug: string, locale = "en") => Promise.resolve({ locale, workspaceSlug: slug });

function render(locale: "ar" | "en", node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "ar" ? ar : en,
      timeZone: "Asia/Riyadh",
      children: node,
    }),
  );
}

const tokenOf = (url: string) => url.split("/invite/")[1] ?? "";

async function ownerWithWorkspace(slug = "acme-team") {
  const owner = await signedInUser("Owner");
  const ws = await workspace(slug, [{ userId: owner.id, role: WorkspaceRole.OWNER }], "Acme");
  return { owner, ws };
}

async function inviteAs(
  actor: { cookies: Map<string, string> },
  slug: string,
  email: string,
  role = "EDITOR",
  locale = "ar",
) {
  actAs(actor);
  const state = await submitInvite(slug, locale, null, form({ email, role }));
  if (state === null || !("created" in state)) throw new Error(JSON.stringify(state));
  return state.created;
}

// ── the invitation journey ───────────────────────────────────────────────────

describe("invitation journey", () => {
  it("invite → anonymous link → sign up and sign in with next → accept, all in Arabic", async () => {
    const { owner } = await ownerWithWorkspace();
    const email = `invitee-${Date.now().toString(36)}@example.com`;
    const created = await inviteAs(owner, "acme-team", email, "MANAGER");
    expect(created.acceptUrl).toMatch(/^http:\/\/localhost:3000\/ar\/invite\/[A-Za-z0-9_-]{43}$/);
    // The test transport captures instead of sending, and the result says so.
    expect(created.delivery).toEqual({ status: "not_sent", reason: "development" });
    expect(cache.revalidated).toEqual(["/ar/w/acme-team/members"]);
    const token = tokenOf(created.acceptUrl);
    const invitePath = `/ar/invite/${token}`;
    const next = encodeURIComponent(invitePath);

    // Anonymous: the invite page sends the visitor to sign-in, returning to the link.
    actAs(null);
    const pageParams = Promise.resolve({ locale: "ar", token });
    expect(await redirectTarget(InvitePage({ params: pageParams }))).toBe(
      `/ar/sign-in?next=${next}`,
    );

    // No account yet: sign up keeps `next`, then sign-in returns to the invitation.
    expect(
      await redirectTarget(
        submitSignUp(
          "ar",
          null,
          form({ name: "Invitee", email, password: PASSWORD, next: invitePath }),
        ),
      ),
    ).toBe(`/ar/sign-in?registered=1&next=${next}`);
    expect(
      await redirectTarget(
        submitSignIn("ar", null, form({ email, password: PASSWORD, next: invitePath })),
      ),
    ).toBe(invitePath);
    expect(await previewInvitationForCurrentUser(token)).toMatchObject({
      status: "valid",
      workspaceName: "Acme",
      role: "MANAGER",
      inviterName: "Owner",
    });

    // Accept → into the workspace, same locale, with the invited role.
    expect(await redirectTarget(submitAcceptInvitation("ar", null, form({ token })))).toBe(
      "/ar/w/acme-team",
    );
    expect((await getWorkspaceShell("acme-team")).workspace.role).toBe("MANAGER");

    // The link is spent.
    const replay = await submitAcceptInvitation("ar", null, form({ token }));
    expect(replay?.error.code).toBe("NOT_FOUND");
    expect(replay?.error.fields).toEqual([{ path: "token", code: "invitation_invalid" }]);
  });

  it("a different signed-in account cannot use the link", async () => {
    const { owner } = await ownerWithWorkspace();
    const created = await inviteAs(owner, "acme-team", "someone-else@example.com");
    const stranger = await signedInUser("Stranger");
    actAs(stranger);
    const token = tokenOf(created.acceptUrl);
    expect(await previewInvitationForCurrentUser(token)).toEqual({ status: "email_mismatch" });
    const state = await submitAcceptInvitation("en", null, form({ token }));
    expect(state?.error.code).toBe("FORBIDDEN");
    await expect(getWorkspaceShell("acme-team")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("anonymous and malformed accept attempts change nothing", async () => {
    const { owner } = await ownerWithWorkspace();
    const created = await inviteAs(owner, "acme-team", "anon@example.com");
    actAs(null);
    const anonymous = await submitAcceptInvitation(
      "en",
      null,
      form({ token: tokenOf(created.acceptUrl) }),
    );
    expect(anonymous?.error.code).toBe("UNAUTHENTICATED");
    actAs(owner);
    const malformed = await submitAcceptInvitation("en", null, form({ token: "<script>" }));
    expect(malformed?.error.code).toBe("VALIDATION_FAILED");
    expect(await system.workspaceMember.count()).toBe(1);
  });
});

// ── authorization at the action boundary ────────────────────────────────────

describe("member actions authorize from the session and database only", () => {
  it("rejects anonymous, non-member and under-privileged callers", async () => {
    const { owner, ws } = await ownerWithWorkspace();
    const viewer = await signedInUser("Viewer");
    const member = await system.workspaceMember.create({
      data: { workspaceId: ws.id, userId: viewer.id, role: WorkspaceRole.VIEWER },
    });
    const outsider = await signedInUser("Outsider");
    await workspace("other-team", [{ userId: outsider.id, role: WorkspaceRole.OWNER }]);
    const input = { slug: "acme-team", memberId: member.id, role: "ADMIN" };

    actAs(null);
    expect((await changeMemberRoleAction(input)).ok).toBe(false);
    expect(await changeMemberRoleAction(input)).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
    actAs(outsider);
    expect(await changeMemberRoleAction(input)).toMatchObject({ error: { code: "NOT_FOUND" } });
    // Owning another workspace and naming this member id grants nothing.
    expect(await changeMemberRoleAction({ ...input, slug: "other-team" })).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    actAs(viewer);
    expect(await changeMemberRoleAction(input)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(
      await inviteMemberAction({
        slug: "acme-team",
        email: "x@example.com",
        role: "VIEWER",
        locale: "en",
      }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    // Smuggled authority is rejected by the strict schema.
    actAs(owner);
    expect(
      await removeMemberAction({
        slug: "acme-team",
        memberId: member.id,
        workspaceId: ws.id,
      }),
    ).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(
      await inviteMemberAction({
        slug: "acme-team",
        email: "x@example.com",
        role: "OWNER",
        locale: "en",
      }),
    ).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: member.id } })).role,
    ).toBe("VIEWER");
  });

  it("role change, removal and revocation through the forms", async () => {
    const { owner, ws } = await ownerWithWorkspace();
    const editor = await signedInUser("Editor");
    const member = await system.workspaceMember.create({
      data: { workspaceId: ws.id, userId: editor.id, role: WorkspaceRole.EDITOR },
    });
    actAs(owner);
    // A slug that is not one of the caller's workspaces is NOT_FOUND, whatever the member id.
    expect(
      await submitChangeRole(
        "no-such-team",
        "en",
        null,
        form({ memberId: member.id, role: "VIEWER" }),
      ),
    ).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: member.id } })).role,
    ).toBe("EDITOR");
    expect(
      await submitChangeRole(
        "acme-team",
        "en",
        null,
        form({ memberId: member.id, role: "VIEWER" }),
      ),
    ).toEqual({ done: true });
    expect(
      (await system.workspaceMember.findUniqueOrThrow({ where: { id: member.id } })).role,
    ).toBe("VIEWER");

    const created = await inviteAs(owner, "acme-team", "pending@example.com", "VIEWER", "en");
    const [pending] = (await getMembersPage("acme-team")).invitations;
    expect(pending?.email).toBe("pending@example.com");
    expect(
      await submitRevokeInvitation(
        "acme-team",
        "en",
        null,
        form({ invitationId: pending?.id ?? "" }),
      ),
    ).toEqual({ done: true });
    expect((await getMembersPage("acme-team")).invitations).toEqual([]);
    expect(created.acceptUrl).toContain("/en/invite/");

    expect(
      await submitRemoveMember("acme-team", "en", null, form({ memberId: member.id })),
    ).toEqual({ done: true });
    actAs(editor);
    await expect(getWorkspaceShell("acme-team")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ── members page data, leaving, pages ───────────────────────────────────────

describe("members page", () => {
  it("gives each role only the controls it may use", async () => {
    const { owner, ws } = await ownerWithWorkspace();
    const admin = await signedInUser("Admin");
    const viewer = await signedInUser("Viewer");
    const client = await signedInUser("Client");
    for (const [u, role] of [
      [admin, WorkspaceRole.ADMIN],
      [viewer, WorkspaceRole.VIEWER],
      [client, WorkspaceRole.CLIENT],
    ] as const) {
      await system.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role } });
    }
    await inviteAs(owner, "acme-team", "pending@example.com");

    actAs(admin);
    const asAdmin = await getMembersPage("acme-team");
    expect(asAdmin.canInvite).toBe(true);
    expect(asAdmin.grantableRoles).toEqual(["ADMIN", "MANAGER", "EDITOR", "VIEWER"]);
    expect(asAdmin.invitations).toHaveLength(1);
    const byName = Object.fromEntries(asAdmin.members.map((m) => [m.name, m]));
    expect(byName.Owner).toMatchObject({ canChangeRole: false, canRemove: false });
    expect(byName.Admin).toMatchObject({ isSelf: true, canChangeRole: false, canRemove: false });
    expect(byName.Viewer).toMatchObject({ canChangeRole: true, canRemove: true });
    expect(asAdmin.isLastOwner).toBe(false);

    actAs(viewer);
    const asViewer = await getMembersPage("acme-team");
    expect(asViewer).toMatchObject({ canInvite: false, grantableRoles: [], invitations: [] });
    expect(asViewer.members.every((m) => !m.canChangeRole && !m.canRemove)).toBe(true);

    actAs(client);
    await expect(getMembersPage("acme-team")).rejects.toMatchObject({ code: "FORBIDDEN" });

    actAs(owner);
    expect((await getMembersPage("acme-team")).isLastOwner).toBe(true);
  });

  it("is gated like every workspace page: anonymous → sign-in, foreign → 404", async () => {
    await ownerWithWorkspace();
    actAs(null);
    expect(await redirectTarget(MembersRoute({ params: params("acme-team", "ar") }))).toBe(
      "/ar/sign-in?next=%2Far%2Fw%2Facme-team",
    );
    const outsider = await signedInUser("Outsider");
    actAs(outsider);
    expect(await controlFlow(MembersRoute({ params: params("acme-team") }))).toBe(NOT_FOUND);
  });

  it("leaving sends the user to their workspaces; the last owner is refused", async () => {
    const { owner, ws } = await ownerWithWorkspace();
    const editor = await signedInUser("Editor");
    await system.workspaceMember.create({
      data: { workspaceId: ws.id, userId: editor.id, role: WorkspaceRole.EDITOR },
    });

    actAs(owner);
    const refused = await submitLeaveWorkspace("acme-team", "ar", null);
    expect(refused).toMatchObject({
      error: { code: "CONFLICT", fields: [{ path: "member", code: "last_owner" }] },
    });

    actAs(editor);
    expect(await redirectTarget(submitLeaveWorkspace("acme-team", "ar", null))).toBe(
      "/ar/workspaces",
    );
    await expect(getWorkspaceShell("acme-team")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("renders the invite form in Arabic and the honest delivery notice", () => {
    const html = render(
      "ar",
      createElement(InviteForm, {
        slug: "acme-team",
        roles: [{ value: "VIEWER", label: ar.workspaces.roles.VIEWER }],
      }),
    );
    expect(html).toContain(ar.members.invite.email);
    expect(html).toContain(ar.members.invite.submit);
    expect(html).toMatch(/<input[^>]*id="invite-email"[^>]*dir="ltr"/);
    expect(html).not.toContain(en.members.invite.submit);
    // No message anywhere claims an email was sent unless a provider accepted it.
    for (const key of ["notSentDevelopment", "notSentNotConfigured", "notSentFailed"] as const) {
      expect(en.members.invite[key]).toMatch(/^No email was sent/);
    }
  });
});

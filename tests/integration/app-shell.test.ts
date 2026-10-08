// Phase 2, step 6: the workspace app shell and switching, on the real database with
// real Better Auth sessions. `next/headers` is replaced by a request double whose
// headers carry the "browser" cookies; cookies().set() records what nextCookies()
// writes so the session survives across calls.
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { NextRequest } from "next/server";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignOut, submitSignUp } from "@/app/[locale]/(auth)/actions";
import WorkspaceLayout from "@/app/[locale]/w/[workspaceSlug]/layout";
import { loadWorkspace } from "@/app/[locale]/w/[workspaceSlug]/load-workspace";
import WorkspacePage from "@/app/[locale]/w/[workspaceSlug]/page";
import WorkspacesPage from "@/app/[locale]/workspaces/page";
import { AppShell } from "@/components/shell/app-shell";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { getSystemDb } from "@/server/db/client";
import { LAST_WORKSPACE_COOKIE } from "@/server/workspaces/last-workspace";
import { getMyWorkspaceLanding, getWorkspaceShell } from "@/server/workspaces/workspace-queries";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["app", "shell", "test", "only", "secret", "0123456789abcdef"].join(
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

const { system } = createTestDb();
const PASSWORD = "correct horse battery";
const SESSION_COOKIE = "flexibx.session_token";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
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
  const email = `shell-${String(counter)}-${Date.now().toString(36)}@example.com`;
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

// ── shell data and access ────────────────────────────────────────────────────

describe("workspace shell data", () => {
  it("lists only the signed-in user's own non-deleted memberships, with the stored role", async () => {
    const other = await signedInUser("Other");
    const me = await signedInUser("Me");
    await workspace("alpha-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await workspace("beta-team", [
      { userId: me.id, role: WorkspaceRole.EDITOR },
      { userId: other.id, role: WorkspaceRole.OWNER },
    ]);
    await workspace("foreign-team", [{ userId: other.id, role: WorkspaceRole.OWNER }]);
    const gone = await workspace("gone-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await system.workspace.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    actAs(me);
    const shell = await getWorkspaceShell("beta-team");
    expect(shell.workspace).toEqual({ name: "BETA-TEAM", slug: "beta-team", role: "EDITOR" });
    expect(shell.user).toEqual({ name: "Me", email: me.email });
    expect(shell.workspaces.map((w) => w.slug)).toEqual(["alpha-team", "beta-team"]);
  });

  it("works for a user with a single workspace", async () => {
    const me = await signedInUser();
    await workspace("solo-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    actAs(me);
    const shell = await loadWorkspace("ar", "solo-team");
    expect(shell.workspaces).toEqual([{ name: "SOLO-TEAM", slug: "solo-team", role: "OWNER" }]);
  });

  it("switching between two workspaces re-authorizes each one", async () => {
    const me = await signedInUser();
    await workspace("alpha-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await workspace("beta-team", [{ userId: me.id, role: WorkspaceRole.VIEWER }]);
    actAs(me);
    expect((await getWorkspaceShell("alpha-team")).workspace.role).toBe("OWNER");
    expect((await getWorkspaceShell("beta-team")).workspace.role).toBe("VIEWER");
  });

  it("foreign, unknown, deleted and malformed workspaces are the same 404 for layout and page", async () => {
    const other = await signedInUser("Other");
    const me = await signedInUser("Me");
    await workspace("foreign-team", [{ userId: other.id, role: WorkspaceRole.OWNER }]);
    const gone = await workspace("gone-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await system.workspace.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    actAs(me);
    for (const slug of ["foreign-team", "no-such-team", "gone-team", "Bad_Slug", "../admin"]) {
      expect(await controlFlow(loadWorkspace("en", slug))).toBe(NOT_FOUND);
      expect(await controlFlow(WorkspaceLayout({ children: null, params: params(slug) }))).toBe(
        NOT_FOUND,
      );
      expect(await controlFlow(WorkspacePage({ params: params(slug) }))).toBe(NOT_FOUND);
    }
  });

  it("anonymous visitors are sent to sign-in with a safe return path", async () => {
    const owner = await signedInUser();
    await workspace("acme-team", [{ userId: owner.id, role: WorkspaceRole.OWNER }]);
    actAs(null);
    expect(
      await redirectTarget(WorkspaceLayout({ children: null, params: params("acme-team", "ar") })),
    ).toBe("/ar/sign-in?next=%2Far%2Fw%2Facme-team");
    expect(await redirectTarget(WorkspacePage({ params: params("acme-team") }))).toBe(
      "/en/sign-in?next=%2Fen%2Fw%2Facme-team",
    );
  });

  it("after sign-out the workspace is no longer reachable", async () => {
    const me = await signedInUser();
    await workspace("acme-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    actAs(me);
    expect((await getWorkspaceShell("acme-team")).workspace.slug).toBe("acme-team");

    expect(await redirectTarget(submitSignOut("en"))).toBe("/en/sign-in");
    expect(await redirectTarget(WorkspacePage({ params: params("acme-team") }))).toBe(
      "/en/sign-in?next=%2Fen%2Fw%2Facme-team",
    );
    // Replaying the old session cookie does not help either.
    actAs(me);
    expect(await redirectTarget(WorkspacePage({ params: params("acme-team") }))).toBe(
      "/en/sign-in?next=%2Fen%2Fw%2Facme-team",
    );
  });

  it("a removed membership closes the workspace immediately", async () => {
    const me = await signedInUser();
    const ws = await workspace("acme-team", [{ userId: me.id, role: WorkspaceRole.EDITOR }]);
    actAs(me);
    expect((await getWorkspaceShell("acme-team")).workspace.role).toBe("EDITOR");
    await system.workspaceMember.deleteMany({ where: { workspaceId: ws.id } });
    expect(await controlFlow(loadWorkspace("en", "acme-team"))).toBe(NOT_FOUND);
  });
});

// ── last-workspace cookie ────────────────────────────────────────────────────

describe("last-workspace cookie", () => {
  it("is used by /workspaces only when it names one of the user's memberships", async () => {
    const other = await signedInUser("Other");
    const me = await signedInUser("Me");
    await workspace("alpha-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await workspace("beta-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await workspace("foreign-team", [{ userId: other.id, role: WorkspaceRole.OWNER }]);
    const gone = await workspace("gone-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await system.workspace.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const landingWith = async (value: string | null, showList = false) => {
      actAs(me);
      if (value !== null) browser.jar.set(LAST_WORKSPACE_COOKIE, value);
      return getMyWorkspaceLanding({ showList });
    };

    expect(await landingWith("beta-team")).toEqual({ kind: "open", slug: "beta-team" });
    expect(await landingWith("BETA-TEAM")).toEqual({ kind: "open", slug: "beta-team" });
    for (const ignored of [null, "foreign-team", "gone-team", "no-such-team", "x;y", "../admin"]) {
      expect((await landingWith(ignored)).kind).toBe("choose");
    }
    expect((await landingWith("beta-team", true)).kind).toBe("choose");
  });

  it("drives the /workspaces redirect, and ?list=1 shows the list", async () => {
    const me = await signedInUser();
    await workspace("alpha-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    await workspace("beta-team", [{ userId: me.id, role: WorkspaceRole.OWNER }]);
    actAs(me);
    browser.jar.set(LAST_WORKSPACE_COOKIE, "beta-team");
    const page = (search: Record<string, string>) =>
      WorkspacesPage({
        params: Promise.resolve({ locale: "ar" }),
        searchParams: Promise.resolve(search),
      });
    expect(await redirectTarget(page({}))).toBe("/ar/w/beta-team");
    // With ?list=1 the page renders the list instead of redirecting. (Rendering stops at
    // getTranslations, which needs a real Next.js request; it must not be a redirect.)
    const listed = await page({ list: "1" }).then(
      () => "rendered",
      (error: unknown) => (error as { digest?: string }).digest ?? "rendered",
    );
    expect(listed).not.toMatch(/^NEXT_REDIRECT/);
  });

  it("is written by the proxy for workspace pages of signed-in browsers only", async () => {
    const { default: proxy } = await import("@/proxy");
    const me = await signedInUser();
    const session = [...me.cookies]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
    const lastWorkspace = async (path: string, cookie?: string) => {
      const response = await proxy(
        new NextRequest(`http://localhost:3000${path}`, {
          headers: cookie === undefined ? {} : { cookie },
        }),
      );
      return response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${LAST_WORKSPACE_COOKIE}=`));
    };

    expect(await lastWorkspace("/ar/w/acme-team", session)).toBe(
      `${LAST_WORKSPACE_COOKIE}=acme-team; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax`,
    );
    expect(await lastWorkspace("/ar/w/acme-team")).toBeUndefined();
    expect(await lastWorkspace("/ar/w/Bad_Slug", session)).toBeUndefined();
    expect(await lastWorkspace("/ar/workspaces", session)).toBeUndefined();
    expect(
      await lastWorkspace("/ar/w/acme-team", `${session}; ${LAST_WORKSPACE_COOKIE}=acme-team`),
    ).toBeUndefined();
  });
});

// ── rendered shell ───────────────────────────────────────────────────────────

describe("rendered shell", () => {
  async function shellHtml(locale: "ar" | "en", role: WorkspaceRole = WorkspaceRole.EDITOR) {
    const other = await signedInUser("Other");
    const me = await signedInUser("Reem Saleh");
    await workspace("alpha-team", [{ userId: me.id, role: WorkspaceRole.OWNER }], "Alpha");
    await workspace("beta-team", [{ userId: me.id, role }], "Beta");
    await workspace("foreign-team", [{ userId: other.id, role: WorkspaceRole.OWNER }], "Foreign");
    actAs(me);
    const shell = await getWorkspaceShell("beta-team");
    return {
      email: me.email,
      html: render(
        locale,
        createElement(AppShell, {
          workspace: shell.workspace,
          workspaces: shell.workspaces,
          user: shell.user,
          nav: shell.nav,
          signOut: createElement("button", { "data-testid": "sign-out" }, "sign-out-slot"),
          children: createElement("p", null, "page body"),
        }),
      ),
    };
  }

  it("shows the current workspace, the user's own workspaces only, and the user menu", async () => {
    const { html, email } = await shellHtml("en");
    expect(html).toContain('data-testid="current-workspace">Beta<');
    expect(html).toMatch(/<a data-testid="switch-to-alpha-team"[^>]*href="\/en\/w\/alpha-team"/);
    expect(html).toMatch(
      /<a aria-current="page" data-testid="switch-to-beta-team"[^>]*href="\/en\/w\/beta-team"/,
    );
    expect(html).not.toContain("foreign-team");
    expect(html).not.toContain("Foreign");
    expect(html).toContain('href="/en/workspaces?list=1"');
    expect(html).toContain("Reem Saleh");
    expect(html).toContain(email);
    expect(html).toContain("Role in this workspace: Editor");
    expect(html).toContain("sign-out-slot");
    expect(html).toContain("page body");
  });

  it("keeps the Arabic locale in every link and shows no English labels", async () => {
    const { html } = await shellHtml("ar");
    expect(html).toContain('href="/ar/w/alpha-team"');
    expect(html).toMatch(
      /<a aria-current="page" data-testid="switch-to-beta-team"[^>]*href="\/ar\/w\/beta-team"/,
    );
    expect(html).toContain('href="/ar/workspaces?list=1"');
    expect(html).not.toMatch(/href="\/en\/w\//);
    for (const label of Object.values(ar.shell).flatMap((group) => Object.values(group))) {
      if (!label.includes("{")) expect(html).toContain(label);
    }
    for (const english of [
      "Switch workspace",
      "All workspaces",
      "Account menu",
      "Home",
      "Editor",
    ]) {
      expect(html).not.toContain(english);
    }
  });

  it("the navigation lists only pages that exist and the role may open", async () => {
    const navOf = (html: string) =>
      /<nav aria-label="Workspace navigation"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    const editor = navOf((await shellHtml("en")).html);
    expect(editor.match(/<a /g)).toHaveLength(2);
    expect(editor).toContain('href="/en/w/beta-team"');
    expect(editor).toMatch(/data-testid="nav-members"[^>]*href="\/en\/w\/beta-team\/members"/);

    // CLIENT has no member.view: no Members entry.
    await resetDatabase(system);
    const client = navOf((await shellHtml("en", WorkspaceRole.CLIENT)).html);
    expect(client.match(/<a /g)).toHaveLength(1);
    expect(client).not.toContain("/members");
  });
});

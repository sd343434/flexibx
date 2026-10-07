import { describe, expect, it } from "vitest";

import { decideWorkspaceLanding, type WorkspaceSummary } from "@/server/workspaces/landing";
import {
  LAST_WORKSPACE_COOKIE,
  lastWorkspaceSetCookie,
  parseWorkspaceSlug,
  workspaceSlugFromPath,
} from "@/server/workspaces/last-workspace";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const ws = (slug: string): WorkspaceSummary => ({ name: slug, slug, role: "OWNER" });

describe("last-workspace cookie helpers", () => {
  it.each([
    ["/ar/w/acme-team", "acme-team"],
    ["/en/w/acme-team/settings", "acme-team"],
    ["/en/w/ACME-Team", "acme-team"],
    ["/en/w/acme%2Dteam", "acme-team"],
    ["/ar/w/", undefined],
    ["/ar/w/x", undefined],
    ["/ar/w/bad_slug", undefined],
    ["/ar/w/..%2Fadmin", undefined],
    ["/ar/w/%E0%A4%A", undefined],
    ["/fr/w/acme-team", undefined],
    ["/ar/workspaces", undefined],
    ["/ar/sign-in", undefined],
  ])("path %s → %s", (path, slug) => {
    expect(workspaceSlugFromPath(path)).toBe(slug);
  });

  it("only well-formed slugs are ever read back from the cookie", () => {
    expect(parseWorkspaceSlug("acme-team")).toBe("acme-team");
    expect(parseWorkspaceSlug(undefined)).toBeUndefined();
    expect(parseWorkspaceSlug("a;b")).toBeUndefined();
    expect(parseWorkspaceSlug("<script>")).toBeUndefined();
  });

  it("sets a non-sensitive, HttpOnly, SameSite=Lax cookie (Secure on https)", () => {
    const plain = lastWorkspaceSetCookie("acme-team", false);
    expect(plain).toBe(
      `${LAST_WORKSPACE_COOKIE}=acme-team; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax`,
    );
    expect(lastWorkspaceSetCookie("acme-team", true)).toMatch(/; Secure$/);
  });
});

describe("decideWorkspaceLanding with the last workspace", () => {
  const two = [ws("alpha"), ws("beta")];

  it("opens the last workspace only when it is one of the user's own", () => {
    expect(decideWorkspaceLanding(two, { lastSlug: "beta" })).toEqual({
      kind: "open",
      slug: "beta",
    });
    expect(decideWorkspaceLanding(two, { lastSlug: "foreign" })).toEqual({
      kind: "choose",
      workspaces: two,
    });
    expect(decideWorkspaceLanding([ws("alpha")], { lastSlug: "foreign" })).toEqual({
      kind: "open",
      slug: "alpha",
    });
    expect(decideWorkspaceLanding([], { lastSlug: "foreign" })).toEqual({ kind: "create" });
  });

  it("shows the list on request, even with a valid last workspace or a single one", () => {
    expect(decideWorkspaceLanding(two, { lastSlug: "beta", showList: true })).toEqual({
      kind: "choose",
      workspaces: two,
    });
    expect(decideWorkspaceLanding([ws("alpha")], { showList: true }).kind).toBe("choose");
  });
});

describe("shell messages", () => {
  it("exist in both locales and are actually translated", () => {
    expect(Object.keys(ar.shell)).toEqual(Object.keys(en.shell));
    expect(ar.shell.switcher.label).not.toBe(en.shell.switcher.label);
    expect(ar.shell.nav.home).not.toBe(en.shell.nav.home);
    expect(ar.shell.userMenu.label).not.toBe(en.shell.userMenu.label);
    expect(ar.auth.signOut.submit).not.toBe(en.auth.signOut.submit);
  });
});

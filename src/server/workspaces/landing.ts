import type { Role } from "../tenancy/roles";

// Where `/{locale}/workspaces` sends a signed-in user. Pure: the memberships come from
// the reviewed system path (`listMyWorkspaces` in src/server/tenancy/access.ts); the
// last-workspace cookie is only ever matched against them.

/** One of the current user's own workspaces, as shown in the workspace list. */
export interface WorkspaceSummary {
  readonly name: string;
  readonly slug: string;
  readonly role: Role;
}

export type WorkspaceLanding =
  | { readonly kind: "create" }
  | { readonly kind: "open"; readonly slug: string }
  | { readonly kind: "choose"; readonly workspaces: readonly WorkspaceSummary[] };

export interface LandingOptions {
  /** Last-workspace cookie value; used only if it is one of `workspaces`. */
  readonly lastSlug?: string | undefined;
  /** Show the list even when a default could be picked (the switcher's "all" link). */
  readonly showList?: boolean;
}

/**
 * No workspace → create one. Otherwise: the explicit list when asked for; the last
 * workspace when it is still one of the user's own; the only workspace; or the list.
 */
export function decideWorkspaceLanding(
  workspaces: readonly WorkspaceSummary[],
  options: LandingOptions = {},
): WorkspaceLanding {
  const [only] = workspaces;
  if (only === undefined) return { kind: "create" };
  if (options.showList === true) return { kind: "choose", workspaces };
  const last = workspaces.find((workspace) => workspace.slug === options.lastSlug);
  if (last !== undefined) return { kind: "open", slug: last.slug };
  if (workspaces.length === 1) return { kind: "open", slug: only.slug };
  return { kind: "choose", workspaces };
}

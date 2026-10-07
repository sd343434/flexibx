import type { Role } from "../tenancy/roles";

// Where `/{locale}/workspaces` sends a signed-in user. Pure: the memberships come from
// the reviewed system path (`listMyWorkspaces` in src/server/tenancy/access.ts).

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

/** No workspace → create one; exactly one → open it; several → let the user choose. */
export function decideWorkspaceLanding(workspaces: readonly WorkspaceSummary[]): WorkspaceLanding {
  const [only] = workspaces;
  if (only === undefined) return { kind: "create" };
  if (workspaces.length === 1) return { kind: "open", slug: only.slug };
  return { kind: "choose", workspaces };
}

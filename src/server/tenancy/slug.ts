// Workspace slug rules. Pure module: shared by workspace access, workspace creation and
// their input schemas.

/** Same rule as the `workspaces.slug` CHECK constraint (Phase 1 migration). */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;

/** Slugs are compared case-insensitively (`citext`); the canonical form is lowercase. */
export function normalizeWorkspaceSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

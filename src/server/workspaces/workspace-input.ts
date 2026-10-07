import { z } from "zod";

import { LOCALES } from "@/i18n/config";

import { normalizeWorkspaceSlug, WORKSPACE_SLUG_PATTERN } from "../tenancy/slug";

export const WORKSPACE_NAME_MAX_LENGTH = 120;

/**
 * Input for creating a workspace. Strict: unknown keys are rejected, so a client cannot
 * smuggle in a workspace type, owner, user id or role. The server decides those (type
 * BUSINESS, the session user as OWNER).
 */
export const createWorkspaceInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
  // Normalized first, then checked against the same rule as the DB CHECK constraint.
  slug: z.string().transform(normalizeWorkspaceSlug).pipe(z.string().regex(WORKSPACE_SLUG_PATTERN)),
  defaultLocale: z.enum(LOCALES),
});

export type CreateWorkspaceInput = z.input<typeof createWorkspaceInputSchema>;

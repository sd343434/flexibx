import "server-only";

import { requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { withAction } from "../http/action-handler";
import { createWorkspace } from "../tenancy/workspace-creation";

import { createWorkspaceInputSchema } from "./workspace-input";

/**
 * Creates a workspace for the signed-in user. The creator comes from the session only
 * (`requireUser`); the input carries user content (name, slug, default locale) and
 * nothing else — the strict schema rejects any other key.
 */
export const createWorkspaceAction = withAction({
  name: "workspace.create",
  input: createWorkspaceInputSchema,
  handler: async (input) => {
    const user = await requireUser();
    return createWorkspace(getDb(), user, input);
  },
});

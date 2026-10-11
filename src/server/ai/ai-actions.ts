import "server-only";

import { headers } from "next/headers";

import { getRateLimiter } from "../auth/auth";
import { getDb } from "../db/client";
import { getAiEnv } from "../env";
import { withAction } from "../http/action-handler";
import { requireWorkspaceAccess } from "../tenancy/access";
import type { TenantContext } from "../tenancy/context";

import {
  aiNotConfigured,
  applyGeneration,
  assistContent,
  generateBrief,
  generateCopy,
  generateIdeas,
  type AiRuntime,
} from "./ai-service";
import { createFakeProvider } from "./fake-provider";
import {
  applyGenerationInputSchema,
  assistContentInputSchema,
  generateBriefInputSchema,
  generateCopyInputSchema,
  generateIdeasInputSchema,
} from "./inputs";

// Server actions for the AI Marketing Engine. Order for a generation: strict input →
// session + membership + permission (`requireWorkspaceAccess`) → "is AI configured?" →
// the user and workspace rate limits (Better Auth limiter checkpoint) → the service,
// which re-checks the permission, reserves a slot under the daily cap and calls the
// provider. Using a suggestion is not rate-limited (it calls no provider) but repeats
// every authorization and ownership check on the server.

/** The configured provider (none when AI_PROVIDER=disabled) and its timeout. */
export function getAiRuntime(): AiRuntime {
  const env = getAiEnv();
  return {
    provider: env.AI_PROVIDER === "fake" ? createFakeProvider() : null,
    timeoutMs: env.AI_TIMEOUT_MS,
  };
}

async function admitGeneration(ctx: TenantContext): Promise<AiRuntime> {
  const runtime = getAiRuntime();
  if (runtime.provider === null) throw aiNotConfigured();
  const limit = getRateLimiter();
  const requestHeaders = new Headers(await headers());
  await limit({ bucket: "ai-generate", requestHeaders, subject: ctx.userId });
  await limit({ bucket: "ai-generate-workspace", requestHeaders, subject: ctx.workspaceId });
  return runtime;
}

export const generateIdeasAction = withAction({
  name: "ai.ideas",
  input: generateIdeasInputSchema,
  handler: async ({ slug, uiLocale, ...input }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    const runtime = await admitGeneration(ctx);
    return generateIdeas(getDb(), ctx, runtime, input, uiLocale);
  },
});

export const generateBriefAction = withAction({
  name: "ai.brief",
  input: generateBriefInputSchema,
  handler: async ({ slug, uiLocale, ...input }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    const runtime = await admitGeneration(ctx);
    return generateBrief(getDb(), ctx, runtime, input, uiLocale);
  },
});

export const generateCopyAction = withAction({
  name: "ai.copy",
  input: generateCopyInputSchema,
  handler: async ({ slug, uiLocale, ...input }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    const runtime = await admitGeneration(ctx);
    return generateCopy(getDb(), ctx, runtime, input, uiLocale);
  },
});

export const assistContentAction = withAction({
  name: "ai.assist",
  input: assistContentInputSchema,
  handler: async ({ slug, uiLocale, ...input }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.edit");
    const runtime = await admitGeneration(ctx);
    return assistContent(getDb(), ctx, runtime, input, uiLocale);
  },
});

export const applyGenerationAction = withAction({
  name: "ai.apply",
  input: applyGenerationInputSchema,
  handler: async ({ slug, generationId, choice }) => {
    // The service decides content.create vs content.edit from the stored operation.
    const ctx = await requireWorkspaceAccess(slug, "content.view");
    return applyGeneration(getDb(), ctx, { generationId, choice });
  },
});

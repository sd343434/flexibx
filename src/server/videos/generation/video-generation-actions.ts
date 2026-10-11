import "server-only";

import { after } from "next/server";

import { getDb } from "../../db/client";
import { withAction } from "../../http/action-handler";
import { logger } from "../../logger";
import { requireWorkspaceAccess } from "../../tenancy/access";
import { AppError } from "../../errors/app-error";
import { zodIssuesToFieldErrors } from "../../validation/field-errors";

import {
  reviewVideoInputSchema,
  requestVideoInputSchema,
  videoJobInputSchema,
} from "./video-inputs";
import { composeVideoPrompt, videoBriefSchema } from "./video-brief";
import {
  regenerateVideoJob,
  requestVideoGeneration,
  videoRequestSchema,
  reviewVideoJob,
  runVideoJob,
  type VideoGenerationDeps,
} from "./video-generation-service";
import { getVideoGenerationDeps } from "./runtime";

// Server actions for video generation. Order: strict input (unknown fields refused) →
// session + membership + permission (`requireWorkspaceAccess`; the workspace comes from
// the member's own membership, never from the input) → "is a video provider configured?"
// (VIDEO_PROVIDER, disabled by default) → the service, which re-checks the permission,
// validates the request and reserves its cost under the server's limits.
//
// Not rate-limited by the shared limiter: no video bucket has been approved yet (the
// limiter table is a human decision). Spend is bounded by the reservation instead.

/** Runs a job's first bounded run after the response is sent (in this process). */
function scheduleRun(deps: VideoGenerationDeps, workspaceId: string, jobId: string) {
  after(async () => {
    try {
      await runVideoJob(deps, workspaceId, jobId);
    } catch (error) {
      logger.error({ err: error, jobId }, "Video job run failed");
    }
  });
}

export const requestVideoAction = withAction({
  name: "video.request",
  input: requestVideoInputSchema,
  handler: async ({
    slug,
    objective,
    audience,
    description,
    platform,
    style,
    language,
    ...rest
  }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    const deps = getVideoGenerationDeps();
    // The brief and the settings are checked together, so every field error comes back
    // at once; the brief is then compiled into the prompt and the service validates the
    // whole request again.
    const briefInput = { objective, audience, description, platform, style, language };
    const settings = { ...rest, prompt: "-" };
    const brief = videoBriefSchema.safeParse(briefInput);
    const checked = videoRequestSchema.safeParse(settings);
    if (!brief.success || !checked.success) {
      throw new AppError("VALIDATION_FAILED", {
        message: "Invalid video request",
        fields: [
          ...(checked.success ? [] : zodIssuesToFieldErrors(checked.error.issues, settings)),
          ...(brief.success ? [] : zodIssuesToFieldErrors(brief.error.issues, briefInput)),
        ],
      });
    }
    const { jobId } = await requestVideoGeneration(deps, ctx, {
      ...rest,
      prompt: composeVideoPrompt(brief.data),
    });
    scheduleRun(deps, ctx.workspaceId, jobId);
    return { jobId };
  },
});

/** "Generate again" with the same brief and settings: a new job with its own reservation. */
export const regenerateVideoAction = withAction({
  name: "video.regenerate",
  input: videoJobInputSchema,
  handler: async ({ slug, jobId }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    const deps = getVideoGenerationDeps();
    const created = await regenerateVideoJob(deps, ctx, jobId);
    scheduleRun(deps, ctx.workspaceId, created.jobId);
    return { jobId: created.jobId };
  },
});

/**
 * "Check status": one more bounded run of a job that is still in progress (resumes after
 * a restart or a run that ended while the provider was working). Never resubmits.
 */
export const refreshVideoJobAction = withAction({
  name: "video.refresh",
  input: videoJobInputSchema,
  handler: async ({ slug, jobId }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    const outcome = await runVideoJob(getVideoGenerationDeps(), ctx.workspaceId, jobId);
    return { status: outcome.status };
  },
});

export const reviewVideoAction = withAction({
  name: "video.review",
  input: reviewVideoInputSchema,
  handler: async ({ slug, jobId, decision }) => {
    const ctx = await requireWorkspaceAccess(slug, "content.create");
    await reviewVideoJob(getDb(), ctx, jobId, decision);
    return { jobId };
  },
});

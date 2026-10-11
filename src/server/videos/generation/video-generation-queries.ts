import "server-only";

import { FAKE_VIDEO_DURATIONS, FAKE_VIDEO_PROVIDER_NAME } from "@/server/ai/providers/video/fake";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  VIDEO_TIERS,
} from "@/server/ai/providers/video/gateway";

import { getDb } from "../../db/client";
import { getVideoEnv } from "../../env";
import { resolveTimeZone } from "../../marketing/time";
import { requireWorkspaceAccess } from "../../tenancy/access";
import { databaseNow } from "../video-service";

import { VIDEO_LANGUAGES, VIDEO_PLATFORMS, VIDEO_STYLES, PLATFORM_ASPECT } from "./video-brief";
import { getVideoJob, listVideoJobs } from "./video-generation-service";

// Page data for video generation. The workspace and role come from the session's
// membership; requesting needs content.create (the page shows the "not for your role"
// state otherwise). Money is deliberately not part of the page: the budget policy is
// undecided and the only provider is the fake one with placeholder prices.

/** True when a video provider is configured (VIDEO_PROVIDER=fake today; default disabled). */
export function isVideoGenerationConfigured(): boolean {
  return getVideoEnv().VIDEO_PROVIDER !== "disabled";
}

/** Output of the local test provider is a technical placeholder, never a real video. */
const isPlaceholder = (provider: string) => provider === FAKE_VIDEO_PROVIDER_NAME;

/**
 * The Video Studio. Without `jobId` the newest request is shown in the preview (an
 * unknown or foreign `jobId` is NOT_FOUND).
 */
export async function getVideoGeneratePage(slug: string, jobId: string | undefined) {
  const ctx = await requireWorkspaceAccess(slug, "content.create");
  const db = getDb();
  const configured = isVideoGenerationConfigured();
  const [jobs, workspace, now] = await Promise.all([
    listVideoJobs(db, ctx),
    db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
    databaseNow(db),
  ]);
  const selectedId = jobId ?? jobs[0]?.id;
  const job = selectedId === undefined ? null : await getVideoJob(db, ctx, selectedId);
  const selected = job === null ? null : { ...job, placeholder: isPlaceholder(job.provider) };
  // The finished clip: downloadable only while it is still available (retention).
  const videoId = selected?.generatedVideoId ?? null;
  const result =
    videoId === null
      ? null
      : await db.generatedVideo.findFirst({
          where: { id: videoId, workspaceId: ctx.workspaceId },
          select: { id: true, status: true, expiresAt: true },
        });
  return {
    configured,
    jobs: jobs.map((row) => ({ ...row, placeholder: isPlaceholder(row.provider) })),
    selected,
    result:
      result === null
        ? null
        : {
            videoId: result.id,
            expiresAt: result.expiresAt,
            downloadable: result.status === "AVAILABLE" && result.expiresAt > now,
          },
    options: {
      // The fake provider's durations: the only provider that exists.
      durations: configured ? [...FAKE_VIDEO_DURATIONS] : [],
      aspectRatios: [...VIDEO_ASPECT_RATIOS],
      resolutions: [...VIDEO_RESOLUTIONS],
      tiers: [...VIDEO_TIERS],
      platforms: [...VIDEO_PLATFORMS],
      styles: [...VIDEO_STYLES],
      languages: [...VIDEO_LANGUAGES],
      platformAspect: PLATFORM_ASPECT,
    },
    timeZone: resolveTimeZone(workspace?.timezone),
    now,
  };
}

export type VideoGeneratePage = Awaited<ReturnType<typeof getVideoGeneratePage>>;

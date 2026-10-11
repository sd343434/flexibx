import "server-only";

import { getDb } from "../db/client";
import { resolveTimeZone } from "../marketing/time";
import { getStorageRouter } from "../storage/providers";
import { requireWorkspaceAccess } from "../tenancy/access";
import { can } from "../tenancy/permissions";

import {
  countVideosExpiringWithin,
  databaseNow,
  listGeneratedVideos,
  readGeneratedVideoFile,
  type DownloadableKind,
} from "./video-service";

// Page and route data for generated videos. The workspace comes from the session's
// membership; services check content.view. `now` is the database clock, the same one the
// expiry and the download check use, so the page never offers a download the route refuses.

/** The videos page: list, the workspace time zone for display, and the server time. */
export async function getVideosPage(slug: string) {
  const ctx = await requireWorkspaceAccess(slug);
  const db = getDb();
  const [videos, workspace, now] = await Promise.all([
    listGeneratedVideos(db, ctx),
    db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
    databaseNow(db),
  ]);
  return {
    videos,
    timeZone: resolveTimeZone(workspace?.timezone),
    now,
    // Only a hint for the "Generate a video" link; the generation page re-checks.
    canGenerate: can(ctx.role, "content.create"),
  };
}

/**
 * The in-app expiry warning for AI Studio: how many available videos are deleted within
 * 48 hours. Null when the member cannot view content (the banner is not shown).
 */
export async function getVideoExpiryBanner(slug: string) {
  const ctx = await requireWorkspaceAccess(slug);
  if (!can(ctx.role, "content.view")) return null;
  const db = getDb();
  const now = await databaseNow(db);
  return { expiringSoon: await countVideosExpiringWithin(db, ctx, 48, now) };
}

/** GET /api/w/{slug}/videos/{videoId}: the file while it is still available. */
export async function getVideoFile(slug: string, videoId: string, kind: DownloadableKind) {
  const ctx = await requireWorkspaceAccess(slug, "content.view");
  return readGeneratedVideoFile(getDb(), getStorageRouter(), ctx, videoId, kind);
}

import "server-only";

import { parseStorageDriver } from "../env-schema";
import { AppError } from "../errors/app-error";
import { requireWorkspaceAccess } from "../tenancy/access";

import { UPLOAD_TTL_SECONDS } from "./config";
import { exportFile, receiveAppUpload, subtitleFile } from "./project-service";
import { getCreatorDeps } from "./runtime";

// The Creator Studio's file routes (src/app/api/w/[workspaceSlug]/studio/…). Access is
// resolved from the session's membership; ids from another workspace are a 404.

/** Short-lived links: a download link outlives the click by two minutes at most. */
const DOWNLOAD_LINK_SECONDS = 120;

/**
 * The upload transport of the in-memory test store (STORAGE_DRIVER=test-memory). Real
 * deployments upload directly to object storage with a signed URL; this route is a 404
 * there. The body must be exactly the announced size (checked before it is read whole).
 */
export async function receiveTestUpload(
  workspace: string,
  sourceId: string,
  request: Request,
): Promise<void> {
  if (parseStorageDriver(process.env) !== "test-memory") {
    throw new AppError("NOT_FOUND", { metadata: { resource: "route" } });
  }
  const ctx = await requireWorkspaceAccess(workspace, "content.create");
  const deps = getCreatorDeps();
  const announced = Number(request.headers.get("content-length") ?? "-1");
  if (!Number.isInteger(announced) || announced <= 0 || announced > deps.limits.maxUploadBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", { metadata: { contentLength: announced } });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  await receiveAppUpload(deps, ctx, sourceId, body);
}

/** Where a READY export can be downloaded: a short-lived signed URL, or its bytes. */
export async function exportDownload(
  workspace: string,
  exportId: string,
): Promise<{ readonly redirect: string } | { readonly body: Uint8Array }> {
  const ctx = await requireWorkspaceAccess(workspace, "content.view");
  const deps = getCreatorDeps();
  const file = await exportFile(deps, ctx, exportId);
  const storage = await deps.storage.forProvider(file.provider);
  const url = await storage.getSignedDownloadUrl(file.key, {
    expiresInSeconds: Math.min(DOWNLOAD_LINK_SECONDS, UPLOAD_TTL_SECONDS),
  });
  if (!url.startsWith("memory://")) return { redirect: url };
  // The in-memory test store has no URLs: the bytes are served by the route itself.
  const object = await storage.getObject(
    file.key,
    file.byteSize === null ? {} : { expectedBytes: file.byteSize },
  );
  if (object === null)
    throw new AppError("NOT_FOUND", { metadata: { resource: "creator_export" } });
  return { body: object.body };
}

export async function transcriptSubtitles(
  workspace: string,
  transcriptId: string,
  format: "srt" | "vtt",
) {
  const ctx = await requireWorkspaceAccess(workspace, "content.view");
  return subtitleFile(getCreatorDeps(), ctx, transcriptId, format);
}

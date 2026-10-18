import "server-only";

import { z } from "zod";

import { withAction } from "../http/action-handler";
import { requireWorkspaceAccess } from "../tenancy/access";
import { can } from "../tenancy/permissions";

import {
  abortUpload,
  cancelJob,
  completeUpload,
  createClip,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  requestExport,
  requestTranscription,
  requestTranslation,
  retryJob,
  reviewClip,
  signUploadPart,
  startMultipartUpload,
  startUpload,
  updateClip,
  updateSegment,
  uploadStatus,
  type UploadTransport,
} from "./project-service";
import { getCreatorDeps } from "./runtime";

// Server actions and page data of the Creator Studio. Each action: strict input →
// session → `requireWorkspaceAccess(slug, action)` → the service, which re-checks the
// role, scopes every query to the workspace and refuses stale versions. Ids and versions
// come from the page and are never authority.

const slug = z.string().min(1).max(100);
const version = z.coerce.number().int().min(0).max(2_147_483_647);
const ms = z.coerce.number().int().min(0).max(14_400_000);
const requestKey = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const language = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
const title = z.string().trim().min(1).max(200);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const fileInput = {
  fileName: z.string().min(1).max(500),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

/** Where the browser PUTs: storage's signed URL, or the app's test-only route (memory store). */
function uploadUrl(
  upload: UploadTransport,
  appPath: string,
  appHeaders: Readonly<Record<string, string>> = {},
) {
  return upload.kind === "direct"
    ? { url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() }
    : { url: appPath, headers: appHeaders, expiresAt: upload.expiresAt.toISOString() };
}

export const createProjectAction = withAction({
  name: "studio.project_create",
  input: z.strictObject({
    slug,
    name: title,
    description: z.string().trim().max(2000).optional(),
  }),
  handler: async ({ slug: workspace, name, description }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    return createProject(getCreatorDeps().db, ctx, {
      name,
      description: description === undefined || description === "" ? null : description,
    });
  },
});

export const startUploadAction = withAction({
  name: "studio.upload_start",
  input: z.strictObject({ slug, projectId: z.uuid(), ...fileInput, sha256: sha256.optional() }),
  handler: async ({ slug: workspace, projectId, sha256: hash, ...file }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    const { sourceId, upload } = await startUpload(getCreatorDeps(), ctx, projectId, {
      ...file,
      sha256: hash ?? null,
    });
    return {
      sourceId,
      ...uploadUrl(upload, `/api/w/${encodeURIComponent(workspace)}/studio/uploads/${sourceId}`, {
        "content-type": file.contentType,
      }),
    };
  },
});

export const startMultipartUploadAction = withAction({
  name: "studio.upload_start_multipart",
  input: z.strictObject({ slug, projectId: z.uuid(), ...fileInput }),
  handler: async ({ slug: workspace, projectId, ...file }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    const started = await startMultipartUpload(getCreatorDeps(), ctx, projectId, file);
    return { ...started, expiresAt: started.expiresAt.toISOString() };
  },
});

export const signUploadPartAction = withAction({
  name: "studio.upload_part",
  input: z.strictObject({
    slug,
    sourceId: z.uuid(),
    partNumber: z.number().int().min(1).max(10_000),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256,
  }),
  handler: async ({ slug: workspace, sourceId, ...part }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    const { upload } = await signUploadPart(getCreatorDeps(), ctx, sourceId, part);
    return uploadUrl(
      upload,
      `/api/w/${encodeURIComponent(workspace)}/studio/uploads/${sourceId}/parts/${String(part.partNumber)}`,
    );
  },
});

export const uploadStatusAction = withAction({
  name: "studio.upload_status",
  input: z.strictObject({ slug, sourceId: z.uuid() }),
  handler: async ({ slug: workspace, sourceId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    const status = await uploadStatus(getCreatorDeps(), ctx, sourceId);
    return { ...status, expiresAt: status.expiresAt.toISOString() };
  },
});

export const abortUploadAction = withAction({
  name: "studio.upload_abort",
  input: z.strictObject({ slug, sourceId: z.uuid() }),
  handler: async ({ slug: workspace, sourceId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    await abortUpload(getCreatorDeps(), ctx, sourceId);
    return { aborted: true };
  },
});

export const deleteProjectAction = withAction({
  name: "studio.project_delete",
  input: z.strictObject({ slug, projectId: z.uuid(), confirmName: z.string().max(200) }),
  handler: async ({ slug: workspace, projectId, confirmName }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.edit");
    return deleteProject(getCreatorDeps(), ctx, projectId, { confirmName });
  },
});

export const completeUploadAction = withAction({
  name: "studio.upload_complete",
  input: z.strictObject({ slug, sourceId: z.uuid() }),
  handler: async ({ slug: workspace, sourceId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    return completeUpload(getCreatorDeps(), ctx, sourceId);
  },
});

export const requestTranscriptionAction = withAction({
  name: "studio.transcribe",
  input: z.strictObject({
    slug,
    projectId: z.uuid(),
    language: language.optional(),
    requestKey,
    externalProcessing: z.boolean().optional(),
  }),
  handler: async ({ slug: workspace, projectId, language: lang, requestKey: key, ...rest }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    return requestTranscription(getCreatorDeps(), ctx, projectId, {
      language: lang ?? null,
      requestKey: key,
      externalProcessing: rest.externalProcessing === true,
    });
  },
});

export const requestTranslationAction = withAction({
  name: "studio.translate",
  input: z.strictObject({
    slug,
    transcriptId: z.uuid(),
    targetLanguage: language,
    requestKey,
    externalProcessing: z.boolean().optional(),
  }),
  handler: async ({ slug: workspace, transcriptId, targetLanguage, requestKey: key, ...rest }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    return requestTranslation(getCreatorDeps(), ctx, transcriptId, {
      targetLanguage,
      requestKey: key,
      externalProcessing: rest.externalProcessing === true,
    });
  },
});

export const updateSegmentAction = withAction({
  name: "studio.segment_update",
  input: z.strictObject({
    slug,
    segmentId: z.uuid(),
    text: z.string().trim().min(1).max(2000),
    startMs: ms,
    endMs: ms,
  }),
  handler: async ({ slug: workspace, segmentId, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.edit");
    await updateSegment(getCreatorDeps(), ctx, segmentId, input);
    return { saved: true };
  },
});

export const updateClipAction = withAction({
  name: "studio.clip_update",
  input: z.strictObject({
    slug,
    clipId: z.uuid(),
    title,
    startMs: ms,
    endMs: ms,
    cropX: z.coerce.number().int().min(0).max(100),
    version,
  }),
  handler: async ({ slug: workspace, clipId, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.edit");
    await updateClip(getCreatorDeps(), ctx, clipId, input);
    return { saved: true };
  },
});

export const createClipAction = withAction({
  name: "studio.clip_create",
  input: z.strictObject({ slug, projectId: z.uuid(), title, startMs: ms, endMs: ms }),
  handler: async ({ slug: workspace, projectId, ...input }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.edit");
    return createClip(getCreatorDeps(), ctx, projectId, input);
  },
});

export const reviewClipAction = withAction({
  name: "studio.clip_review",
  input: z.strictObject({
    slug,
    clipId: z.uuid(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    version,
  }),
  handler: async ({ slug: workspace, clipId, decision, version: v }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.approve");
    await reviewClip(getCreatorDeps(), ctx, clipId, { decision, version: v });
    return { saved: true };
  },
});

export const requestExportAction = withAction({
  name: "studio.export",
  input: z.strictObject({
    slug,
    clipId: z.uuid(),
    aspectRatio: z.enum(["PORTRAIT_9_16", "LANDSCAPE_16_9", "SQUARE_1_1"]),
    subtitleTranscriptId: z.uuid().optional(),
    requestKey,
  }),
  handler: async ({
    slug: workspace,
    clipId,
    aspectRatio,
    subtitleTranscriptId,
    requestKey: key,
  }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    return requestExport(getCreatorDeps(), ctx, clipId, {
      aspectRatio,
      subtitleTranscriptId: subtitleTranscriptId ?? null,
      requestKey: key,
    });
  },
});

export const cancelJobAction = withAction({
  name: "studio.job_cancel",
  input: z.strictObject({ slug, jobId: z.uuid() }),
  handler: async ({ slug: workspace, jobId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    await cancelJob(getCreatorDeps(), ctx, jobId);
    return { cancelled: true };
  },
});

export const retryJobAction = withAction({
  name: "studio.job_retry",
  input: z.strictObject({ slug, jobId: z.uuid() }),
  handler: async ({ slug: workspace, jobId }) => {
    const ctx = await requireWorkspaceAccess(workspace, "content.create");
    return retryJob(getCreatorDeps(), ctx, jobId);
  },
});

// ── Page data ─────────────────────────────────────────────────────────────────

export async function getStudioList(workspace: string) {
  const ctx = await requireWorkspaceAccess(workspace, "content.view");
  return {
    projects: await listProjects(getCreatorDeps().db, ctx),
    canCreate: can(ctx.role, "content.create"),
  };
}

export async function getStudioProject(workspace: string, projectId: string) {
  const ctx = await requireWorkspaceAccess(workspace, "content.view");
  const page = await getProject(getCreatorDeps(), ctx, projectId);
  return {
    ...page,
    canCreate: can(ctx.role, "content.create"),
    canEdit: can(ctx.role, "content.edit"),
    canApprove: can(ctx.role, "content.approve"),
    // Deleting a project and exporting its data: the same role as deleting content.
    canDelete: can(ctx.role, "content.edit"),
  };
}

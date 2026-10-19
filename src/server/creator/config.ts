import type { CreatorJobKind } from "@/generated/prisma/enums";

import type { CreditsConfig } from "../billing/credits";
import type { StorageRouter, StorageWriteTarget } from "../storage/storage";
import type { GuardedPrismaClient } from "../db/prisma";

import type { MediaTools } from "./media/media";
import type {
  ClipSuggestionProvider,
  TranscriptionProvider,
  TranslationProvider,
} from "./providers/types";

// Bounds and dependencies of the Creator Studio. Pure (no `server-only`).

const MiB = 1024 * 1024;

export interface CreatorLimits {
  readonly maxUploadBytes: number;
  readonly maxDurationMs: number;
  /** Open (not completed, not expired) uploads per workspace. */
  readonly maxActiveUploads: number;
  /** How long a resumable upload stays open. */
  readonly uploadSessionMs: number;
  /**
   * Jobs of one workspace that may run at the same time across all workers (default
   * DEFAULT_MAX_RUNNING_JOBS): one busy workspace cannot take every worker.
   */
  readonly maxRunningJobsPerWorkspace?: number;
}

export const DEFAULT_MAX_RUNNING_JOBS = 2;

export function limitsFromEnv(env: {
  readonly CREATOR_MAX_UPLOAD_MB: number;
  readonly CREATOR_MAX_DURATION_SECONDS: number;
  readonly CREATOR_MAX_ACTIVE_UPLOADS: number;
  readonly CREATOR_UPLOAD_SESSION_HOURS: number;
  readonly CREATOR_MAX_RUNNING_JOBS: number;
}): CreatorLimits {
  return {
    maxUploadBytes: env.CREATOR_MAX_UPLOAD_MB * MiB,
    maxDurationMs: env.CREATOR_MAX_DURATION_SECONDS * 1000,
    maxActiveUploads: env.CREATOR_MAX_ACTIVE_UPLOADS,
    uploadSessionMs: env.CREATOR_UPLOAD_SESSION_HOURS * 3_600_000,
    maxRunningJobsPerWorkspace: env.CREATOR_MAX_RUNNING_JOBS,
  };
}

/** Part size of a multipart upload: 16 MiB, larger only to stay within 10 000 parts. */
export const MIN_PART_BYTES = 16 * MiB;
export const MAX_PARTS = 10_000;
export function partSizeFor(size: number): number {
  return Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}
/** A part's signed URL lives this long (the upload itself stays open much longer). */
export const PART_URL_TTL_SECONDS = 15 * 60;

/** A signed upload URL lives this long; an upload not completed by then expires. */
export const UPLOAD_TTL_SECONDS = 15 * 60;
/** An expired, never-completed upload is cleaned up after this grace period. */
export const UPLOAD_CLEANUP_GRACE_MS = 5 * 60_000;
/** Rendered clips are at most this large (FFmpeg stops writing beyond it). */
export const EXPORT_MAX_BYTES = 500 * MiB;
export const MIN_CLIP_MS = 1000;
export const MAX_CLIP_MS = 600_000;

/** A worker's claim on a job; renewed every HEARTBEAT_MS while it works. */
export const LEASE_MS = 2 * 60_000;
export const HEARTBEAT_MS = 30_000;
/** A job not finished this long after it was created fails (`deadline_reached`). */
export const JOB_DEADLINE_MS = 60 * 60_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_BASE_MS = 30_000;

/** The steps of each kind of job, in order. A succeeded step is never run again. */
export const JOB_STAGES: Readonly<Record<CreatorJobKind, readonly string[]>> = {
  ANALYZE: ["VERIFY"],
  TRANSCRIBE: ["TRANSCRIBE", "SUGGEST"],
  TRANSLATE: ["TRANSLATE"],
  EXPORT: ["RENDER"],
};

/**
 * Hard limit of one step (download, FFmpeg, provider call, storage write). Every step
 * that holds credits ends — or is killed — well before stale holds are released
 * (billing STALE_HOLD_MS, 15 minutes), so a hold is always settled by its own step.
 */
export const STEP_TIMEOUT_MS: Readonly<Record<string, number>> = {
  VERIFY: 5 * 60_000,
  TRANSCRIBE: 10 * 60_000,
  SUGGEST: 60_000,
  TRANSLATE: 5 * 60_000,
  RENDER: 10 * 60_000,
};

/** Started minutes of media: what per-minute features are charged by. */
export const billedMinutes = (durationMs: number) => Math.max(1, Math.ceil(durationMs / 60_000));

export interface CreatorStorage extends StorageRouter {
  writeTarget(): Promise<StorageWriteTarget>;
}

export interface CreatorLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface CreatorDeps {
  readonly db: GuardedPrismaClient;
  readonly storage: CreatorStorage;
  /** Null when CREATOR_AI_PROVIDER is disabled. */
  readonly transcription: TranscriptionProvider | null;
  readonly translation: TranslationProvider | null;
  readonly clips: ClipSuggestionProvider;
  readonly tools: MediaTools;
  readonly credits: CreditsConfig;
  readonly limits: CreatorLimits;
  /** Scratch space of the worker (default: the OS temporary directory). */
  readonly workDir?: string;
  readonly logger?: CreatorLogger;
  /** Overrides of the bounds above (tests only). */
  readonly timing?: {
    readonly leaseMs?: number;
    readonly heartbeatMs?: number;
    readonly stepTimeoutMs?: number;
    readonly retryBaseMs?: number;
    /** Multipart part size (tests; the database still requires at least 5 MiB). */
    readonly partSizeBytes?: number;
  };
}

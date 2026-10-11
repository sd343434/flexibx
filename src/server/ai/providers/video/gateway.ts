// The provider-neutral video gateway (Phase 4, docs/AI_MARKETING_EMPLOYEE_ARCHITECTURE.md
// §4.2.1). Pure (no `server-only`) for unit tests. Application code never talks to a
// video vendor directly: the generation service drives a `VideoProvider` through
// submit → status → download. Vendor SDKs, keys and model names stay inside an adapter
// in this folder. The only adapter today is the deterministic fake (fake.ts).

export const VIDEO_TIERS = ["DRAFT", "STANDARD"] as const;
export type VideoTier = (typeof VIDEO_TIERS)[number];

export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

/** What a clip must look like; the output is validated against exactly this. */
export interface VideoSpec {
  readonly durationSeconds: number;
  readonly aspectRatio: VideoAspectRatio;
  readonly resolution: VideoResolution;
  readonly audio: boolean;
}

export interface VideoSubmitRequest extends VideoSpec {
  readonly prompt: string;
  readonly model: string;
  /** hash(jobId, attemptNo): sent as the client reference so a lost response can be found. */
  readonly idempotencyKey: string;
}

export type VideoJobStatus =
  | { readonly state: "QUEUED" }
  | { readonly state: "RUNNING" }
  | { readonly state: "SUCCEEDED"; readonly billedSeconds: number | null }
  | {
      readonly state: "FAILED";
      readonly failure: VideoFailure;
      readonly billedSeconds: number | null;
    }
  | { readonly state: "CANCELLED"; readonly billedSeconds: number | null };

/**
 * Normalized failures. `rejected`: the provider refused the request before accepting it
 * (bad request, quota) — permanent. `refused`: a safety/content refusal — never retried
 * automatically. `invalid_output`: the clip failed our validation.
 */
export const VIDEO_FAILURES = [
  "timeout",
  "unavailable",
  "rate_limited",
  "refused",
  "rejected",
  "invalid_output",
] as const;
export type VideoFailure = (typeof VIDEO_FAILURES)[number];

/**
 * A provider call failed. `accepted` says what is known about a submission:
 * - "no": the provider certainly did not accept it (nothing billed; safe to try again);
 * - "unknown": it may have been accepted (timeout, connection loss) — never resubmit
 *   blindly; reconcile through `findByClientRef`.
 */
export class VideoProviderError extends Error {
  readonly kind: VideoFailure;
  readonly accepted: "no" | "unknown";

  constructor(kind: VideoFailure, accepted: "no" | "unknown", message: string = kind) {
    super(message);
    this.name = "VideoProviderError";
    this.kind = kind;
    this.accepted = accepted;
  }
}

export function isVideoProviderError(error: unknown): error is VideoProviderError {
  return error instanceof VideoProviderError;
}

export interface VideoProvider {
  /** Stable provider name stored with each job (e.g. `fake`). */
  readonly name: string;
  /** The model a tier maps to (routing table). */
  modelFor(tier: VideoTier): string;
  /** Why this provider cannot produce `spec`, or null. Checked before anything is reserved. */
  unsupported(spec: VideoSpec): string | null;
  submit(request: VideoSubmitRequest): Promise<{ readonly providerJobId: string }>;
  status(providerJobId: string): Promise<VideoJobStatus>;
  /** The finished clip's bytes. Throws VideoProviderError("unavailable") if it cannot be fetched now. */
  download(providerJobId: string): Promise<Uint8Array>;
  /** Best effort. */
  cancel(providerJobId: string): Promise<void>;
  /** The provider job submitted with this client reference, or null if none was accepted. */
  findByClientRef(idempotencyKey: string): Promise<string | null>;
}

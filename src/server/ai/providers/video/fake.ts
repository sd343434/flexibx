import { buildMp4, expectedDimensions } from "@/server/videos/generation/mp4";

import {
  VideoProviderError,
  type VideoJobStatus,
  type VideoProvider,
  type VideoSpec,
  type VideoSubmitRequest,
  type VideoTier,
} from "./gateway";

// A deterministic local video provider for development and automated tests
// (VIDEO_PROVIDER=fake). It calls nothing external and costs nothing: a submission
// "finishes" after a fixed number of status polls and returns a small, structurally
// valid MP4 of exactly the requested shape. Failure scenarios (§4.2.4) exist only as
// constructor options for tests — nothing in a request can switch them on.

export type FakeVideoScenario =
  | "ok"
  /** Submit refused before acceptance (4xx): permanent. */
  | "submit_rejected"
  /** Submit not accepted (5xx/429): nothing billed, safe to try again. */
  | "submit_unavailable"
  /** Submit timed out AFTER the provider accepted it (outcome unknown to the caller). */
  | "submit_timeout_accepted"
  /** Submit timed out and the provider never received it. */
  | "submit_timeout_lost"
  /** The provider job fails internally (not billed). */
  | "provider_failed"
  /** Safety/content refusal (not billed). */
  | "refused"
  /** A clip of the wrong duration (billed). */
  | "invalid_output"
  /** Bytes that are not an MP4 (billed). */
  | "corrupt_output"
  /** Never leaves RUNNING (wall-time tests). */
  | "never_finishes"
  /** The first download fails transiently; later downloads succeed. */
  | "download_fails_once";

export interface FakeVideoProviderOptions {
  /** One scenario per submit call, in order; afterwards every submission is "ok". */
  readonly scenarios?: readonly FakeVideoScenario[];
  /** RUNNING answers before a job finishes (default 1). */
  readonly pollsBeforeDone?: number;
}

export const FAKE_VIDEO_PROVIDER_NAME = "fake";
export const FAKE_VIDEO_DURATIONS = [4, 6, 8] as const;

interface FakeJob {
  readonly request: VideoSubmitRequest;
  readonly scenario: FakeVideoScenario;
  polls: number;
  downloads: number;
  cancelled: boolean;
}

export class FakeVideoProvider implements VideoProvider {
  readonly name = FAKE_VIDEO_PROVIDER_NAME;
  /** Calls made, for assertions (submissions are never repeated for one attempt). */
  readonly calls = { submit: 0, status: 0, download: 0, cancel: 0, findByClientRef: 0 };
  private readonly scenarios: FakeVideoScenario[];
  private readonly pollsBeforeDone: number;
  private readonly jobs = new Map<string, FakeJob>();

  constructor(options: FakeVideoProviderOptions = {}) {
    this.scenarios = [...(options.scenarios ?? [])];
    this.pollsBeforeDone = options.pollsBeforeDone ?? 1;
  }

  modelFor(tier: VideoTier): string {
    return tier === "DRAFT" ? "fake-video-draft-1" : "fake-video-standard-1";
  }

  unsupported(spec: VideoSpec): string | null {
    return (FAKE_VIDEO_DURATIONS as readonly number[]).includes(spec.durationSeconds)
      ? null
      : "duration";
  }

  submit(request: VideoSubmitRequest): Promise<{ readonly providerJobId: string }> {
    this.calls.submit += 1;
    const scenario = this.scenarios.shift() ?? "ok";
    const providerJobId = `fake-video-${request.idempotencyKey}`;
    const accept = () => {
      this.jobs.set(providerJobId, { request, scenario, polls: 0, downloads: 0, cancelled: false });
    };
    switch (scenario) {
      case "submit_rejected":
        return Promise.reject(new VideoProviderError("rejected", "no"));
      case "submit_unavailable":
        return Promise.reject(new VideoProviderError("unavailable", "no"));
      case "submit_timeout_lost":
        return Promise.reject(new VideoProviderError("timeout", "unknown"));
      case "submit_timeout_accepted":
        accept();
        return Promise.reject(new VideoProviderError("timeout", "unknown"));
      case "ok":
      case "provider_failed":
      case "refused":
      case "invalid_output":
      case "corrupt_output":
      case "never_finishes":
      case "download_fails_once":
        accept();
        return Promise.resolve({ providerJobId });
    }
  }

  private job(providerJobId: string): FakeJob {
    const job = this.jobs.get(providerJobId);
    if (job === undefined) throw new VideoProviderError("unavailable", "no", "unknown job");
    return job;
  }

  status(providerJobId: string): Promise<VideoJobStatus> {
    this.calls.status += 1;
    const job = this.job(providerJobId);
    if (job.cancelled) return Promise.resolve({ state: "CANCELLED", billedSeconds: 0 });
    if (job.scenario === "never_finishes" || job.polls < this.pollsBeforeDone) {
      job.polls += 1;
      return Promise.resolve({ state: "RUNNING" });
    }
    if (job.scenario === "provider_failed") {
      return Promise.resolve({ state: "FAILED", failure: "unavailable", billedSeconds: 0 });
    }
    if (job.scenario === "refused") {
      return Promise.resolve({ state: "FAILED", failure: "refused", billedSeconds: 0 });
    }
    return Promise.resolve({ state: "SUCCEEDED", billedSeconds: job.request.durationSeconds });
  }

  download(providerJobId: string): Promise<Uint8Array> {
    this.calls.download += 1;
    const job = this.job(providerJobId);
    job.downloads += 1;
    if (job.scenario === "download_fails_once" && job.downloads === 1) {
      return Promise.reject(new VideoProviderError("unavailable", "no"));
    }
    if (job.scenario === "corrupt_output") {
      return Promise.resolve(new TextEncoder().encode("not a video"));
    }
    const { request } = job;
    return Promise.resolve(
      buildMp4({
        ...expectedDimensions(request),
        durationSeconds: request.durationSeconds + (job.scenario === "invalid_output" ? 2 : 0),
        audio: request.audio,
        seed: request.idempotencyKey.length + request.durationSeconds,
      }),
    );
  }

  cancel(providerJobId: string): Promise<void> {
    this.calls.cancel += 1;
    const job = this.jobs.get(providerJobId);
    if (job !== undefined) job.cancelled = true;
    return Promise.resolve();
  }

  findByClientRef(idempotencyKey: string): Promise<string | null> {
    this.calls.findByClientRef += 1;
    const providerJobId = `fake-video-${idempotencyKey}`;
    return Promise.resolve(this.jobs.has(providerJobId) ? providerJobId : null);
  }
}

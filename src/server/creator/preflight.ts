import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StorageService } from "../storage/storage";
import type { BucketRules } from "../storage/s3-storage";

import { freeBytes } from "./media/files";
import type { MediaTools } from "./media/media";

// Staging preflight for the Creator Studio (Pass 10): proves, on the host and storage it
// runs against, what the local test suite cannot — FFmpeg's real build, the worker's
// scratch disk, a private bucket, short-lived links, a resumable upload end to end with
// its SHA-256, and the bucket's CORS and lifecycle rules. Run on the WORKER host:
//
//   pnpm creator:preflight            (scripts/creator/preflight.ts)
//
// It writes only its own synthetic probe objects (random bytes under the reserved
// all-zero workspace id) and deletes them; it never reads customer files and never calls
// a transcription or translation provider (the provider is reported from configuration
// only). Output: names, pass/fail and short reasons — no keys, URLs or credentials. Pure
// (dependencies injected) so the checks themselves are unit-tested.

export type PreflightStatus = "pass" | "fail" | "warn" | "skip";

export interface PreflightResult {
  readonly name: string;
  readonly status: PreflightStatus;
  readonly detail: string;
}

/** A signed-URL request (fetch in production; tests serve memory:// URLs). */
export type PreflightHttp = (
  url: string,
  init: {
    readonly method: "GET" | "PUT";
    readonly body?: Uint8Array;
    readonly headers?: Record<string, string>;
  },
) => Promise<{ readonly status: number; readonly body: Uint8Array; readonly etag: string | null }>;

export interface PreflightDeps {
  readonly tools: MediaTools;
  readonly runTool: (
    tool: "ffmpeg" | "ffprobe",
    args: readonly string[],
  ) => Promise<{ readonly stdout: string }>;
  readonly workDir: string;
  /** Free scratch space a worker needs (what its heartbeat warns below). */
  readonly minFreeBytes: number;
  /** The storage new Creator Studio files are written to; null skips the storage checks. */
  readonly storage: StorageService | null;
  /** The bucket's rules (S3 adapters only); null: not readable here, check by hand. */
  readonly readBucketRules: (() => Promise<BucketRules>) | null;
  readonly http: PreflightHttp;
  /** The app's origin (APP_URL): the browser uploads from it, so CORS must allow it. */
  readonly appOrigin: string;
  readonly provider: {
    readonly configured: "disabled" | "simulated" | "openai";
    readonly externalApproved: boolean;
    readonly nodeEnv: string;
  };
  /**
   * Pass 42: whether FFmpeg runs in the isolated media runner (then `runTool` goes there,
   * so the FFmpeg checks above prove the runner answers and has the right build).
   */
  readonly mediaRunner: boolean;
}

/** The reserved workspace id of probe objects: no real workspace has it. */
export const PREFLIGHT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
const MiB = 1024 * 1024;
/** S3's smallest part (every part but the last). */
const PROBE_PART_BYTES = 5 * MiB;
/** Signed links the app creates for Creator Studio files live at most this long. */
export const MAX_LINK_SECONDS = 15 * 60;
/** Incomplete multipart uploads should be aborted by the bucket within this many days. */
export const MAX_ABORT_INCOMPLETE_DAYS = 7;

const MIN_FFMPEG_MAJOR = 6;
const REQUIRED_ENCODERS = ["libx264", "aac", "libopus"] as const;

const result = (name: string, status: PreflightStatus, detail: string): PreflightResult => ({
  name,
  status,
  detail,
});

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown error");

const probeKey = (category: "creator-sources" | "creator-exports") =>
  `workspaces/${PREFLIGHT_WORKSPACE_ID}/${category}/${randomUUID()}.mp4`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The signed URL without its query string: what someone without a signature could ask for. */
function unsigned(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

/** X-Amz-Expires of a SigV4 presigned URL (null when the URL carries none). */
function linkSeconds(url: string): number | null {
  try {
    const value = new URL(url).searchParams.get("X-Amz-Expires");
    return value === null ? null : Number(value);
  } catch {
    return null;
  }
}

async function mediaChecks(deps: PreflightDeps): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];
  try {
    const { stdout } = await deps.runTool("ffmpeg", ["-hide_banner", "-version"]);
    const major = Number(/ffmpeg version n?(\d+)/.exec(stdout)?.[1] ?? Number.NaN);
    results.push(
      Number.isNaN(major)
        ? result("ffmpeg_version", "warn", "version not recognised (custom build?)")
        : major >= MIN_FFMPEG_MAJOR
          ? result("ffmpeg_version", "pass", `FFmpeg ${String(major)}`)
          : result(
              "ffmpeg_version",
              "fail",
              `FFmpeg ${String(major)} < ${String(MIN_FFMPEG_MAJOR)}`,
            ),
    );
  } catch (error) {
    results.push(result("ffmpeg_version", "fail", `ffmpeg not runnable (${errorName(error)})`));
    return results;
  }
  try {
    const { stdout } = await deps.runTool("ffmpeg", ["-hide_banner", "-encoders"]);
    const missing = REQUIRED_ENCODERS.filter(
      (encoder) => !new RegExp(`\\s${encoder}\\s`).test(stdout),
    );
    results.push(
      missing.length === 0
        ? result("ffmpeg_encoders", "pass", REQUIRED_ENCODERS.join(", "))
        : result("ffmpeg_encoders", "fail", `missing: ${missing.join(", ")}`),
    );
  } catch (error) {
    results.push(result("ffmpeg_encoders", "fail", errorName(error)));
  }
  try {
    const { stdout } = await deps.runTool("ffmpeg", ["-hide_banner", "-filters"]);
    results.push(
      /\ssubtitles\s/.test(stdout)
        ? result("ffmpeg_subtitles", "pass", "libass subtitles filter")
        : result("ffmpeg_subtitles", "fail", "no subtitles filter (FFmpeg built without libass)"),
    );
  } catch (error) {
    results.push(result("ffmpeg_subtitles", "fail", errorName(error)));
  }
  try {
    await deps.runTool("ffprobe", ["-hide_banner", "-version"]);
    results.push(result("ffprobe", "pass", "runnable"));
  } catch (error) {
    results.push(result("ffprobe", "fail", `ffprobe not runnable (${errorName(error)})`));
  }
  return results;
}

async function diskChecks(deps: PreflightDeps): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(deps.workDir, "creator-preflight-"));
    await writeFile(join(dir, "probe.bin"), new Uint8Array(1024));
    results.push(result("scratch_writable", "pass", "created, wrote and removed a probe"));
  } catch (error) {
    results.push(
      result(
        "scratch_writable",
        "fail",
        `cannot write the scratch directory (${errorName(error)})`,
      ),
    );
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  const free = await freeBytes(deps.workDir);
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  results.push(
    free === null
      ? result("scratch_free_space", "warn", "free space not measurable on this filesystem")
      : free >= deps.minFreeBytes
        ? result(
            "scratch_free_space",
            "pass",
            `${gib(free)} free, ${gib(deps.minFreeBytes)} needed`,
          )
        : result(
            "scratch_free_space",
            "fail",
            `${gib(free)} free, ${gib(deps.minFreeBytes)} needed`,
          ),
  );
  return results;
}

/** One small object: stored, readable only with a signature, short-lived link, deleted. */
async function privateObjectChecks(
  deps: PreflightDeps,
  storage: StorageService,
): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];
  const key = probeKey("creator-exports");
  const body = new Uint8Array(4096).map((_, index) => index % 251);
  try {
    await storage.put(key, body, { contentType: "video/mp4" });
  } catch (error) {
    return [result("storage_write", "fail", `cannot store a probe object (${errorName(error)})`)];
  }
  results.push(result("storage_write", "pass", "probe object stored"));
  try {
    const signed = await storage.getSignedDownloadUrl(key, { expiresInSeconds: 120 });
    const read = await deps.http(signed, { method: "GET" });
    results.push(
      read.status === 200 && sha256(read.body) === sha256(body)
        ? result("signed_download", "pass", "signed link returns the exact bytes")
        : result("signed_download", "fail", `signed link answered ${String(read.status)}`),
    );
    const anonymous = await deps.http(unsigned(signed), { method: "GET" });
    results.push(
      anonymous.status === 200
        ? result("bucket_private", "fail", "the object is readable WITHOUT a signature")
        : result("bucket_private", "pass", `unsigned read refused (${String(anonymous.status)})`),
    );
    const seconds = linkSeconds(signed);
    results.push(
      seconds === null
        ? result("link_lifetime", "skip", "this store's links carry no expiry parameter")
        : seconds <= MAX_LINK_SECONDS
          ? result("link_lifetime", "pass", `${String(seconds)} s`)
          : result("link_lifetime", "fail", `${String(seconds)} s > ${String(MAX_LINK_SECONDS)} s`),
    );
  } catch (error) {
    results.push(result("signed_download", "fail", errorName(error)));
  }
  try {
    await storage.delete(key, { signal: AbortSignal.timeout(30_000) });
    results.push(
      (await storage.getObject(key)) === null
        ? result("storage_delete", "pass", "probe object deleted")
        : result("storage_delete", "fail", "object still readable after delete"),
    );
  } catch (error) {
    results.push(
      result("storage_delete", "fail", `probe object not deleted (${errorName(error)})`),
    );
  }
  return results;
}

/**
 * A two-part resumable upload exactly as the browser makes one: signed part URLs, parts
 * listed by storage (the source of truth on resume), completion, then the assembled
 * object's SHA-256 compared with the bytes sent.
 */
async function multipartCheck(
  deps: PreflightDeps,
  storage: StorageService,
): Promise<PreflightResult> {
  const multipart = storage.multipart;
  if (multipart === undefined) {
    return result("multipart_upload", "fail", "this storage has no multipart uploads");
  }
  const key = probeKey("creator-sources");
  const bytes = new Uint8Array(PROBE_PART_BYTES + 1024).map((_, index) => (index * 7) % 253);
  const parts = [bytes.subarray(0, PROBE_PART_BYTES), bytes.subarray(PROBE_PART_BYTES)];
  let uploadId: string | null = null;
  try {
    uploadId = await multipart.create(key, { contentType: "video/mp4" });
    for (const [index, part] of parts.entries()) {
      const signed = await multipart.signPart(key, uploadId, index + 1, {
        contentLength: part.byteLength,
      });
      const sent = await deps.http(signed.url, {
        method: "PUT",
        body: part,
        headers: signed.headers,
      });
      if (sent.status !== 200) {
        return result(
          "multipart_upload",
          "fail",
          `part ${String(index + 1)} answered ${String(sent.status)}`,
        );
      }
    }
    const listed = await multipart.listParts(key, uploadId);
    if (
      listed?.length !== 2 ||
      listed.some((part, index) => part.size !== parts[index]?.byteLength)
    ) {
      return result("multipart_upload", "fail", "storage does not list the parts sent");
    }
    await multipart.complete(
      key,
      uploadId,
      listed.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    );
    uploadId = null;
    const stored = await storage.getObject(key, { expectedBytes: bytes.byteLength });
    if (stored === null) return result("multipart_upload", "fail", "assembled object missing");
    return sha256(stored.body) === sha256(bytes)
      ? result("multipart_upload", "pass", "2 parts uploaded, listed, completed, SHA-256 matches")
      : result(
          "multipart_upload",
          "fail",
          "assembled object's SHA-256 differs from the parts sent",
        );
  } catch (error) {
    return result("multipart_upload", "fail", errorName(error));
  } finally {
    if (uploadId !== null) await multipart.abort(key, uploadId).catch(() => undefined);
    await storage.delete(key, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
  }
}

async function bucketRuleChecks(deps: PreflightDeps): Promise<PreflightResult[]> {
  if (deps.readBucketRules === null) {
    return [
      result("bucket_cors", "skip", "rules not readable through this storage: check them by hand"),
      result(
        "bucket_lifecycle",
        "skip",
        "rules not readable through this storage: check them by hand",
      ),
    ];
  }
  let rules: BucketRules;
  try {
    rules = await deps.readBucketRules();
  } catch (error) {
    const reason = `cannot read the bucket's rules (${errorName(error)}): check them by hand`;
    return [result("bucket_cors", "warn", reason), result("bucket_lifecycle", "warn", reason)];
  }
  const origin = deps.appOrigin.replace(/\/+$/, "");
  const corsOk = (rules.cors ?? []).some(
    (rule) =>
      rule.allowedMethods.some((method) => method.toUpperCase() === "PUT") &&
      rule.allowedOrigins.some((allowed) => allowed === origin || allowed === "*") &&
      rule.allowedHeaders.some(
        (header) => header === "*" || header.toLowerCase() === "content-type",
      ),
  );
  const wildcard = (rules.cors ?? []).some((rule) => rule.allowedOrigins.includes("*"));
  const abortDays = (rules.lifecycle ?? [])
    .filter((rule) => rule.enabled && rule.abortIncompleteMultipartDays !== null)
    .map((rule) => rule.abortIncompleteMultipartDays ?? Infinity);
  const shortest = abortDays.length === 0 ? null : Math.min(...abortDays);
  return [
    !corsOk
      ? result(
          "bucket_cors",
          "fail",
          "no CORS rule allows PUT with content-type from the app's origin",
        )
      : wildcard
        ? result("bucket_cors", "warn", "allowed, but a rule allows every origin (*)")
        : result("bucket_cors", "pass", "PUT with content-type allowed from the app's origin"),
    shortest === null
      ? result("bucket_lifecycle", "fail", "no rule aborts incomplete multipart uploads")
      : shortest <= MAX_ABORT_INCOMPLETE_DAYS
        ? result(
            "bucket_lifecycle",
            "pass",
            `incomplete uploads aborted after ${String(shortest)} day(s)`,
          )
        : result("bucket_lifecycle", "warn", `incomplete uploads kept ${String(shortest)} days`),
  ];
}

/** Pass 42: FFmpeg next to the credentials is refused in production, flagged elsewhere. */
function mediaIsolationCheck(deps: PreflightDeps): PreflightResult {
  if (deps.mediaRunner) {
    return result("media_isolation", "pass", "FFmpeg runs in the isolated media runner");
  }
  return deps.provider.nodeEnv === "production"
    ? result("media_isolation", "fail", "no media runner: FFmpeg would run beside the credentials")
    : result("media_isolation", "warn", "FFmpeg runs in this process's container (development)");
}

/** What the configuration allows; never a call to the provider. */
function providerCheck(deps: PreflightDeps): PreflightResult {
  const { configured, externalApproved, nodeEnv } = deps.provider;
  if (configured === "simulated") {
    return nodeEnv === "production"
      ? result("ai_provider", "fail", "the simulator is configured in production")
      : result("ai_provider", "warn", "simulator: labelled output, never real transcription");
  }
  if (configured === "openai") {
    return externalApproved
      ? result(
          "ai_provider",
          "warn",
          "OpenAI enabled: customer audio and text leave the deployment (not called by this check)",
        )
      : result(
          "ai_provider",
          "fail",
          "OpenAI configured without CREATOR_EXTERNAL_PROCESSING=approved",
        );
  }
  return result("ai_provider", "pass", "disabled: nothing is sent to an external provider");
}

export async function runPreflight(deps: PreflightDeps): Promise<{
  readonly ok: boolean;
  readonly results: readonly PreflightResult[];
}> {
  const results: PreflightResult[] = [...(await mediaChecks(deps)), ...(await diskChecks(deps))];
  if (deps.storage === null) {
    results.push(result("storage", "skip", "no storage configured for this run"));
  } else {
    results.push(...(await privateObjectChecks(deps, deps.storage)));
    results.push(await multipartCheck(deps, deps.storage));
  }
  results.push(...(await bucketRuleChecks(deps)));
  results.push(providerCheck(deps));
  results.push(mediaIsolationCheck(deps));
  return { ok: results.every((entry) => entry.status !== "fail"), results };
}

// Creator Studio staging preflight: run on the WORKER host, with the worker's
// environment, before a staging trial (docs/runbooks/STAGING_CREATOR_STUDIO.md § 3).
//
//   pnpm creator:preflight
//
// Checks FFmpeg, the scratch disk, the storage new files go to (a private bucket,
// short-lived links, a two-part resumable upload with its SHA-256) and the bucket's CORS
// and lifecycle rules. It writes and deletes only its own random probe objects under the
// reserved all-zero workspace id, and never calls a transcription or translation
// provider. Exit code 1 when a check fails. Output: check names and reasons only.

import { tmpdir } from "node:os";

import { runTool } from "@/server/creator/media/media";
import { SCRATCH_MARGIN_BYTES } from "@/server/creator/jobs";
import { runPreflight, type PreflightHttp } from "@/server/creator/preflight";
import { getCreatorDeps } from "@/server/creator/runtime";
import { getSystemDb } from "@/server/db/client";
import { getCreatorEnv } from "@/server/env";
import type { BucketRules } from "@/server/storage/s3-storage";

const http: PreflightHttp = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: response.status,
    body: new Uint8Array(await response.arrayBuffer()),
    etag: response.headers.get("etag"),
  };
};

async function main(): Promise<void> {
  const env = getCreatorEnv();
  const deps = getCreatorDeps();
  const target = await deps.storage.writeTarget();
  // S3 adapters can read the bucket's rules; other stores are checked by hand.
  const read = (target.storage as { readBucketRules?: () => Promise<BucketRules> }).readBucketRules;
  const appUrl = process.env.APP_URL ?? "";
  const { ok, results } = await runPreflight({
    tools: deps.tools,
    // Pass 42: through the media runner when configured, as the worker runs FFmpeg.
    runTool: (tool, args) =>
      runTool(deps.tools, tool, args, {
        timeoutMs: 30_000,
        maxStdoutBytes: 4 * 1024 * 1024,
      }),
    workDir: deps.workDir ?? tmpdir(),
    minFreeBytes: 2 * deps.limits.maxUploadBytes + SCRATCH_MARGIN_BYTES,
    storage: target.storage,
    readBucketRules: typeof read === "function" ? () => read.call(target.storage) : null,
    http,
    appOrigin: appUrl === "" ? "" : new URL(appUrl).origin,
    provider: {
      configured: env.CREATOR_AI_PROVIDER,
      externalApproved: env.CREATOR_EXTERNAL_PROCESSING === "approved",
      nodeEnv: env.NODE_ENV,
    },
    mediaRunner: deps.tools.run !== undefined,
  });
  for (const entry of results) {
    process.stdout.write(
      `${entry.status.toUpperCase().padEnd(5)} ${entry.name}: ${entry.detail}\n`,
    );
  }
  process.stdout.write(
    `${ok ? "PREFLIGHT PASSED" : "PREFLIGHT FAILED"} (storage: ${target.provider})\n`,
  );
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Preflight could not run: ${error instanceof Error ? error.name : "unknown error"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([Promise.resolve().then(() => getSystemDb().$disconnect())]);
  });

// The isolated media runner (Pass 42, docs/runbooks/MEDIA_ISOLATION.md): the only process
// that runs FFmpeg/ffprobe for the Creator Studio worker in staging and production. It
// runs in its own container — no env file, no network, read-only root, no capability, its
// own process namespace — and shares only the scratch volume with the worker. A crafted
// media file that took control of FFmpeg here finds no credential to read: not in its
// environment, not in /proc (the worker's processes are not visible), not on disk.
//
//   node --import tsx --import ./scripts/video-retention/register.mjs scripts/creator/media-runner.ts
//
// MEDIA_RUNNER_LISTEN: the Unix socket (mode 0600, inside the work volume);
// MEDIA_RUNNER_WORK_ROOT: the only directory FFmpeg may read or write (default /work);
// MEDIA_RUNNER_CONCURRENCY: runs at a time (default 2; one worker runs one at a time).
// It refuses to start when its own environment carries anything that looks like a
// credential: a misconfiguration (env_file added back) stops the runner instead of
// handing secrets to FFmpeg's neighbour.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";

import {
  mediaPolicyViolation,
  mediaRunRequestSchema,
  type MediaRunResponse,
} from "@/server/creator/media/runner-protocol";
import { sensitiveEnvNames } from "@/server/creator/media/runner-env";
import { MediaToolError, runMediaTool } from "@/server/creator/media/tools";

const MAX_REQUEST_BYTES = 256 * 1024;

const binaries = {
  ffmpeg: process.env.CREATOR_FFMPEG_PATH ?? "ffmpeg",
  ffprobe: process.env.CREATOR_FFPROBE_PATH ?? "ffprobe",
} as const;

const log = (fields: Record<string, unknown>) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), service: "flexibx-media-runner", ...fields })}\n`,
  );
};

function answer(response: ServerResponse, status: number, body: MediaRunResponse): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const refuse = (response: ServerResponse, detail: string) => {
  answer(response, 400, { ok: false, code: "refused", exitCode: null, detail });
};

function main(): void {
  const leaked = sensitiveEnvNames(process.env);
  if (leaked.length > 0) {
    // Names only, never values.
    log({
      level: "error",
      msg: "refusing to start: credentials in the environment",
      names: leaked,
    });
    process.exit(78);
  }
  const socketPath = process.env.MEDIA_RUNNER_LISTEN ?? "";
  const workRoot = process.env.MEDIA_RUNNER_WORK_ROOT ?? "/work";
  const concurrency = Number(process.env.MEDIA_RUNNER_CONCURRENCY ?? "2");
  if (socketPath === "" || !Number.isInteger(concurrency) || concurrency < 1) {
    log({ level: "error", msg: "MEDIA_RUNNER_LISTEN and MEDIA_RUNNER_CONCURRENCY are required" });
    process.exit(78);
  }
  let running = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, running }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/run") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        refuse(response, "request_too_large");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_REQUEST_BYTES) return;
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        refuse(response, "json");
        return;
      }
      const parsed = mediaRunRequestSchema.safeParse(raw);
      if (!parsed.success) {
        refuse(response, "schema");
        return;
      }
      const violation = mediaPolicyViolation(parsed.data, workRoot);
      if (violation !== null) {
        log({ level: "warn", msg: "request refused", tool: parsed.data.tool, violation });
        refuse(response, violation);
        return;
      }
      if (running >= concurrency) {
        answer(response, 503, { ok: false, code: "failed", exitCode: null, detail: "busy" });
        return;
      }
      // The worker went away (job cancelled, lease lost, worker killed): kill FFmpeg.
      const gone = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) gone.abort();
      });
      running += 1;
      const { tool, args, timeoutMs, maxStdoutBytes, cwd } = parsed.data;
      runMediaTool(binaries[tool], args, {
        timeoutMs,
        signal: gone.signal,
        ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
        ...(cwd === undefined ? {} : { cwd }),
      })
        .then(({ stdout }) => {
          answer(response, 200, { ok: true, stdout });
        })
        .catch((error: unknown) => {
          const failure =
            error instanceof MediaToolError && error.code !== "unavailable"
              ? error
              : new MediaToolError("failed");
          if (failure.code !== "aborted") {
            log({
              level: "warn",
              msg: "run failed",
              tool,
              code: failure.code,
              exitCode: failure.exitCode,
            });
          }
          answer(response, 200, {
            ok: false,
            code: failure.code as Exclude<MediaToolError["code"], "unavailable">,
            exitCode: failure.exitCode,
            detail: failure.detail,
          });
        })
        .finally(() => {
          running -= 1;
        });
    });
  });

  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const previous = process.umask(0o177);
  server.listen(socketPath, () => {
    process.umask(previous);
    chmodSync(socketPath, 0o600);
    log({ level: "info", msg: "media runner listening", concurrency });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      log({ level: "info", msg: "media runner stopping", signal });
      server.close();
      server.closeAllConnections();
      rmSync(socketPath, { force: true });
      process.exit(0);
    });
  }
}

main();

import { request } from "node:http";

import type { MediaRunRequest, MediaRunResponse, MediaToolName } from "./runner-protocol";
import { MediaToolError, type RunOptions } from "./tools";

// The worker's side of the isolated media runner (Pass 42): one HTTP request per FFmpeg or
// ffprobe run, over the runner's Unix socket on the shared work volume. No fallback: an
// unreachable runner is MediaToolError("unavailable") — the step is retried later, FFmpeg
// never runs inside the worker. Aborting the request (job cancelled, lease lost) closes the
// connection, and the runner kills the process.

export type MediaRun = (
  tool: MediaToolName,
  args: readonly string[],
  options: RunOptions,
) => Promise<{ readonly stdout: string }>;

/** Slack on top of the run's own timeout, for the runner to kill and answer. */
const ANSWER_SLACK_MS = 15_000;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export function createRemoteMediaRun(socketPath: string): MediaRun {
  return (tool, args, options) =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new MediaToolError("aborted"));
        return;
      }
      const body: MediaRunRequest = {
        tool,
        args: [...args],
        timeoutMs: options.timeoutMs,
        ...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      };
      let settled = false;
      const settle = (error: Error | null, stdout = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error === null) resolve({ stdout });
        else reject(error);
      };
      const call = request(
        {
          socketPath,
          path: "/run",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER_BYTES) {
              call.destroy();
              settle(new MediaToolError("failed", null, "runner answer too large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            let answer: MediaRunResponse;
            try {
              answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as MediaRunResponse;
            } catch {
              settle(new MediaToolError("failed", null, "runner answer unreadable"));
              return;
            }
            if (answer.ok) settle(null, answer.stdout);
            else if (answer.code === "refused") {
              // The runner's policy refused the arguments: a programming error, not retried.
              settle(new MediaToolError("failed", null, `refused by runner: ${answer.detail}`));
            } else settle(new MediaToolError(answer.code, answer.exitCode, answer.detail));
          });
          response.on("error", () => {
            settle(new MediaToolError("unavailable", null, "runner connection lost"));
          });
        },
      );
      const timer = setTimeout(() => {
        call.destroy();
        settle(new MediaToolError("timeout"));
      }, options.timeoutMs + ANSWER_SLACK_MS);
      const onAbort = () => {
        call.destroy();
        settle(new MediaToolError("aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      call.on("error", () => {
        settle(new MediaToolError("unavailable", null, "media runner unreachable"));
      });
      call.end(JSON.stringify(body));
    });
}

/** Whether the runner answers its health check within `timeoutMs`. Never throws. */
export function mediaRunnerReady(socketPath: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const call = request(
      { socketPath, path: "/health", method: "GET", timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    call.on("timeout", () => {
      call.destroy();
      resolve(false);
    });
    call.on("error", () => {
      resolve(false);
    });
    call.end();
  });
}

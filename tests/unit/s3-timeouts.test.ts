import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  S3_TIMEOUTS,
  S3StorageService,
  transferDeadlineMs,
  type S3Timeouts,
} from "@/server/storage/s3-storage";

// S3 time limits against a real local HTTP server (the SDK's own handler, no doubles): a
// stalled endpoint fails the request instead of holding it forever, a slow transfer that
// keeps moving is not cut off, and a transfer that never ends hits its deadline.

const KEY =
  "workspaces/11111111-1111-4111-8111-111111111111/logos/22222222-2222-4222-8222-222222222222.png";

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current === undefined) return;
  current.closeAllConnections();
  await new Promise<void>((resolve) => {
    current.close(() => {
      resolve();
    });
  });
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((resolve) => {
    created.listen(0, "127.0.0.1", resolve);
  });
  return (created.address() as AddressInfo).port;
}

const FAST: S3Timeouts = {
  connectionMs: 1_000,
  idleMs: 400,
  transferBaseMs: 60_000,
  minBytesPerSecond: 1024 * 1024,
};

function storage(port: number, timeouts: S3Timeouts = FAST) {
  return new S3StorageService(
    {
      S3_REGION: "us-east-1",
      S3_BUCKET: "flexibx-test",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      S3_FORCE_PATH_STYLE: true,
      S3_ENDPOINT: `http://127.0.0.1:${String(port)}`,
      S3_PUBLIC_BASE_URL: undefined,
    },
    undefined,
    timeouts,
  );
}

async function elapsed(work: Promise<unknown>): Promise<{ ms: number; error: unknown }> {
  const start = Date.now();
  try {
    await work;
    return { ms: Date.now() - start, error: null };
  } catch (error) {
    return { ms: Date.now() - start, error };
  }
}

describe("S3 time limits", () => {
  it("sizes a transfer deadline by the bytes moved", () => {
    expect(transferDeadlineMs(0)).toBe(S3_TIMEOUTS.transferBaseMs);
    // The largest object (a 500 MiB video) at the slowest accepted 1 MiB/s: 530 s.
    expect(transferDeadlineMs(500 * 1024 * 1024)).toBe(530_000);
    expect(S3_TIMEOUTS.connectionMs).toBeGreaterThan(0);
    expect(S3_TIMEOUTS.idleMs).toBeGreaterThan(0);
  });

  it("an endpoint that never answers fails put and getObject on the idle limit", async () => {
    const port = await serve((req) => {
      req.resume(); // read the upload, never answer
    });
    const s3 = storage(port);
    // One at a time: each request is started only when it is awaited.
    for (const work of [
      () => s3.put(KEY, new Uint8Array(16), { contentType: "image/png" }),
      () => s3.getObject(KEY),
    ]) {
      const result = await elapsed(work());
      expect(result.error).toBeInstanceOf(Error);
      expect(result.ms).toBeLessThan(5_000);
    }
  }, 30_000);

  it("a download whose body stalls fails; a slow one that keeps moving completes", async () => {
    const port = await serve((req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "10" });
      if (req.url?.includes("brand-assets") === true) {
        // One byte every 150 ms (under the 400 ms idle limit): about 1.5 s in total.
        let sent = 0;
        const timer = setInterval(() => {
          res.write("a");
          sent += 1;
          if (sent === 10) {
            clearInterval(timer);
            res.end();
          }
        }, 150);
      } else {
        res.write("abc"); // then nothing
      }
    });
    const s3 = storage(port);
    const stalled = await elapsed(s3.getObject(KEY));
    expect(stalled.error).toBeInstanceOf(Error);
    expect(stalled.ms).toBeLessThan(5_000);

    const slowKey = KEY.replace("logos", "brand-assets");
    const slow = await s3.getObject(slowKey).catch((error: unknown) => error);
    expect(slow).toEqual({
      body: new TextEncoder().encode("a".repeat(10)),
      contentType: "image/png",
    });
  }, 30_000);

  it("a download that trickles forever hits its whole-transfer deadline", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      // Never idle, never done.
      const timer = setInterval(() => {
        res.write("a");
      }, 100);
      res.on("close", () => {
        clearInterval(timer);
      });
    });
    // Deadline ≈ 800 ms base (the largest object at an effectively unlimited throughput).
    const s3 = storage(port, { ...FAST, transferBaseMs: 800, minBytesPerSecond: 1e15 });
    const result = await elapsed(s3.getObject(KEY));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.ms).toBeGreaterThanOrEqual(700);
    expect(result.ms).toBeLessThan(5_000);
  }, 30_000);
});

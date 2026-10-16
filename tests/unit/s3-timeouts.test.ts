import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  downloadDeadlineMs,
  S3_TIMEOUTS,
  S3StorageService,
  transferDeadlineMs,
  type S3Timeouts,
} from "@/server/storage/s3-storage";
import { putOrCleanUp, StorageAccessError, StorageTimeoutError } from "@/server/storage/storage";

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

/**
 * Sockets of requests the test server leaves unanswered on purpose: once the client gives
 * up, each must be closed (a successful request's pooled keep-alive socket is not counted).
 */
let held = new Set<Socket>();
const hold = (req: IncomingMessage) => {
  held.add(req.socket);
};
const leaked = () => [...held].filter((socket) => !socket.destroyed).length;

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const created = createServer(handler);
  server = created;
  held = new Set<Socket>();
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
  deleteMs: 60_000,
  accessCheckMs: 60_000,
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

const settle = (ms = 150) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A minimal object store over HTTP: PUT stores the body (then answers or not), GET serves
 * it (optionally trickling), DELETE removes it (or fails). Every request is logged.
 */
function objectStore(options: { readonly answerPut?: boolean; readonly deleteStatus?: number }) {
  const objects = new Map<string, Buffer>();
  const log: string[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    log.push(`${req.method ?? ""} ${path}`);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(path, Buffer.concat(chunks)); // the write happened…
        if (options.answerPut === true)
          res.writeHead(200).end(); // …the answer may not
        else hold(req);
      });
      return;
    }
    if (req.method === "DELETE") {
      const status = options.deleteStatus ?? 204;
      if (status === 204) objects.delete(path);
      res.writeHead(status).end();
      return;
    }
    res.writeHead(404).end();
  };
  return { objects, log, handler };
}

describe("a failed write is cleaned up", () => {
  it("a write stored remotely but never answered: the same key is deleted, the timeout surfaces", async () => {
    const store = objectStore({ answerPut: false });
    const port = await serve(store.handler);
    const s3 = storage(port, { ...FAST, idleMs: 5_000, transferBaseMs: 600 });
    const cleanupErrors: unknown[] = [];
    const error = await putOrCleanUp(
      s3,
      KEY,
      new Uint8Array([1, 2, 3]),
      { contentType: "image/png" },
      (e) => cleanupErrors.push(e),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageTimeoutError);
    expect((error as StorageTimeoutError).operation).toBe("put");
    expect(cleanupErrors).toEqual([]);
    // Only the written key was touched: PUT then DELETE of the same path, nothing else.
    const path = `/flexibx-test/${KEY}`;
    expect(store.log).toEqual([`PUT ${path}`, `DELETE ${path}`]);
    expect(store.objects.size).toBe(0);
    await settle();
    expect(leaked()).toBe(0);
  }, 30_000);

  it("a cleanup that fails never replaces the original error", async () => {
    const store = objectStore({ answerPut: false, deleteStatus: 403 });
    const port = await serve(store.handler);
    const s3 = storage(port, { ...FAST, idleMs: 5_000, transferBaseMs: 600 });
    const cleanupErrors: unknown[] = [];
    const error = await putOrCleanUp(
      s3,
      KEY,
      new Uint8Array([1]),
      { contentType: "image/png" },
      (e) => cleanupErrors.push(e),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageTimeoutError);
    expect(cleanupErrors).toHaveLength(1);
    expect(cleanupErrors[0]).toBeInstanceOf(Error);
    expect(cleanupErrors[0]).not.toBe(error);
    // The object stays (reported, not hidden): the residual risk the docs describe.
    expect(store.objects.size).toBe(1);
  }, 30_000);

  it("a write that succeeds is never deleted; a write refused outright is still cleaned up", async () => {
    const ok = objectStore({ answerPut: true });
    const port = await serve(ok.handler);
    await putOrCleanUp(storage(port), KEY, new Uint8Array([7]), { contentType: "image/png" });
    expect(ok.log.map((line) => line.split(" ")[0])).toEqual(["PUT"]);
    expect(ok.objects.size).toBe(1);

    // A double that rejects the write and the delete synchronously.
    const calls: string[] = [];
    const refused = new Error("refused");
    const fake = {
      put: () => {
        calls.push("put");
        return Promise.reject(refused);
      },
      delete: (key: string, options?: { signal?: AbortSignal }) => {
        calls.push(`delete ${key} ${String(options?.signal instanceof AbortSignal)}`);
        return Promise.reject(new Error("also down"));
      },
    };
    await expect(
      putOrCleanUp(fake as never, KEY, new Uint8Array([1]), { contentType: "image/png" }),
    ).rejects.toBe(refused);
    // The cleanup delete is bounded (it carries a signal).
    expect(calls).toEqual(["put", `delete ${KEY} true`]);
  }, 30_000);
});

describe("download deadlines follow the recorded size", () => {
  it("a known size gets its own deadline, an unknown or invalid one the largest", () => {
    expect(downloadDeadlineMs(1024 * 1024)).toBe(31_000);
    expect(downloadDeadlineMs(0)).toBe(30_000);
    for (const unknown of [undefined, -1, Number.NaN, 1.5]) {
      expect(downloadDeadlineMs(unknown)).toBe(530_000);
    }
    // Never above the largest object a category allows.
    expect(downloadDeadlineMs(10 * 1024 * 1024 * 1024)).toBe(530_000);
  });

  it("a small known object times out on its own deadline; the same transfer completes when larger is expected", async () => {
    // 20 bytes, one every 100 ms (2 s in total), never idle for long.
    const port = await serve((req, res) => {
      hold(req);
      res.writeHead(200, { "content-type": "image/png", "content-length": "20" });
      let sent = 0;
      const timer = setInterval(() => {
        res.write("a");
        sent += 1;
        if (sent === 20) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on("close", () => {
        clearInterval(timer);
      });
    });
    // 300 ms + 1 s per 100 bytes: 20 bytes → 500 ms; 400 bytes → 4.3 s; unknown → huge.
    const s3 = storage(port, {
      ...FAST,
      idleMs: 2_000,
      transferBaseMs: 300,
      minBytesPerSecond: 100,
    });
    const small = await elapsed(s3.getObject(KEY, { expectedBytes: 20 }));
    expect(small.error).toBeInstanceOf(StorageTimeoutError);
    expect((small.error as StorageTimeoutError).operation).toBe("get");
    expect(small.ms).toBeGreaterThanOrEqual(400);
    expect(small.ms).toBeLessThan(1_800);
    await settle();
    expect(leaked()).toBe(0);

    for (const expectedBytes of [400, undefined]) {
      const full = await s3.getObject(KEY, {
        ...(expectedBytes === undefined ? {} : { expectedBytes }),
      });
      expect(full?.body).toHaveLength(20);
    }
  }, 30_000);

  it("a caller's cancellation during the body read is an AbortError and releases the socket", async () => {
    const port = await serve((req, res) => {
      hold(req);
      res.writeHead(200, { "content-type": "image/png" });
      const timer = setInterval(() => {
        res.write("a");
      }, 50);
      res.on("close", () => {
        clearInterval(timer);
      });
    });
    const s3 = storage(port);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);
    const result = await elapsed(s3.getObject(KEY, { signal: controller.signal }));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(StorageTimeoutError);
    expect((result.error as Error).name).toBe("AbortError");
    expect(result.ms).toBeLessThan(2_000);
    await settle();
    expect(leaked()).toBe(0);
  }, 30_000);
});

describe("delete and access check deadlines", () => {
  const silent = (req: IncomingMessage) => {
    hold(req);
    req.resume(); // never answers
  };

  it("a delete that never answers stops at its total deadline, without retrying past it", async () => {
    let requests = 0;
    const port = await serve((req) => {
      requests += 1;
      silent(req);
    });
    const s3 = storage(port, { ...FAST, idleMs: 5_000, deleteMs: 500 });
    const result = await elapsed(s3.delete(KEY));
    expect(result.error).toBeInstanceOf(StorageTimeoutError);
    expect((result.error as StorageTimeoutError).operation).toBe("delete");
    expect(result.ms).toBeGreaterThanOrEqual(400);
    expect(result.ms).toBeLessThan(2_000);
    expect(requests).toBe(1);
    await settle();
    expect(leaked()).toBe(0);
  }, 30_000);

  it("within the deadline the SDK retries an idle delete (3 attempts), then gives up", async () => {
    let requests = 0;
    const port = await serve((req) => {
      requests += 1;
      silent(req);
    });
    const s3 = storage(port, { ...FAST, idleMs: 200, deleteMs: 20_000 });
    const result = await elapsed(s3.delete(KEY));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(StorageTimeoutError); // the idle limit, per attempt
    expect(requests).toBe(3);
    expect(result.ms).toBeLessThan(5_000);
    await settle();
    expect(leaked()).toBe(0);
  }, 30_000);

  it("a caller's shorter signal still decides first (retention's 30 s), as an AbortError", async () => {
    const port = await serve(silent);
    const s3 = storage(port, { ...FAST, idleMs: 5_000, deleteMs: 5_000 });
    const result = await elapsed(s3.delete(KEY, { signal: AbortSignal.timeout(300) }));
    expect(result.error).not.toBeInstanceOf(StorageTimeoutError);
    expect(result.ms).toBeLessThan(2_000);
  }, 30_000);

  it("an access check that never answers fails as a timeout at its deadline", async () => {
    const port = await serve(silent);
    const s3 = storage(port, { ...FAST, idleMs: 5_000, accessCheckMs: 500 });
    const result = await elapsed(s3.checkAccess());
    expect(result.error).toBeInstanceOf(StorageAccessError);
    expect((result.error as StorageAccessError).failure).toBe("timeout");
    expect(result.ms).toBeLessThan(2_000);
    expect(S3_TIMEOUTS.deleteMs).toBeGreaterThan(30_000); // above retention's own limit
    expect(S3_TIMEOUTS.accessCheckMs).toBeGreaterThan(10_000); // above the admin check's
  }, 30_000);
});

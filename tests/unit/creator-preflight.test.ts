// The staging preflight (Pass 10) against the in-memory store: a host and bucket that
// pass, then each failure the checks exist to catch — a public bucket, long-lived links,
// a missing encoder, no CORS or lifecycle rule, the simulator in production — and probe
// objects that are always cleaned up. No network, no provider.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { limitsFromEnv } from "@/server/creator/config";
import {
  PREFLIGHT_WORKSPACE_ID,
  runPreflight,
  type PreflightDeps,
  type PreflightHttp,
} from "@/server/creator/preflight";
import { retentionPolicyFromEnv } from "@/server/creator/retention";
import { EnvValidationError, parseCreatorEnv } from "@/server/env-schema";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import { S3StorageService, type BucketRules } from "@/server/storage/s3-storage";

const dir = mkdtempSync(join(tmpdir(), "creator-preflight-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Signed links of the in-memory store, with a signature and an expiry like S3's. */
class SignedMemoryStorage extends MemoryStorageService {
  linkSeconds = 120;
  override async getSignedDownloadUrl(key: string): Promise<string> {
    const url = await super.getSignedDownloadUrl(key);
    return `${url}?X-Amz-Expires=${String(this.linkSeconds)}&X-Amz-Signature=abc`;
  }
}

/** Serves memory:// URLs: signed reads return the object; unsigned ones are refused. */
function memoryHttp(storage: MemoryStorageService, options: { publicReads?: boolean } = {}) {
  const http: PreflightHttp = async (url, init) => {
    const empty = new Uint8Array();
    if (init.method === "PUT" && url.startsWith("memory://part/")) {
      const [uploadId, part, length] = url.slice("memory://part/".length).split("/");
      const etag = storage.putPart(
        uploadId ?? "",
        Number(part),
        init.body ?? empty,
        Number(length),
      );
      return { status: 200, body: empty, etag };
    }
    if (init.method === "GET" && url.startsWith("memory://download/")) {
      const signed = url.includes("X-Amz-Signature=");
      if (!signed && options.publicReads !== true) return { status: 403, body: empty, etag: null };
      const key = url.slice("memory://download/".length).split("?")[0] ?? "";
      const object = await storage.getObject(key);
      return object === null
        ? { status: 404, body: empty, etag: null }
        : { status: 200, body: object.body, etag: null };
    }
    return { status: 400, body: empty, etag: null };
  };
  return http;
}

const GOOD_RULES: BucketRules = {
  cors: [
    {
      allowedOrigins: ["https://staging.example.com"],
      allowedMethods: ["PUT"],
      allowedHeaders: ["content-type"],
    },
  ],
  lifecycle: [{ enabled: true, abortIncompleteMultipartDays: 3 }],
};

const FFMPEG_OUTPUT: Record<string, string> = {
  "-version": "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023",
  "-encoders": " V....D libx264  H.264\n A....D aac  AAC\n A....D libopus  Opus\n",
  "-filters": " ... subtitles  V->V  Render text subtitles\n",
};

function deps(overrides: Partial<PreflightDeps> = {}) {
  const storage = new SignedMemoryStorage();
  const base: PreflightDeps = {
    tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", threads: 1 },
    runTool: (_binary, args) => Promise.resolve({ stdout: FFMPEG_OUTPUT[args[1] ?? ""] ?? "" }),
    workDir: dir,
    minFreeBytes: 1,
    storage,
    readBucketRules: () => Promise.resolve(GOOD_RULES),
    http: memoryHttp(storage),
    appOrigin: "https://staging.example.com",
    provider: { configured: "disabled", externalApproved: false, nodeEnv: "production" },
    ...overrides,
  };
  return { deps: base, storage };
}

const statusOf = (results: readonly { name: string; status: string }[], name: string) =>
  results.find((entry) => entry.name === name)?.status;

describe("Creator Studio staging preflight", () => {
  it("passes a correct host and bucket, and leaves no probe object behind", async () => {
    const { deps: input, storage } = deps();
    const { ok, results } = await runPreflight(input);
    expect(results.filter((entry) => entry.status !== "pass")).toEqual([]);
    expect(ok).toBe(true);
    expect(results.map((entry) => entry.name)).toEqual([
      "ffmpeg_version",
      "ffmpeg_encoders",
      "ffmpeg_subtitles",
      "ffprobe",
      "scratch_writable",
      "scratch_free_space",
      "storage_write",
      "signed_download",
      "bucket_private",
      "link_lifetime",
      "storage_delete",
      "multipart_upload",
      "bucket_cors",
      "bucket_lifecycle",
      "ai_provider",
    ]);
    // Only probe objects of the reserved workspace were written, and all were deleted.
    const keys = [...storage.objects.keys(), ...storage.uploads.keys()];
    expect(keys).toEqual([]);
    expect(PREFLIGHT_WORKSPACE_ID).toBe("00000000-0000-0000-0000-000000000000");
    // Reasons only: no storage key or URL is printed.
    expect(JSON.stringify(results)).not.toMatch(/workspaces\/|memory:\/\//);
  });

  it("fails a bucket readable without a signature, and links that live too long", async () => {
    const storage = new SignedMemoryStorage();
    storage.linkSeconds = 3600;
    const { deps: input } = deps({ storage, http: memoryHttp(storage, { publicReads: true }) });
    const { ok, results } = await runPreflight(input);
    expect(ok).toBe(false);
    expect(statusOf(results, "bucket_private")).toBe("fail");
    expect(statusOf(results, "link_lifetime")).toBe("fail");
  });

  it("fails FFmpeg without the encoders, subtitles or version the worker needs", async () => {
    const { deps: input } = deps({
      runTool: (_binary, args) =>
        Promise.resolve({
          stdout:
            args[1] === "-version"
              ? "ffmpeg version 4.4.2"
              : args[1] === "-encoders"
                ? " V....D libx264 H.264\n"
                : "",
        }),
    });
    const { ok, results } = await runPreflight(input);
    expect(ok).toBe(false);
    expect(statusOf(results, "ffmpeg_version")).toBe("fail");
    expect(results.find((entry) => entry.name === "ffmpeg_encoders")?.detail).toBe(
      "missing: aac, libopus",
    );
    expect(statusOf(results, "ffmpeg_subtitles")).toBe("fail");
  });

  it("fails a scratch disk smaller than the largest job and an unwritable directory", async () => {
    const { deps: input } = deps({
      workDir: join(dir, "does-not-exist"),
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    const { results } = await runPreflight(input);
    expect(statusOf(results, "scratch_writable")).toBe("fail");
    const { deps: big } = deps({ minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(statusOf((await runPreflight(big)).results, "scratch_free_space")).toBe("fail");
  });

  it("checks the bucket's CORS and lifecycle rules, or says they must be checked by hand", async () => {
    const none = deps({
      readBucketRules: () => Promise.resolve({ cors: null, lifecycle: null }),
    });
    const { results } = await runPreflight(none.deps);
    expect(statusOf(results, "bucket_cors")).toBe("fail");
    expect(statusOf(results, "bucket_lifecycle")).toBe("fail");

    const wrongOrigin = deps({
      readBucketRules: () =>
        Promise.resolve({
          cors: [
            {
              allowedOrigins: ["https://other.example.com"],
              allowedMethods: ["PUT"],
              allowedHeaders: ["*"],
            },
          ],
          lifecycle: [{ enabled: false, abortIncompleteMultipartDays: 1 }],
        }),
    });
    const second = (await runPreflight(wrongOrigin.deps)).results;
    expect(statusOf(second, "bucket_cors")).toBe("fail");
    expect(statusOf(second, "bucket_lifecycle")).toBe("fail");

    const wildcard = deps({
      readBucketRules: () =>
        Promise.resolve({
          cors: [{ allowedOrigins: ["*"], allowedMethods: ["PUT"], allowedHeaders: ["*"] }],
          lifecycle: [{ enabled: true, abortIncompleteMultipartDays: 30 }],
        }),
    });
    const third = (await runPreflight(wildcard.deps)).results;
    expect(statusOf(third, "bucket_cors")).toBe("warn");
    expect(statusOf(third, "bucket_lifecycle")).toBe("warn");

    const unreadable = deps({ readBucketRules: null });
    const fourth = (await runPreflight(unreadable.deps)).results;
    expect(statusOf(fourth, "bucket_cors")).toBe("skip");
  });

  it("reports the provider from configuration only, and refuses the simulator in production", async () => {
    let calls = 0;
    const counting: PreflightHttp = (url, init) => {
      calls += 1;
      return deps().deps.http(url, init);
    };
    const simulated = deps({
      provider: { configured: "simulated", externalApproved: false, nodeEnv: "production" },
    });
    expect(statusOf((await runPreflight(simulated.deps)).results, "ai_provider")).toBe("fail");
    const openai = deps({
      storage: null,
      http: counting,
      provider: { configured: "openai", externalApproved: true, nodeEnv: "production" },
    });
    const result = await runPreflight(openai.deps);
    expect(statusOf(result.results, "ai_provider")).toBe("warn");
    // Without storage nothing is requested at all: the provider is never contacted.
    expect(calls).toBe(0);
    const unapproved = deps({
      provider: { configured: "openai", externalApproved: false, nodeEnv: "production" },
    });
    expect(statusOf((await runPreflight(unapproved.deps)).results, "ai_provider")).toBe("fail");
  });
});

describe("reading the bucket's rules (local S3 stand-in)", () => {
  async function bucket(answers: { cors: string | null; lifecycle: string | null }) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = url.searchParams.has("cors") ? answers.cors : answers.lifecycle;
      const missing = url.searchParams.has("cors")
        ? "NoSuchCORSConfiguration"
        : "NoSuchLifecycleConfiguration";
      res.writeHead(body === null ? 404 : 200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>${
          body ?? `<Error><Code>${missing}</Code><Message>none</Message></Error>`
        }`,
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const s3 = new S3StorageService({
      S3_REGION: "us-east-1",
      S3_BUCKET: "flexibx-staging",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
      S3_FORCE_PATH_STYLE: true,
      S3_ENDPOINT: `http://127.0.0.1:${String(port)}`,
      S3_PUBLIC_BASE_URL: undefined,
    });
    return {
      s3,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    };
  }

  it("returns the CORS and lifecycle rules the preflight checks", async () => {
    const { s3, close } = await bucket({
      cors:
        "<CORSConfiguration><CORSRule><AllowedOrigin>https://staging.example.com</AllowedOrigin>" +
        "<AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader>" +
        "</CORSRule></CORSConfiguration>",
      lifecycle:
        "<LifecycleConfiguration><Rule><ID>abort</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter>" +
        "<AbortIncompleteMultipartUpload><DaysAfterInitiation>3</DaysAfterInitiation>" +
        "</AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>",
    });
    try {
      expect(await s3.readBucketRules()).toEqual(GOOD_RULES);
    } finally {
      await close();
    }
  });

  it("a bucket without rules reads as none (not as an error)", async () => {
    const { s3, close } = await bucket({ cors: null, lifecycle: null });
    try {
      expect(await s3.readBucketRules()).toEqual({ cors: null, lifecycle: null });
    } finally {
      await close();
    }
  });
});

describe("Pass 10 configuration", () => {
  it("bounds the per-workspace job limit and keeps retention off unless set", () => {
    const base = { NODE_ENV: "test" };
    const env = parseCreatorEnv(base);
    expect(env.CREATOR_MAX_RUNNING_JOBS).toBe(2);
    expect(retentionPolicyFromEnv(env)).toEqual({ sourceDays: null, exportDays: null });
    expect(
      limitsFromEnv(parseCreatorEnv({ ...base, CREATOR_MAX_RUNNING_JOBS: "5" })),
    ).toMatchObject({ maxRunningJobsPerWorkspace: 5 });
    for (const value of ["0", "21", "1.5"]) {
      expect(() => parseCreatorEnv({ ...base, CREATOR_MAX_RUNNING_JOBS: value })).toThrow(
        EnvValidationError,
      );
    }
    expect(
      retentionPolicyFromEnv(
        parseCreatorEnv({
          ...base,
          CREATOR_RETENTION_SOURCE_DAYS: "90",
          CREATOR_RETENTION_EXPORT_DAYS: "30",
        }),
      ),
    ).toEqual({ sourceDays: 90, exportDays: 30 });
    expect(() => parseCreatorEnv({ ...base, CREATOR_RETENTION_SOURCE_DAYS: "0" })).toThrow(
      EnvValidationError,
    );
  });
});

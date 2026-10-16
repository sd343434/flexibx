import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { EnvValidationError, parseWasabiCredentials } from "@/server/env-schema";
import { resolveWasabi } from "@/server/storage/providers";
import { classifyAccessError } from "@/server/storage/s3-storage";
import { StorageAccessError } from "@/server/storage/storage";
import {
  createWasabiStorage,
  isWasabiEndpoint,
  wasabiHostsForRegion,
  wasabiSettingsSchema,
} from "@/server/storage/wasabi-storage";

// Provider-independent storage: the Wasabi adapter, its settings validation, access-error
// classification and the credential rules. No network: the S3 client is a test double.

const KEY_ID = "TESTKEYID0123456789AB";
const SECRET = ["test", "secret", "0123456789abcdefghijklmnopqrstuv"].join("-");
const SETTINGS = {
  region: "xx-test-1",
  endpoint: "https://s3.xx-test-1.wasabisys.com",
  bucket: "flexibx-test",
};

const issues = (input: unknown) => {
  const result = wasabiSettingsSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
};

describe("Wasabi settings validation", () => {
  it("accepts complete settings and normalises the endpoint to its origin", () => {
    expect(
      wasabiSettingsSchema.parse({ ...SETTINGS, endpoint: "https://s3.xx-test-1.wasabisys.com/" }),
    ).toEqual(SETTINGS);
    expect(wasabiSettingsSchema.parse({ ...SETTINGS, region: " XX-Test-1 " }).region).toBe(
      "xx-test-1",
    );
  });

  it.each([
    "http://s3.xx-test-1.wasabisys.com",
    "https://s3.xx-test-1.wasabisys.com:8443",
    "https://user:pass@s3.xx-test-1.wasabisys.com",
    "https://s3.xx-test-1.wasabisys.com/bucket",
    "https://s3.xx-test-1.wasabisys.com/?x=1",
    "https://s3.xx-test-1.wasabisys.com#x",
    "https://wasabisys.com.attacker.example",
    "https://evilwasabisys.com",
    "https://169.254.169.254",
    "not a url",
    "",
  ])("rejects a non-Wasabi or unsafe endpoint: %s", (endpoint) => {
    expect(isWasabiEndpoint(endpoint)).toBe(false);
    expect(issues({ ...SETTINGS, endpoint })).toEqual(["endpoint"]);
  });

  it.each([
    // Wasabi's console, IAM and STS hosts and the bare domain are not S3 service URLs.
    "https://console.wasabisys.com",
    "https://iam.wasabisys.com",
    "https://sts.wasabisys.com",
    "https://wasabisys.com",
    "https://s3.nl-1.wasabisys.com",
    "https://evil.s3.xx-test-1.wasabisys.com",
  ])("rejects a Wasabi host that is not an S3 service URL: %s", (endpoint) => {
    expect(isWasabiEndpoint(endpoint)).toBe(false);
    expect(issues({ ...SETTINGS, endpoint })).toEqual(["endpoint"]);
  });

  it("requires the endpoint documented for the region entered", () => {
    const mismatch = wasabiSettingsSchema.safeParse({
      region: "eu-central-1",
      endpoint: "https://s3.us-east-1.wasabisys.com",
      bucket: "flexibx-test",
    });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["endpoint"], "endpoint_region_mismatch"],
    ]);
    expect(wasabiHostsForRegion("eu-central-1")).toEqual(["s3.eu-central-1.wasabisys.com"]);
    // us-east-1: the regional form and the original s3.wasabisys.com.
    for (const endpoint of ["https://s3.us-east-1.wasabisys.com", "https://s3.wasabisys.com"]) {
      expect(
        wasabiSettingsSchema.parse({ region: "us-east-1", endpoint, bucket: "flexibx-test" })
          .endpoint,
      ).toBe(endpoint);
    }
    expect(
      issues({ region: "eu-central-1", endpoint: "https://s3.wasabisys.com", bucket: "abc" }),
    ).toEqual(["endpoint"]);
  });

  it.each(["", "us", "us-east", "us_east_1", "us-east-123", "../x"])(
    "rejects region %j",
    (region) => {
      expect(issues({ ...SETTINGS, region })).toEqual(["region"]);
    },
  );

  it.each(["ab", "a".repeat(64), "-bucket", "bucket-", "bu..cket", "10.0.0.1", "bu/cket", "b_c"])(
    "rejects bucket %j",
    (bucket) => {
      expect(issues({ ...SETTINGS, bucket })).toEqual(["bucket"]);
    },
  );

  it("rejects unknown fields (no credentials through the form)", () => {
    expect(issues({ ...SETTINGS, accessKeyId: KEY_ID })).not.toEqual([]);
  });
});

describe("Wasabi credentials (environment only)", () => {
  it("returns null when either key is missing", () => {
    expect(parseWasabiCredentials({})).toBeNull();
    expect(parseWasabiCredentials({ WASABI_ACCESS_KEY_ID: KEY_ID })).toBeNull();
    expect(parseWasabiCredentials({ WASABI_SECRET_ACCESS_KEY: SECRET })).toBeNull();
  });

  it("returns both keys when present and well-formed", () => {
    expect(
      parseWasabiCredentials({ WASABI_ACCESS_KEY_ID: KEY_ID, WASABI_SECRET_ACCESS_KEY: SECRET }),
    ).toEqual({ accessKeyId: KEY_ID, secretAccessKey: SECRET });
  });

  it("rejects malformed keys without echoing them", () => {
    let caught: unknown;
    try {
      parseWasabiCredentials({ WASABI_ACCESS_KEY_ID: "short", WASABI_SECRET_ACCESS_KEY: SECRET });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    expect((caught as Error).message).not.toContain(SECRET);
  });
});

describe("resolveWasabi", () => {
  const credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET };
  const row = {
    writeProvider: "LEGACY_S3" as const,
    wasabiRegion: SETTINGS.region,
    wasabiEndpoint: SETTINGS.endpoint,
    wasabiBucket: SETTINGS.bucket,
  };

  it("is ready only with complete settings and both keys", () => {
    expect(resolveWasabi(row, credentials)).toMatchObject({ state: "ready", settings: SETTINGS });
  });

  it("names what is missing (never the values)", () => {
    expect(
      resolveWasabi({ ...row, wasabiRegion: null, wasabiEndpoint: null, wasabiBucket: null }, null),
    ).toEqual({ state: "incomplete", missing: ["region", "endpoint", "bucket", "credentials"] });
    expect(resolveWasabi(row, null)).toEqual({ state: "incomplete", missing: ["credentials"] });
    expect(resolveWasabi({ ...row, wasabiEndpoint: "https://example.com" }, credentials)).toEqual({
      state: "incomplete",
      missing: ["endpoint"],
    });
  });
});

describe("classifyAccessError", () => {
  const sdkError = (name: string, status?: number) =>
    Object.assign(new Error(`secret detail https://s3.example ${name}`), {
      name,
      ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
    });

  it.each([
    [sdkError("AbortError"), "timeout"],
    [sdkError("TimeoutError"), "timeout"],
    [sdkError("Forbidden", 403), "access_denied"],
    [sdkError("NotFound", 404), "bucket_not_found"],
    [sdkError("PermanentRedirect", 301), "wrong_region"],
    [Object.assign(new Error("x"), { code: "ENOTFOUND" }), "unreachable"],
    [Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "unreachable"],
    [sdkError("InternalError", 500), "failed"],
    ["not an error", "failed"],
    [null, "failed"],
  ])("maps %o to %s", (error, failure) => {
    expect(classifyAccessError(error)).toBe(failure);
  });
});

describe("createWasabiStorage", () => {
  /** A recording stand-in for the AWS SDK client. */
  function fakeClient(respond: (command: { constructor: { name: string } }) => unknown) {
    const sent: { name: string; input: Record<string, unknown>; abortSignal?: unknown }[] = [];
    const client = {
      send: (
        command: { constructor: { name: string }; input: Record<string, unknown> },
        options?: { abortSignal?: unknown },
      ) => {
        sent.push({
          name: command.constructor.name,
          input: command.input,
          abortSignal: options?.abortSignal,
        });
        return Promise.resolve().then(() => respond(command));
      },
    } as unknown as S3Client;
    return { client, sent };
  }

  const credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET };

  it("uses the configured bucket for every operation", async () => {
    const { client, sent } = fakeClient(() => ({}));
    const storage = createWasabiStorage(SETTINGS, credentials, client);
    const key =
      "workspaces/6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10/logos/6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10.png";
    await storage.put(key, new Uint8Array([1]), { contentType: "image/png" });
    await storage.delete(key);
    await storage.checkAccess();
    expect(sent.map((call) => [call.name, call.input.Bucket])).toEqual([
      ["PutObjectCommand", "flexibx-test"],
      ["DeleteObjectCommand", "flexibx-test"],
      ["HeadBucketCommand", "flexibx-test"],
    ]);
  });

  it("is private: no public URLs", () => {
    const { client } = fakeClient(() => ({}));
    const storage = createWasabiStorage(SETTINGS, credentials, client);
    expect(
      storage.publicUrl(
        "workspaces/6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10/logos/6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10.png",
      ),
    ).toBeNull();
  });

  it("builds a real SDK client for the Wasabi endpoint and region, path-style", async () => {
    const storage = createWasabiStorage(SETTINGS, credentials);
    const client = (storage as unknown as { client: S3Client }).client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("s3.xx-test-1.wasabisys.com");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.region()).toBe("xx-test-1");
    expect(client.config.forcePathStyle).toBe(true);
  });

  it("passes the abort signal and reports a classified failure only", async () => {
    const { client, sent } = fakeClient(() => {
      throw Object.assign(new Error("AccessDenied for key " + KEY_ID), {
        name: "Forbidden",
        $metadata: { httpStatusCode: 403 },
      });
    });
    const storage = createWasabiStorage(SETTINGS, credentials, client);
    const controller = new AbortController();
    const error = await storage
      .checkAccess({ signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageAccessError);
    expect((error as StorageAccessError).failure).toBe("access_denied");
    expect((error as Error).message).not.toContain(KEY_ID);
    // The SDK gets the caller's signal combined with the check's own deadline: cancelling
    // the caller cancels the request.
    const passed = sent[0]?.abortSignal as AbortSignal | undefined;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed?.aborted).toBe(false);
    controller.abort();
    expect(passed?.aborted).toBe(true);
  });
});

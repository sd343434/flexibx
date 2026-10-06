import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import { S3StorageService } from "@/server/storage/s3-storage";
import {
  assertKeyBelongsToWorkspace,
  assertUploadAllowed,
  buildWorkspaceKey,
  parseWorkspaceKey,
  resolveTtl,
  STORAGE_CATEGORIES,
} from "@/server/storage/storage";

const WS = "6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10";
const OTHER = "11111111-1111-4111-8111-111111111111";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : "UNKNOWN";
  }
  return undefined;
}

describe("storage keys", () => {
  it("builds server-generated, workspace-prefixed keys", () => {
    const key = buildWorkspaceKey(WS, "logos", "image/png");
    expect(key).toMatch(new RegExp(`^workspaces/${WS}/logos/[0-9a-f-]{36}\\.png$`));
    expect(parseWorkspaceKey(key)).toEqual({ workspaceId: WS, category: "logos" });
    expect(buildWorkspaceKey(WS, "logos", "image/png")).not.toBe(key);
  });

  it("rejects invalid workspace ids and traversal attempts", () => {
    expect(codeOf(() => buildWorkspaceKey("../etc", "logos", "image/png"))).toBe(
      "VALIDATION_FAILED",
    );
    expect(parseWorkspaceKey(`workspaces/${WS}/logos/../../${OTHER}/x.png`)).toBeNull();
    expect(
      parseWorkspaceKey(`workspaces/${WS}/secrets/6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10.png`),
    ).toBeNull();
  });

  it("enforces key ownership", () => {
    const key = buildWorkspaceKey(WS, "product-images", "image/webp");
    expect(
      codeOf(() => {
        assertKeyBelongsToWorkspace(key, WS);
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        assertKeyBelongsToWorkspace(key, OTHER);
      }),
    ).toBe("NOT_FOUND");
    expect(
      codeOf(() => {
        assertKeyBelongsToWorkspace("anything", WS);
      }),
    ).toBe("NOT_FOUND");
  });
});

describe("upload rules", () => {
  it("allows only category content types within the size limit", () => {
    expect(
      codeOf(() => {
        assertUploadAllowed("logos", "image/svg+xml", 1024);
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        assertUploadAllowed("product-images", "image/svg+xml", 1024);
      }),
    ).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(
      codeOf(() => {
        assertUploadAllowed("logos", "image/png", STORAGE_CATEGORIES.logos.maxBytes + 1);
      }),
    ).toBe("PAYLOAD_TOO_LARGE");
    expect(
      codeOf(() => {
        assertUploadAllowed("logos", "image/png", 0);
      }),
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  it("clamps signed URL lifetimes", () => {
    expect(resolveTtl()).toBe(300);
    expect(resolveTtl(0)).toBe(1);
    expect(resolveTtl(999_999)).toBe(3600);
  });
});

describe("MemoryStorageService", () => {
  it("stores and deletes objects under valid keys only", async () => {
    const storage = new MemoryStorageService();
    const key = buildWorkspaceKey(WS, "logos", "image/png");
    await storage.put(key, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    expect(storage.objects.get(key)?.body).toEqual(new Uint8Array([1, 2, 3]));
    await storage.delete(key);
    expect(storage.objects.has(key)).toBe(false);
    await expect(
      storage.put("../../x", new Uint8Array(), { contentType: "image/png" }),
    ).rejects.toThrow(AppError);
  });
});

describe("S3StorageService", () => {
  const s3 = new S3StorageService({
    S3_REGION: "us-east-1",
    S3_BUCKET: "flexibx-test",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_FORCE_PATH_STYLE: true,
    S3_ENDPOINT: "http://localhost:9000",
    S3_PUBLIC_BASE_URL: undefined,
  });

  it("signs uploads with content type and length so limits cannot be bypassed", async () => {
    const key = buildWorkspaceKey(WS, "logos", "image/png");
    const upload = await s3.getSignedUploadUrl(key, {
      category: "logos",
      contentType: "image/png",
      contentLength: 2048,
    });
    const url = new URL(upload.url);
    expect(url.pathname).toBe(`/flexibx-test/${key}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(upload.headers).toEqual({ "content-type": "image/png", "content-length": "2048" });
    expect(url.toString()).not.toContain("test-secret-key");
  });

  it("rejects oversized or disallowed signed uploads before signing", async () => {
    const key = buildWorkspaceKey(WS, "logos", "image/png");
    await expect(
      s3.getSignedUploadUrl(key, {
        category: "logos",
        contentType: "image/png",
        contentLength: 50 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("has no public URL for a private bucket", () => {
    expect(s3.publicUrl(buildWorkspaceKey(WS, "logos", "image/png"))).toBeNull();
  });
});

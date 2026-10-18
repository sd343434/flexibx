// Provider-independent storage on the real database: per-object provider routing, the
// platform storage settings (Wasabi location lock), the guarded write-provider switch
// (failover, compare-and-set), uploads racing a location change, the immutability and
// required-provider rules, and retention deleting through the router (deadline, once-per-
// run resolution). Storage services are in-memory test doubles: no network, no paid
// storage operation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

import { AppError } from "@/server/errors/app-error";
import { MemoryMailer } from "@/server/mail/mailer";
import { deleteMedia, readMedia, uploadMedia } from "@/server/marketing/media-service";
import { MemoryStorageService } from "@/server/storage/memory-storage";
import { createStorageRouter } from "@/server/storage/providers";
import {
  buildWorkspaceKey,
  StorageAccessError,
  StorageTimeoutError,
  type StorageAccessFailure,
  type StorageService,
  type StorageWriteTarget,
} from "@/server/storage/storage";
import {
  changeWriteProvider,
  checkProviderConnection,
  getStorageAdminView,
  saveWasabiSettings,
} from "@/server/storage/storage-admin";
import { runVideoRetention } from "@/server/videos/retention-job";
import { recordGeneratedVideo } from "@/server/videos/video-service";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const { system, db } = createTestDb();

const CREDENTIALS = {
  accessKeyId: "TESTKEYID0123456789AB",
  secretAccessKey: ["test", "secret", "0123456789abcdefghijklmnopqrstuv"].join("-"),
};
const SETTINGS = {
  region: "xx-test-1",
  endpoint: "https://s3.xx-test-1.wasabisys.com",
  bucket: "flexibx-test",
};

/** A memory store whose access check can be made to fail. */
class CheckableStorage extends MemoryStorageService {
  failure: StorageAccessFailure | null = null;
  checks = 0;
  override checkAccess(): Promise<void> {
    this.checks += 1;
    return this.failure === null
      ? Promise.resolve()
      : Promise.reject(new StorageAccessError(this.failure));
  }
}

let legacy: CheckableStorage;
let wasabi: CheckableStorage;
let credentials: typeof CREDENTIALS | null;

const router = () =>
  createStorageRouter({
    system,
    legacy: () => legacy,
    wasabiCredentials: () => credentials,
    makeWasabi: () => wasabi,
  });

beforeEach(async () => {
  await resetDatabase(system);
  await system.$executeRaw`DELETE FROM platform_storage_settings`;
  legacy = new CheckableStorage();
  wasabi = new CheckableStorage();
  credentials = CREDENTIALS;
});

afterAll(async () => {
  await system.$executeRaw`DELETE FROM platform_storage_settings`;
  await system.$disconnect();
});

async function admin() {
  const user = await system.user.create({
    data: { email: `admin-${Date.now().toString(36)}@example.com`, name: "Admin" },
  });
  return { userId: user.id };
}

const png = () => {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 2);
  new DataView(bytes.buffer).setUint32(20, 1);
  return { name: "cup.png", size: bytes.byteLength, bytes: () => Promise.resolve(bytes) };
};

async function configureWasabi() {
  const by = await admin();
  expect(await saveWasabiSettings(db, by, SETTINGS)).toMatchObject({
    outcome: "saved",
  });
  return by;
}

async function switchTo(target: "LEGACY_S3" | "WASABI") {
  return changeWriteProvider(system, db, router(), await admin(), {
    target,
    confirmation: target,
  });
}

async function codeOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  return error instanceof AppError ? error.code : error;
}

const MIGRATIONS = join(import.meta.dirname, "../../prisma/migrations");
const migration = (name: string) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");

describe("legacy objects and required provider", () => {
  it("the default write target is LEGACY_S3", async () => {
    const view = await getStorageAdminView(system, router());
    expect(view.writeProvider).toBe("LEGACY_S3");
    const target = await router().writeTarget();
    expect(target.provider).toBe("LEGACY_S3");
    expect(target.storage).toBe(legacy);
  });

  it("backfills pre-existing rows to LEGACY_S3, then requires an explicit provider", async () => {
    // The two migrations' statements for both object tables, exactly as written...
    const flat = (sql: string) => sql.replace(/\s+/g, " ");
    const backfill = flat(migration("20261010090000_storage_providers"));
    const required = flat(migration("20261010100000_storage_provider_required"));
    for (const table of ["media_assets", "generated_video_files"]) {
      expect(backfill, table).toContain(
        `ALTER TABLE "${table}" ADD COLUMN "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LEGACY_S3';`,
      );
      expect(required, table).toContain(
        `ALTER TABLE "${table}" ALTER COLUMN "storage_provider" DROP DEFAULT;`,
      );
    }
    // ...replayed on a scratch table holding rows that predate provider tracking, in a
    // transaction that is rolled back.
    const outcome = await system
      .$transaction(async (tx) => {
        await tx.$executeRaw`CREATE TEMP TABLE "scratch_objects" ("id" int) ON COMMIT DROP`;
        await tx.$executeRaw`INSERT INTO "scratch_objects" VALUES (1), (2), (3)`;
        await tx.$executeRaw`
          ALTER TABLE "scratch_objects"
            ADD COLUMN "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LEGACY_S3'`;
        const providers = await tx.$queryRaw<{ provider: string }[]>`
          SELECT "storage_provider"::text AS "provider" FROM "scratch_objects" ORDER BY "id"`;
        await tx.$executeRaw`ALTER TABLE "scratch_objects" ALTER COLUMN "storage_provider" DROP DEFAULT`;
        await tx.$executeRaw`SAVEPOINT omitted`;
        const omitted = await tx.$executeRaw`INSERT INTO "scratch_objects" ("id") VALUES (4)`.then(
          () => "inserted",
          (error: unknown) => String(error),
        );
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT omitted`;
        throw Object.assign(new Error("rollback"), { providers, omitted });
      })
      .catch((error: unknown) => error as { providers: unknown; omitted: string });
    expect(outcome.providers).toEqual([
      { provider: "LEGACY_S3" },
      { provider: "LEGACY_S3" },
      { provider: "LEGACY_S3" },
    ]);
    expect(outcome.omitted).toMatch(/23502|not-null|null value/);
  });

  it("the live columns have no default: an omitted provider is refused, never mislabelled", async () => {
    const columns = await system.$queryRaw<
      { table_name: string; column_default: string | null; is_nullable: string }[]
    >`
      SELECT table_name, column_default, is_nullable FROM information_schema.columns
      WHERE column_name = 'storage_provider' AND table_schema = 'public' ORDER BY table_name`;
    expect(columns).toEqual([
      // An export has no file until it is READY; a CHECK requires the provider then.
      { table_name: "creator_exports", column_default: null, is_nullable: "YES" },
      { table_name: "creator_sources", column_default: null, is_nullable: "NO" },
      { table_name: "generated_video_files", column_default: null, is_nullable: "NO" },
      { table_name: "media_assets", column_default: null, is_nullable: "NO" },
    ]);
    const ctx = await createTenant(system);
    const key = buildWorkspaceKey(ctx.workspaceId, "content-media", "image/png");
    await expect(
      system.$executeRaw`
        INSERT INTO media_assets (workspace_id, filename, content_type, size_bytes, storage_key)
        VALUES (${ctx.workspaceId}::uuid, 'x.png', 'image/png', 1, ${key})`,
    ).rejects.toThrow(/storage_provider/);
    // Through Prisma too (the field is required in the generated types; forced here).
    await expect(
      system.mediaAsset.create({
        data: {
          workspaceId: ctx.workspaceId,
          filename: "x.png",
          contentType: "image/png",
          sizeBytes: 1,
          storageKey: key,
        } as never,
      }),
    ).rejects.toThrow();
    expect(await system.mediaAsset.count()).toBe(0);
  });
});

describe("per-object routing", () => {
  it("records the write provider and keeps reading and deleting each object where it is", async () => {
    const ctx = await createTenant(system);
    const before = await uploadMedia(db, await router().writeTarget(), ctx, png());
    await configureWasabi();
    expect(await switchTo("WASABI")).toEqual({
      outcome: "changed",
      from: "LEGACY_S3",
      to: "WASABI",
      warnings: [],
    });
    const after = await uploadMedia(db, await router().writeTarget(), ctx, png());

    const rows = await system.mediaAsset.findMany({
      select: { id: true, storageProvider: true, storageKey: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(before.assetId)?.storageProvider).toBe("LEGACY_S3");
    expect(byId.get(after.assetId)?.storageProvider).toBe("WASABI");
    expect(legacy.objects.has(byId.get(before.assetId)?.storageKey ?? "")).toBe(true);
    expect(wasabi.objects.has(byId.get(after.assetId)?.storageKey ?? "")).toBe(true);
    expect(wasabi.objects.has(byId.get(before.assetId)?.storageKey ?? "")).toBe(false);

    // The legacy object is still readable after the switch: nothing was moved.
    expect((await readMedia(db, router(), ctx, before.assetId)).contentType).toBe("image/png");
    expect((await readMedia(db, router(), ctx, after.assetId)).contentType).toBe("image/png");

    await deleteMedia(db, router(), ctx, before.assetId);
    await deleteMedia(db, router(), ctx, after.assetId);
    expect(legacy.objects.size).toBe(0);
    expect(wasabi.objects.size).toBe(0);
  });

  it("never falls back to another provider when the recorded one is unusable", async () => {
    const ctx = await createTenant(system);
    await configureWasabi();
    await switchTo("WASABI");
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    credentials = null; // keys removed from the environment
    expect(await codeOf(readMedia(db, router(), ctx, assetId))).toBe("SERVICE_UNAVAILABLE");
    expect(await codeOf(router().writeTarget())).toBe("SERVICE_UNAVAILABLE");
    expect(legacy.objects.size).toBe(0);
  });

  it("reports an unconfigured provider without naming values", async () => {
    const error = await router()
      .forProvider("WASABI")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("SERVICE_UNAVAILABLE");
    expect((error as AppError).metadata).toEqual({
      provider: "WASABI",
      missing: ["region", "endpoint", "bucket"],
    });
    credentials = null;
    await configureWasabi();
    const missingKeys = await router()
      .forProvider("WASABI")
      .catch((caught: unknown) => caught);
    expect((missingKeys as AppError).metadata).toEqual({
      provider: "WASABI",
      missing: ["credentials"],
    });
  });
});

describe("Wasabi settings", () => {
  it("saves validated settings with an audit entry naming fields only", async () => {
    const by = await admin();
    const outcome = await saveWasabiSettings(db, by, {
      ...SETTINGS,
      endpoint: `${SETTINGS.endpoint}/`,
    });
    expect(outcome).toEqual({ outcome: "saved", changed: ["region", "endpoint", "bucket"] });
    expect(await saveWasabiSettings(db, by, SETTINGS)).toEqual({
      outcome: "unchanged",
    });
    const audits = await system.auditLog.findMany({
      where: { action: "storage.settings_updated" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: null, actorUserId: by.userId });
    expect(audits[0]?.metadata).toEqual({
      provider: "WASABI",
      fields: ["region", "endpoint", "bucket"],
    });
    expect(JSON.stringify(audits)).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it("rejects invalid settings per field and stores nothing", async () => {
    const error = await saveWasabiSettings(db, await admin(), {
      region: "nope",
      endpoint: "https://attacker.example",
      bucket: "A",
    }).catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe("VALIDATION_FAILED");
    expect([...new Set((error as AppError).fields.map((field) => field.path))].sort()).toEqual([
      "bucket",
      "endpoint",
      "region",
    ]);
    expect(await system.platformStorageSettings.count()).toBe(0);
  });

  it("locks Wasabi's location while it receives or holds objects", async () => {
    const ctx = await createTenant(system);
    const by = await configureWasabi();
    await switchTo("WASABI");
    const moved = { ...SETTINGS, bucket: "flexibx-other" };
    expect(await saveWasabiSettings(db, by, moved)).toEqual({
      outcome: "locked",
    });

    await uploadMedia(db, await router().writeTarget(), ctx, png());
    await switchTo("LEGACY_S3");
    // No longer the write target, but it still holds an object.
    expect((await getStorageAdminView(system, router())).wasabi.locationLocked).toBe(true);
    expect(await saveWasabiSettings(db, by, moved)).toEqual({
      outcome: "locked",
    });
    expect(
      (await system.platformStorageSettings.findUniqueOrThrow({ where: { id: 1 } })).wasabiBucket,
    ).toBe(SETTINGS.bucket);
  });

  it("the admin view carries key presence only", async () => {
    await configureWasabi();
    const view = await getStorageAdminView(system, router());
    expect(view.wasabi).toMatchObject({ ...SETTINGS, credentialsPresent: true, ready: true });
    const json = JSON.stringify(view);
    expect(json).not.toContain(CREDENTIALS.accessKeyId);
    expect(json).not.toContain(CREDENTIALS.secretAccessKey);
    credentials = null;
    expect((await getStorageAdminView(system, router())).wasabi).toMatchObject({
      credentialsPresent: false,
      ready: false,
      missing: ["credentials"],
    });
  });
});

describe("write-provider switch", () => {
  it("requires the typed confirmation", async () => {
    await configureWasabi();
    const error = await changeWriteProvider(system, db, router(), await admin(), {
      target: "WASABI",
      confirmation: "wasabi",
    }).catch((caught: unknown) => caught);
    expect((error as AppError).code).toBe("VALIDATION_FAILED");
    expect((error as AppError).fields).toEqual([
      { path: "confirmation", code: "confirmation_mismatch" },
    ]);
    expect((await getStorageAdminView(system, router())).writeProvider).toBe("LEGACY_S3");
  });

  it("refuses an unconfigured target and a target that fails its live check", async () => {
    expect(await switchTo("WASABI")).toEqual({
      outcome: "provider_unavailable",
      provider: "WASABI",
      failure: "not_configured",
    });
    await configureWasabi();
    wasabi.failure = "access_denied";
    expect(await switchTo("WASABI")).toEqual({
      outcome: "provider_unavailable",
      provider: "WASABI",
      failure: "access_denied",
    });
    expect((await getStorageAdminView(system, router())).writeProvider).toBe("LEGACY_S3");
    expect(
      await system.auditLog.count({ where: { action: "storage.write_provider_changed" } }),
    ).toBe(0);
  });

  it("fails over away from an unavailable provider that holds files, with a warning", async () => {
    const ctx = await createTenant(system);
    await configureWasabi();
    await switchTo("WASABI");
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    const key = (await system.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).storageKey;
    // Wasabi goes down while it is the write provider and holds a file.
    wasabi.failure = "unreachable";
    const by = await admin();
    expect(
      await changeWriteProvider(system, db, router(), by, {
        target: "LEGACY_S3",
        confirmation: "LEGACY_S3",
      }),
    ).toEqual({
      outcome: "changed",
      from: "WASABI",
      to: "LEGACY_S3",
      warnings: [{ provider: "WASABI", failure: "unreachable" }],
    });
    const audit = await system.auditLog.findFirstOrThrow({
      where: { action: "storage.write_provider_changed", actorUserId: by.userId },
    });
    expect(audit.metadata).toEqual({
      from: "WASABI",
      to: "LEGACY_S3",
      unavailableProviders: ["WASABI"],
    });
    // New uploads go to the healthy provider at once.
    const fresh = await uploadMedia(db, await router().writeTarget(), ctx, png());
    expect(
      (await system.mediaAsset.findUniqueOrThrow({ where: { id: fresh.assetId } })).storageProvider,
    ).toBe("LEGACY_S3");
    // The existing file keeps its recorded provider; nothing was moved or copied.
    expect(
      (await system.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).storageProvider,
    ).toBe("WASABI");
    expect(wasabi.objects.has(key)).toBe(true);
    expect(legacy.objects.has(key)).toBe(false);
  });

  it("never redirects reads or deletes of a stranded file to the healthy provider", async () => {
    const ctx = await createTenant(system);
    await configureWasabi();
    await switchTo("WASABI");
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    wasabi.failure = "unreachable";
    await switchTo("LEGACY_S3");
    // Wasabi unusable (keys withdrawn): reading or deleting its file fails; LEGACY_S3 is
    // never asked, and the row stays for a retry.
    credentials = null;
    const reads = { legacy: 0 };
    const counting = createStorageRouter({
      system,
      legacy: () => {
        reads.legacy += 1;
        return legacy;
      },
      wasabiCredentials: () => credentials,
      makeWasabi: () => wasabi,
    });
    expect(await codeOf(readMedia(db, counting, ctx, assetId))).toBe("SERVICE_UNAVAILABLE");
    expect(await codeOf(deleteMedia(db, counting, ctx, assetId))).toBe("SERVICE_UNAVAILABLE");
    expect(reads.legacy).toBe(0);
    expect(await system.mediaAsset.count({ where: { id: assetId } })).toBe(1);
  });

  it("still refuses a target that fails, even when failing over", async () => {
    const ctx = await createTenant(system);
    await configureWasabi();
    await switchTo("WASABI");
    await uploadMedia(db, await router().writeTarget(), ctx, png());
    wasabi.failure = "unreachable";
    legacy.failure = "access_denied";
    expect(await switchTo("LEGACY_S3")).toEqual({
      outcome: "provider_unavailable",
      provider: "LEGACY_S3",
      failure: "access_denied",
    });
    expect((await getStorageAdminView(system, router())).writeProvider).toBe("WASABI");
  });

  it("checks a provider that still holds files, to warn, without blocking", async () => {
    const ctx = await createTenant(system);
    await uploadMedia(db, await router().writeTarget(), ctx, png()); // on LEGACY_S3
    await configureWasabi();
    legacy.failure = "unreachable";
    expect(await switchTo("WASABI")).toEqual({
      outcome: "changed",
      from: "LEGACY_S3",
      to: "WASABI",
      warnings: [{ provider: "LEGACY_S3", failure: "unreachable" }],
    });
    expect(legacy.checks).toBe(1);
  });

  it("does not check an empty provider it is leaving", async () => {
    await configureWasabi();
    legacy.failure = "unreachable";
    expect(await switchTo("WASABI")).toMatchObject({ outcome: "changed" });
    expect(legacy.checks).toBe(0);
  });

  it("switches, audits, and reports unchanged and stale decisions", async () => {
    await configureWasabi();
    const by = await admin();
    expect(
      await changeWriteProvider(system, db, router(), by, {
        target: "WASABI",
        confirmation: "WASABI",
      }),
    ).toEqual({ outcome: "changed", from: "LEGACY_S3", to: "WASABI", warnings: [] });
    const audit = await system.auditLog.findFirstOrThrow({
      where: { action: "storage.write_provider_changed" },
    });
    expect(audit).toMatchObject({ workspaceId: null, actorUserId: by.userId });
    expect(audit.metadata).toEqual({ from: "LEGACY_S3", to: "WASABI", unavailableProviders: [] });
    expect(await switchTo("WASABI")).toEqual({ outcome: "unchanged" });

    // Another administrator switches back while this request is checking.
    const racing = createStorageRouter({
      system,
      legacy: () => legacy,
      wasabiCredentials: () => credentials,
      makeWasabi: () => wasabi,
    });
    const slowLegacy = new CheckableStorage();
    slowLegacy.checkAccess = async () => {
      await system.platformStorageSettings.update({
        where: { id: 1 },
        data: { writeProvider: "LEGACY_S3" },
      });
    };
    legacy = slowLegacy;
    expect(
      await changeWriteProvider(system, db, racing, by, {
        target: "LEGACY_S3",
        confirmation: "LEGACY_S3",
      }),
    ).toEqual({ outcome: "stale" });
  });

  it("the connection check reports classified failures and timeouts", async () => {
    expect(await checkProviderConnection(router(), "LEGACY_S3")).toEqual({ ok: true });
    expect(await checkProviderConnection(router(), "WASABI")).toEqual({
      ok: false,
      failure: "not_configured",
    });
    await configureWasabi();
    wasabi.checkAccess = (options?: { signal?: AbortSignal }) =>
      new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new StorageAccessError("timeout"));
        });
      });
    expect(await checkProviderConnection(router(), "WASABI", 50)).toEqual({
      ok: false,
      failure: "timeout",
    });
  });
});

describe("concurrent settings changes and uploads", () => {
  it("save versus switch: a bucket saved during the switch's checks makes the switch stale", async () => {
    const by = await configureWasabi();
    const before = (await getStorageAdminView(system, router())).version;
    // While the switch checks bucket A, another admin saves bucket B (allowed: Wasabi is
    // not the write provider and holds nothing).
    let saved: unknown;
    wasabi.checkAccess = async () => {
      saved = await saveWasabiSettings(db, by, { ...SETTINGS, bucket: "flexibx-other" });
    };
    expect(await switchTo("WASABI")).toEqual({ outcome: "stale" });
    expect(saved).toEqual({ outcome: "saved", changed: ["bucket"] });
    const row = await system.platformStorageSettings.findUniqueOrThrow({ where: { id: 1 } });
    // New files never go to the unchecked bucket B.
    expect(row).toMatchObject({ writeProvider: "LEGACY_S3", wasabiBucket: "flexibx-other" });
    expect(row.version).toBe(before + 1);
    expect(
      await system.auditLog.count({ where: { action: "storage.write_provider_changed" } }),
    ).toBe(0);
  });

  it("switch versus save: once the switch committed, the save is locked", async () => {
    const by = await configureWasabi();
    expect(await switchTo("WASABI")).toMatchObject({ outcome: "changed" });
    expect(await saveWasabiSettings(db, by, { ...SETTINGS, bucket: "flexibx-other" })).toEqual({
      outcome: "locked",
    });
  });

  it("concurrent saves serialize on the settings row (no lost update, one audit each)", async () => {
    const by = await admin();
    const results = await Promise.all([
      saveWasabiSettings(db, by, SETTINGS),
      saveWasabiSettings(db, by, { ...SETTINGS, bucket: "flexibx-other" }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["saved", "saved"]);
    const row = await system.platformStorageSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.version).toBe(2);
    expect(await system.auditLog.count({ where: { action: "storage.settings_updated" } })).toBe(2);
  });

  it("in-flight upload versus location change: the upload is refused and its object removed", async () => {
    const ctx = await createTenant(system);
    const by = await configureWasabi();
    await switchTo("WASABI");
    const target = await router().writeTarget(); // Wasabi, bucket A
    // While the object is being written to bucket A, an admin moves new writes back to
    // LEGACY_S3 and saves bucket B (Wasabi holds no committed file yet, so it is allowed).
    const put = wasabi.put.bind(wasabi);
    wasabi.put = async (...args) => {
      await put(...args);
      wasabi.put = put;
      await switchTo("LEGACY_S3");
      expect(await saveWasabiSettings(db, by, { ...SETTINGS, bucket: "flexibx-other" })).toEqual({
        outcome: "saved",
        changed: ["bucket"],
      });
    };
    expect(await codeOf(uploadMedia(db, target, ctx, png()))).toBe("CONFLICT");
    // No row points at bucket B for an object that lives in bucket A, and the written
    // object was removed again.
    expect(await system.mediaAsset.count()).toBe(0);
    expect(wasabi.objects.size).toBe(0);
  });

  it("upload versus location change: a committed upload locks the location", async () => {
    const ctx = await createTenant(system);
    const by = await configureWasabi();
    await switchTo("WASABI");
    const target = await router().writeTarget();
    await uploadMedia(db, target, ctx, png());
    await switchTo("LEGACY_S3");
    expect(await saveWasabiSettings(db, by, { ...SETTINGS, bucket: "flexibx-other" })).toEqual({
      outcome: "locked",
    });
  });

  it("an upload holding the settings share lock delays a save until it commits", async () => {
    const ctx = await createTenant(system);
    const by = await configureWasabi();
    await switchTo("WASABI");
    const target = await router().writeTarget();
    await switchTo("LEGACY_S3");
    // The upload's insert transaction confirms (share lock) and then waits before its
    // insert; a save started meanwhile must wait for it and then see the new file.
    let saving: Promise<unknown> | undefined;
    const slow = {
      ...target,
      confirm: async (tx: Parameters<StorageWriteTarget["confirm"]>[0]) => {
        await target.confirm(tx);
        saving = saveWasabiSettings(db, by, { ...SETTINGS, bucket: "flexibx-other" });
        await sleep(300);
      },
    };
    await uploadMedia(db, slow, ctx, png());
    expect(await saving).toEqual({ outcome: "locked" });
    expect(
      (await system.platformStorageSettings.findUniqueOrThrow({ where: { id: 1 } })).wasabiBucket,
    ).toBe(SETTINGS.bucket);
  });
});

describe("failed media writes", () => {
  const collect = () => {
    const lines: { fields: unknown; message: string }[] = [];
    const logger = {
      error: (fields: unknown, message: string) => {
        lines.push({ fields, message });
      },
    };
    return { lines, logger: logger as never };
  };

  it("a write stored but timed out: only that key is deleted, the original error surfaces", async () => {
    const ctx = await createTenant(system);
    const kept = await uploadMedia(db, await router().writeTarget(), ctx, png());
    const put = legacy.put.bind(legacy);
    const timeout = new StorageTimeoutError("put");
    legacy.put = async (...args) => {
      await put(...args);
      throw timeout;
    };
    const { lines, logger } = collect();
    const error = await uploadMedia(db, await router().writeTarget(), ctx, png(), null, logger)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBe(timeout);
    // The earlier asset's object is untouched; the ambiguous one is gone; no row for it.
    expect(legacy.objects.size).toBe(1);
    const row = await system.mediaAsset.findUniqueOrThrow({ where: { id: kept.assetId } });
    expect(legacy.objects.has(row.storageKey)).toBe(true);
    expect(await system.mediaAsset.count()).toBe(1);
    expect(lines).toEqual([]);
  });

  it("a cleanup that fails is logged by name only and never replaces the upload error", async () => {
    const ctx = await createTenant(system);
    const put = legacy.put.bind(legacy);
    const timeout = new StorageTimeoutError("put");
    legacy.put = async (...args) => {
      await put(...args);
      throw timeout;
    };
    legacy.delete = () =>
      Promise.reject(
        Object.assign(new Error(`denied for ${CREDENTIALS.accessKeyId}`), {
          name: "AccessDenied",
        }),
      );
    const { lines, logger } = collect();
    const error = await uploadMedia(db, await router().writeTarget(), ctx, png(), null, logger)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBe(timeout);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({ cleanupError: { name: "AccessDenied" } });
    expect(JSON.stringify(lines)).not.toContain(CREDENTIALS.accessKeyId);
    expect(await system.mediaAsset.count()).toBe(0);
  });

  it("reading an asset passes the recorded size, so the download deadline fits the object", async () => {
    const ctx = await createTenant(system);
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    const seen: unknown[] = [];
    const get = legacy.getObject.bind(legacy);
    legacy.getObject = (key, options) => {
      seen.push(options);
      return get(key, options);
    };
    const media = await readMedia(db, router(), ctx, assetId);
    expect(media.body).toHaveLength(40);
    expect(seen).toEqual([{ expectedBytes: 40 }]);
  });
});

describe("media deletion failures", () => {
  it("keeps the row when the object's provider cannot be resolved (safe retry)", async () => {
    const ctx = await createTenant(system);
    await configureWasabi();
    await switchTo("WASABI");
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    credentials = null;
    expect(await codeOf(deleteMedia(db, router(), ctx, assetId))).toBe("SERVICE_UNAVAILABLE");
    expect(await system.mediaAsset.count({ where: { id: assetId } })).toBe(1);
    expect(wasabi.objects.size).toBe(1);
    expect(await system.auditLog.count({ where: { action: "asset.deleted" } })).toBe(0);
    // Once the provider works again, the same delete succeeds.
    credentials = CREDENTIALS;
    await deleteMedia(db, router(), ctx, assetId);
    expect(await system.mediaAsset.count({ where: { id: assetId } })).toBe(0);
    expect(wasabi.objects.size).toBe(0);
  });

  it("a storage delete failing after the row is gone is logged, not hidden", async () => {
    const ctx = await createTenant(system);
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    legacy.delete = () => Promise.reject(new Error("storage down"));
    const logged: string[] = [];
    const logger = { error: (_: unknown, message: string) => logged.push(message) };
    await deleteMedia(db, router(), ctx, assetId, logger as never);
    expect(await system.mediaAsset.count({ where: { id: assetId } })).toBe(0);
    expect(logged).toEqual(["Could not remove a deleted asset's stored object"]);
    expect(legacy.objects.size).toBe(1);
  });
});

describe("database rules", () => {
  it("refuses WASABI as write provider without complete settings", async () => {
    await expect(
      system.$executeRaw`INSERT INTO platform_storage_settings (id, write_provider, updated_at) VALUES (1, 'WASABI', now())`,
    ).rejects.toThrow();
    await expect(
      system.$executeRaw`INSERT INTO platform_storage_settings (id, updated_at) VALUES (2, now())`,
    ).rejects.toThrow();
  });

  it("keeps an object's provider and key immutable", async () => {
    const ctx = await createTenant(system);
    const { assetId } = await uploadMedia(db, await router().writeTarget(), ctx, png());
    await expect(
      system.mediaAsset.update({ where: { id: assetId }, data: { storageProvider: "WASABI" } }),
    ).rejects.toThrow();
    await expect(
      system.mediaAsset.update({
        where: { id: assetId },
        data: { storageKey: buildWorkspaceKey(ctx.workspaceId, "content-media", "image/png") },
      }),
    ).rejects.toThrow();

    const video = await recordGeneratedVideo(db, ctx, videoInput(ctx.workspaceId, "LEGACY_S3"));
    const file = await system.generatedVideoFile.findFirstOrThrow({ where: { videoId: video.id } });
    await expect(
      system.generatedVideoFile.update({
        where: { id: file.id },
        data: { storageProvider: "WASABI" },
      }),
    ).rejects.toThrow();
  });
});

function videoInput(workspaceId: string, storageProvider: "LEGACY_S3" | "WASABI") {
  return {
    title: "Clip",
    provider: "fake",
    durationSeconds: 4,
    width: 1280,
    height: 720,
    storageProvider,
    files: [
      {
        kind: "VIDEO" as const,
        storageKey: buildWorkspaceKey(workspaceId, "generated-videos", "video/mp4"),
        contentType: "video/mp4" as const,
        byteSize: 4,
      },
    ],
  };
}

describe("retention through the router", () => {
  const retention = (storage = router()) => ({
    system,
    db,
    storage,
    mailer: new MemoryMailer(),
    appUrl: "http://localhost:3000",
  });
  const later = () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

  async function seed(store: StorageService, provider: "LEGACY_S3" | "WASABI") {
    const ctx = await createTenant(system);
    const input = videoInput(ctx.workspaceId, provider);
    const file = input.files[0];
    if (file === undefined) throw new Error("no file");
    await store.put(file.storageKey, new Uint8Array([1, 2, 3, 4]), { contentType: "video/mp4" });
    const video = await recordGeneratedVideo(db, ctx, input);
    return { video, key: file.storageKey };
  }

  it("deletes each file from the provider recorded on its row", async () => {
    await configureWasabi();
    const onLegacy = await seed(legacy, "LEGACY_S3");
    const onWasabi = await seed(wasabi, "WASABI");
    const result = await runVideoRetention(retention(), { now: later() });
    expect(result.deletion).toMatchObject({ claimed: 2, deleted: 2, failed: 0 });
    expect(legacy.objects.has(onLegacy.key)).toBe(false);
    expect(wasabi.objects.has(onWasabi.key)).toBe(false);
    const statuses = await system.generatedVideo.findMany({ select: { status: true } });
    expect(statuses.map((row) => row.status)).toEqual(["DELETED", "DELETED"]);
  });

  /** A video with several files, all recorded on `provider`. */
  async function seedMany(store: StorageService, provider: "LEGACY_S3" | "WASABI") {
    const ctx = await createTenant(system);
    const files = (["VIDEO", "THUMBNAIL", "DERIVATIVE"] as const).map((kind) => ({
      kind,
      storageKey: buildWorkspaceKey(
        ctx.workspaceId,
        kind === "THUMBNAIL" ? "generated-images" : "generated-videos",
        kind === "THUMBNAIL" ? "image/jpeg" : "video/mp4",
      ),
      contentType: kind === "THUMBNAIL" ? ("image/jpeg" as const) : ("video/mp4" as const),
      byteSize: 4,
    }));
    for (const file of files) {
      await store.put(file.storageKey, new Uint8Array([1, 2, 3, 4]), {
        contentType: file.contentType,
      });
    }
    const video = await recordGeneratedVideo(db, ctx, {
      ...videoInput(ctx.workspaceId, provider),
      files,
    });
    return { video, keys: files.map((file) => file.storageKey) };
  }

  /** The router's settings reads, made slow (a slow database) and counted. */
  function slowSettings(delayMs: number) {
    const reads = { count: 0 };
    const slow = new Proxy(system, {
      get(target, property, receiver) {
        if (property !== "platformStorageSettings") {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return {
          findUnique: async (
            args: Parameters<PrismaClient["platformStorageSettings"]["findUnique"]>[0],
          ) => {
            reads.count += 1;
            await sleep(delayMs);
            return target.platformStorageSettings.findUnique(args);
          },
        };
      },
    });
    return { system: slow, reads };
  }

  it("resolves a provider once per run, even when it is unavailable on a slow database", async () => {
    await configureWasabi();
    const first = await seedMany(wasabi, "WASABI");
    const second = await seedMany(wasabi, "WASABI");
    credentials = null; // Wasabi unusable
    const { system: slow, reads } = slowSettings(150);
    const storage = createStorageRouter({
      system: slow,
      legacy: () => legacy,
      wasabiCredentials: () => credentials,
      makeWasabi: () => wasabi,
    });
    const result = await runVideoRetention(retention(storage), { now: later() });
    // Six files, two videos: one (slow) settings read for the whole run.
    expect(reads.count).toBe(1);
    expect(result.deletion).toMatchObject({ claimed: 2, deleted: 0, failed: 2 });
    expect(result.storageUnavailableFiles).toBe(6);
    for (const key of [...first.keys, ...second.keys]) expect(wasabi.objects.has(key)).toBe(true);
    const rows = await system.generatedVideo.findMany({
      select: { status: true, lastDeletionError: true },
    });
    expect(rows).toEqual([
      { status: "DELETING", lastDeletionError: "storage_provider_unavailable" },
      { status: "DELETING", lastDeletionError: "storage_provider_unavailable" },
    ]);
  });

  it("keeps the deadline when provider resolution is slow: no delete starts after it", async () => {
    await configureWasabi();
    const seeded = [
      await seedMany(wasabi, "WASABI"),
      await seedMany(wasabi, "WASABI"),
      await seedMany(wasabi, "WASABI"),
    ];
    const { system: slow, reads } = slowSettings(400);
    const storage = createStorageRouter({
      system: slow,
      legacy: () => legacy,
      wasabiCredentials: () => credentials,
      makeWasabi: () => wasabi,
    });
    const deletes: number[] = [];
    const startedAt = performance.now();
    const deleteOriginal = wasabi.delete.bind(wasabi);
    wasabi.delete = async (...args) => {
      deletes.push(performance.now() - startedAt);
      await deleteOriginal(...args);
    };
    const result = await runVideoRetention(retention(storage), {
      now: later(),
      timeBudgetMs: 150,
    });
    const elapsed = performance.now() - startedAt;
    expect(result.stoppedAtDeadline).toBe(true);
    // The resolution finished after the deadline: the claim is handed back untouched.
    expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 0, interrupted: 1 });
    expect(deletes).toEqual([]);
    expect(reads.count).toBe(1);
    for (const { keys } of seeded)
      for (const key of keys) expect(wasabi.objects.has(key)).toBe(true);
    // Bounded: the budget plus one resolution (and a few fast statements).
    expect(elapsed).toBeLessThan(150 + 400 + 1_500);
    const statuses = await system.generatedVideo.findMany({
      select: { status: true, deletionAttempts: true },
    });
    // The interrupted video is due again with no attempt counted; the others untouched.
    expect(statuses.every((row) => row.deletionAttempts === 0)).toBe(true);
  });

  it("keeps the deadline when resolution fails slowly: the failure is recorded, nothing more starts", async () => {
    await configureWasabi();
    await seedMany(wasabi, "WASABI");
    await seedMany(wasabi, "WASABI");
    credentials = null;
    const { system: slow, reads } = slowSettings(400);
    const storage = createStorageRouter({
      system: slow,
      legacy: () => legacy,
      wasabiCredentials: () => credentials,
      makeWasabi: () => wasabi,
    });
    const startedAt = performance.now();
    const result = await runVideoRetention(retention(storage), {
      now: later(),
      timeBudgetMs: 150,
    });
    const elapsed = performance.now() - startedAt;
    expect(result.stoppedAtDeadline).toBe(true);
    // One video claimed; its first file's resolution failed after the deadline, so the
    // remaining files were not tried and the attempt was recorded as failed.
    expect(result.deletion).toEqual({ claimed: 1, deleted: 0, failed: 1, interrupted: 0 });
    expect(result.storageUnavailableFiles).toBe(1);
    expect(reads.count).toBe(1);
    expect(elapsed).toBeLessThan(150 + 400 + 1_500);
  });

  it("counts a file on an unconfigured provider as failed and retries it later", async () => {
    await configureWasabi();
    const onWasabi = await seed(wasabi, "WASABI");
    const onLegacy = await seed(legacy, "LEGACY_S3");
    credentials = null;
    const result = await runVideoRetention(retention(), { now: later() });
    expect(result.deletion).toMatchObject({ claimed: 2, deleted: 1, failed: 1 });
    expect(result.storageUnavailableFiles).toBe(1);
    expect(legacy.objects.has(onLegacy.key)).toBe(false);
    // Never deleted from another provider, and not marked deleted.
    expect(wasabi.objects.has(onWasabi.key)).toBe(true);
    const row = await system.generatedVideo.findUniqueOrThrow({ where: { id: onWasabi.video.id } });
    expect(row.status).not.toBe("DELETED");
    const file = await system.generatedVideoFile.findFirstOrThrow({
      where: { videoId: onWasabi.video.id },
    });
    expect(file.deletedAt).toBeNull();
  });
});

import "server-only";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import { AppError } from "../errors/app-error";

import type { ConfiguredStorageRouter, WasabiMissing } from "./providers";
import { StorageAccessError, type StorageAccessFailure, type StorageProviderId } from "./storage";
import { wasabiSettingsSchema } from "./wasabi-storage";

import type { PrismaClient } from "@/generated/prisma/client";

type Tx = Parameters<Parameters<GuardedPrismaClient["$transaction"]>[0]>[0];

// Platform storage administration (platform administrators only — callers authorize with
// requirePlatformAdmin first). Rules:
// - Secrets never leave the server: the view says only whether access keys are present.
// - Saving Wasabi settings never moves data, and is refused while Wasabi holds objects or
//   receives new ones: changing its bucket or endpoint would silently point existing
//   objects at a different (possibly empty) bucket.
// - Changing the write provider affects NEW objects only. It needs an explicit
//   confirmation, the target must pass a live connection check, and so must every
//   provider that still holds objects — existing objects stay reachable where they are.
//   Moving existing objects between providers is a separate data migration (not built).
//
// SYSTEM PATH (reviewed): `system` reads platform-wide settings and per-provider object
// counts across workspaces (no tenant data); writes and their audit entries go through the
// guarded client `db` in one transaction.

export const STORAGE_PROVIDERS: readonly StorageProviderId[] = ["LEGACY_S3", "WASABI"];

/** How long one admin connection check may take. */
export const CONNECTION_CHECK_TIMEOUT_MS = 10_000;

export interface ProviderObjectCounts {
  /** Media library objects. */
  readonly media: number;
  /** Generated video files whose objects have not been deleted yet. */
  readonly videoFiles: number;
}

export interface StorageAdminView {
  readonly writeProvider: StorageProviderId;
  /** Settings version the view was read at (compare-and-set for changes). */
  readonly version: number;
  readonly objects: Readonly<Record<StorageProviderId, ProviderObjectCounts>>;
  readonly legacy: { readonly configured: boolean };
  readonly wasabi: {
    readonly region: string | null;
    readonly endpoint: string | null;
    readonly bucket: string | null;
    /** Presence only — never the keys or any part of them. */
    readonly credentialsPresent: boolean;
    readonly ready: boolean;
    readonly missing: readonly WasabiMissing[];
    /** Location fields cannot change while Wasabi holds or receives objects. */
    readonly locationLocked: boolean;
  };
}

/** Objects per provider: media rows, and video files not yet deleted from storage. */
export async function countObjectsByProvider(
  system: PrismaClient,
): Promise<Record<StorageProviderId, ProviderObjectCounts>> {
  const [media, files] = await Promise.all([
    system.mediaAsset.groupBy({ by: ["storageProvider"], _count: { _all: true } }),
    system.generatedVideoFile.groupBy({
      by: ["storageProvider"],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
  ]);
  const counts = Object.fromEntries(
    STORAGE_PROVIDERS.map((provider) => [provider, { media: 0, videoFiles: 0 }]),
  ) as Record<StorageProviderId, { media: number; videoFiles: number }>;
  for (const row of media) counts[row.storageProvider].media = row._count._all;
  for (const row of files) counts[row.storageProvider].videoFiles = row._count._all;
  return counts;
}

const holdsObjects = (counts: ProviderObjectCounts) => counts.media + counts.videoFiles > 0;

export async function getStorageAdminView(
  system: PrismaClient,
  router: ConfiguredStorageRouter,
): Promise<StorageAdminView> {
  const [status, objects] = await Promise.all([router.status(), countObjectsByProvider(system)]);
  const { settings, wasabi } = status;
  return {
    writeProvider: settings.writeProvider,
    version: settings.version,
    objects,
    legacy: { configured: status.legacyConfigured },
    wasabi: {
      region: settings.wasabiRegion,
      endpoint: settings.wasabiEndpoint,
      bucket: settings.wasabiBucket,
      credentialsPresent: wasabi.state === "ready" || !wasabi.missing.includes("credentials"),
      ready: wasabi.state === "ready",
      missing: wasabi.state === "ready" ? [] : wasabi.missing,
      locationLocked: settings.writeProvider === "WASABI" || holdsObjects(objects.WASABI),
    },
  };
}

export type SaveWasabiOutcome =
  | { readonly outcome: "saved"; readonly changed: readonly ("region" | "endpoint" | "bucket")[] }
  | { readonly outcome: "unchanged" }
  /** Wasabi holds or receives objects: its location cannot change (would strand them). */
  | { readonly outcome: "locked" };

interface LockedSettings {
  readonly writeProvider: StorageProviderId;
  readonly region: string | null;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  readonly version: number;
}

/**
 * Creates the settings row if needed and locks it FOR UPDATE until the transaction ends.
 * Every settings change runs under this lock; uploads hold a share lock on the same row
 * while they record a new object (StorageWriteTarget.confirm), so the two serialize.
 */
async function lockSettingsForUpdate(tx: Tx): Promise<LockedSettings> {
  await tx.$executeRaw`
    INSERT INTO "platform_storage_settings" ("id", "updated_at") VALUES (1, now())
    ON CONFLICT ("id") DO NOTHING`;
  const rows = await tx.$queryRaw<LockedSettings[]>`
    SELECT "write_provider" AS "writeProvider", "wasabi_region" AS "region",
           "wasabi_endpoint" AS "endpoint", "wasabi_bucket" AS "bucket", "version"
    FROM "platform_storage_settings" WHERE "id" = 1 FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) throw new Error("platform_storage_settings row missing after insert");
  return row;
}

/**
 * Objects recorded on Wasabi (media, and video files not deleted yet), counted inside the
 * caller's transaction after the settings lock is held: every committed upload is counted,
 * and an upload that commits later re-checks the location under its share lock.
 * SYSTEM PATH (reviewed): platform-wide count, no tenant data.
 */
async function countWasabiObjects(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<{ count: bigint }[]>`
    SELECT (SELECT count(*) FROM "media_assets" WHERE "storage_provider" = 'WASABI')
         + (SELECT count(*) FROM "generated_video_files"
            WHERE "storage_provider" = 'WASABI' AND "deleted_at" IS NULL) AS "count"`;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Saves Wasabi's non-secret settings (region, endpoint, bucket). Invalid input throws
 * VALIDATION_FAILED (per field). The decision is made under the settings row lock: a
 * location change is refused ("locked") while Wasabi is the write provider or holds any
 * object. Never touches stored objects.
 */
export async function saveWasabiSettings(
  db: GuardedPrismaClient,
  admin: { readonly userId: string },
  input: unknown,
): Promise<SaveWasabiOutcome> {
  const parsed = wasabiSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      fields: parsed.error.issues.map((issue) => ({
        path: String(issue.path[0] ?? ""),
        code:
          issue.message.endsWith("_invalid") || issue.message.endsWith("_mismatch")
            ? issue.message
            : "invalid",
      })),
    });
  }
  const next = parsed.data;
  return db.$transaction(async (tx) => {
    const current = await lockSettingsForUpdate(tx);
    const changed = (["region", "endpoint", "bucket"] as const).filter(
      (field) => current[field] !== next[field],
    );
    if (changed.length === 0) return { outcome: "unchanged" as const };
    if (current.writeProvider === "WASABI" || (await countWasabiObjects(tx)) > 0) {
      return { outcome: "locked" as const };
    }
    await tx.platformStorageSettings.update({
      where: { id: 1 },
      data: {
        wasabiRegion: next.region,
        wasabiEndpoint: next.endpoint,
        wasabiBucket: next.bucket,
        version: { increment: 1 },
      },
    });
    // Field names only: values (even non-secret ones) are not copied into the audit log.
    await recordAudit(
      tx,
      { workspaceId: null, userId: admin.userId },
      {
        action: "storage.settings_updated",
        entityType: "storage_settings",
        metadata: { provider: "WASABI", fields: changed },
      },
    );
    return { outcome: "saved" as const, changed };
  });
}

export type ConnectionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: StorageAccessFailure | "not_configured" | "unsupported";
    };

/** A live, read-only connection check of one provider, run on the server. */
export async function checkProviderConnection(
  router: ConfiguredStorageRouter,
  provider: StorageProviderId,
  timeoutMs = CONNECTION_CHECK_TIMEOUT_MS,
): Promise<ConnectionCheck> {
  let storage;
  try {
    storage = await router.forProvider(provider);
  } catch {
    return { ok: false, failure: "not_configured" };
  }
  if (storage.checkAccess === undefined) return { ok: false, failure: "unsupported" };
  try {
    await storage.checkAccess({ signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof StorageAccessError ? error.failure : "failed",
    };
  }
}

/** A provider holding existing objects that failed its check when new writes moved. */
export interface ProviderWarning {
  readonly provider: StorageProviderId;
  readonly failure: Exclude<ConnectionCheck, { ok: true }>["failure"];
}

export type ChangeWriteProviderOutcome =
  | {
      readonly outcome: "changed";
      readonly from: StorageProviderId;
      readonly to: StorageProviderId;
      /**
       * Other providers that still hold objects and failed their check. The switch is
       * allowed (it only redirects NEW writes), but their existing objects stay where they
       * are and cannot be read or deleted until that provider works again.
       */
      readonly warnings: readonly ProviderWarning[];
    }
  | { readonly outcome: "unchanged" }
  /** The target failed its check: new writes would fail there, so nothing changed. */
  | {
      readonly outcome: "provider_unavailable";
      readonly provider: StorageProviderId;
      readonly failure: Exclude<ConnectionCheck, { ok: true }>["failure"];
    }
  /** The settings changed while this request was checking (retry from a fresh view). */
  | { readonly outcome: "stale" };

/**
 * Makes `target` the provider for NEW objects. Requires `confirmation === target` and a
 * passing live check of the target. Other providers that still hold objects are checked
 * too, but only to warn: moving new writes away from a failing provider is exactly what an
 * outage needs, and existing objects never move — reads and deletes keep going to each
 * object's recorded provider (never redirected). The change applies only if the settings
 * are still at the version the checks were made against (compare-and-set).
 */
export async function changeWriteProvider(
  system: PrismaClient,
  db: GuardedPrismaClient,
  router: ConfiguredStorageRouter,
  admin: { readonly userId: string },
  input: { readonly target: StorageProviderId; readonly confirmation: string },
  timeoutMs = CONNECTION_CHECK_TIMEOUT_MS,
): Promise<ChangeWriteProviderOutcome> {
  const { target } = input;
  if (input.confirmation.trim() !== target) {
    throw new AppError("VALIDATION_FAILED", {
      fields: [{ path: "confirmation", code: "confirmation_mismatch" }],
    });
  }
  const view = await getStorageAdminView(system, router);
  const from = view.writeProvider;
  if (from === target) return { outcome: "unchanged" };

  const targetCheck = await checkProviderConnection(router, target, timeoutMs);
  if (!targetCheck.ok) {
    return { outcome: "provider_unavailable", provider: target, failure: targetCheck.failure };
  }
  const holders = STORAGE_PROVIDERS.filter(
    (provider) => provider !== target && holdsObjects(view.objects[provider]),
  );
  const warnings: ProviderWarning[] = [];
  for (const provider of holders) {
    const check = await checkProviderConnection(router, provider, timeoutMs);
    if (!check.ok) warnings.push({ provider, failure: check.failure });
  }

  const switched = await db.$transaction(async (tx) => {
    await lockSettingsForUpdate(tx);
    // Only from the exact settings the checks above were made against: a concurrent save
    // (e.g. a new Wasabi bucket) or switch increments the version and this one is stale.
    const updated = await tx.platformStorageSettings.updateMany({
      where: { id: 1, writeProvider: from, version: view.version },
      data: { writeProvider: target, version: { increment: 1 } },
    });
    if (updated.count !== 1) return false;
    await recordAudit(
      tx,
      { workspaceId: null, userId: admin.userId },
      {
        action: "storage.write_provider_changed",
        entityType: "storage_settings",
        metadata: {
          from,
          to: target,
          unavailableProviders: warnings.map((warning) => warning.provider),
        },
      },
    );
    return true;
  });
  return switched ? { outcome: "changed", from, to: target, warnings } : { outcome: "stale" };
}

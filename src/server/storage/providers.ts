import "server-only";

import { createHash } from "node:crypto";

import { getSystemDb } from "../db/client";
import { parseStorageDriver, parseWasabiCredentials, type WasabiCredentials } from "../env-schema";
import { AppError } from "../errors/app-error";

import { MemoryStorageService } from "./memory-storage";
import type {
  StorageProviderId,
  StorageRouter,
  StorageService,
  StorageTransaction,
  StorageWriteTarget,
} from "./storage";
import { createWasabiStorage, wasabiSettingsSchema, type WasabiSettings } from "./wasabi-storage";

import { getStorage } from ".";

import type { PrismaClient } from "@/generated/prisma/client";

// Which storage service holds which objects (platform-wide; not tenant data).
//
// - Every object row records its provider. Reads and deletes go to THAT provider, so
//   objects stay reachable whatever is configured for new writes.
// - New objects go to the write provider from platform_storage_settings (LEGACY_S3 until
//   a platform administrator changes it, see storage-admin.ts).
// - LEGACY_S3 is the original S3_* environment configuration; WASABI combines the admin's
//   non-secret settings with access keys from the environment.
// - A provider that is not fully configured is never replaced by another one: using it
//   fails with SERVICE_UNAVAILABLE instead of silently reading or writing elsewhere.
//
// SYSTEM PATH (reviewed): reads only the single platform_storage_settings row.

export interface PlatformStorageSettingsRow {
  readonly writeProvider: StorageProviderId;
  readonly wasabiRegion: string | null;
  readonly wasabiEndpoint: string | null;
  readonly wasabiBucket: string | null;
  /** Incremented by every settings change (optimistic concurrency). */
  readonly version: number;
}

const DEFAULT_SETTINGS: PlatformStorageSettingsRow = {
  writeProvider: "LEGACY_S3",
  wasabiRegion: null,
  wasabiEndpoint: null,
  wasabiBucket: null,
  version: 0,
};

/** The platform storage settings (defaults when no administrator has saved any yet). */
export async function readStorageSettings(
  system: PrismaClient,
): Promise<PlatformStorageSettingsRow> {
  const row = await system.platformStorageSettings.findUnique({
    where: { id: 1 },
    select: {
      writeProvider: true,
      wasabiRegion: true,
      wasabiEndpoint: true,
      wasabiBucket: true,
      version: true,
    },
  });
  return row ?? DEFAULT_SETTINGS;
}

export type WasabiMissing = "region" | "endpoint" | "bucket" | "credentials";

export type WasabiStatus =
  | {
      readonly state: "ready";
      readonly settings: WasabiSettings;
      readonly credentials: WasabiCredentials;
    }
  | { readonly state: "incomplete"; readonly missing: readonly WasabiMissing[] };

/** Whether Wasabi can be used: complete, valid settings and both access keys. */
export function resolveWasabi(
  row: Pick<PlatformStorageSettingsRow, "wasabiRegion" | "wasabiEndpoint" | "wasabiBucket">,
  credentials: WasabiCredentials | null,
): WasabiStatus {
  const parsed = wasabiSettingsSchema.safeParse({
    region: row.wasabiRegion ?? "",
    endpoint: row.wasabiEndpoint ?? "",
    bucket: row.wasabiBucket ?? "",
  });
  const missing: WasabiMissing[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (
        (field === "region" || field === "endpoint" || field === "bucket") &&
        !missing.includes(field)
      ) {
        missing.push(field);
      }
    }
  }
  if (credentials === null) missing.push("credentials");
  if (!parsed.success || credentials === null) return { state: "incomplete", missing };
  return { state: "ready", settings: parsed.data, credentials };
}

export interface StorageRouterOptions {
  /** Client for the settings row (the retention run passes its bounded pool). */
  readonly system: PrismaClient;
  /** The LEGACY_S3 service (default: the S3_* environment store, or memory in test mode). */
  readonly legacy?: () => StorageService;
  /** Wasabi access keys (default: WASABI_* environment variables). */
  readonly wasabiCredentials?: () => WasabiCredentials | null;
  /** Builds the Wasabi service (default: the S3 adapter; memory in test mode). */
  readonly makeWasabi?: (
    settings: WasabiSettings,
    credentials: WasabiCredentials,
  ) => StorageService;
}

export interface ConfiguredStorageRouter extends StorageRouter {
  /** Where new objects are written now. Throws SERVICE_UNAVAILABLE if unusable. */
  writeTarget(): Promise<StorageWriteTarget>;
  /** The platform settings and Wasabi's readiness (for the admin view). */
  status(): Promise<{
    readonly settings: PlatformStorageSettingsRow;
    readonly wasabi: WasabiStatus;
    readonly legacyConfigured: boolean;
  }>;
}

/**
 * Inside a new object's insert transaction: share-locks the settings row and refuses
 * the insert if Wasabi's location is no longer the one the object was written to.
 * (LEGACY_S3's location comes from the environment and cannot change at runtime.)
 */
async function confirmWasabiLocation(
  tx: StorageTransaction,
  written: Pick<PlatformStorageSettingsRow, "wasabiRegion" | "wasabiEndpoint" | "wasabiBucket">,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { region: string | null; endpoint: string | null; bucket: string | null }[]
  >`
    SELECT "wasabi_region" AS "region", "wasabi_endpoint" AS "endpoint", "wasabi_bucket" AS "bucket"
    FROM "platform_storage_settings" WHERE "id" = 1 FOR SHARE`;
  const current = rows[0];
  if (
    current?.region !== written.wasabiRegion ||
    current.endpoint !== written.wasabiEndpoint ||
    current.bucket !== written.wasabiBucket
  ) {
    throw new AppError("CONFLICT", {
      message: "The storage location changed while the object was being written",
      metadata: { provider: "WASABI", reason: "storage_location_changed" },
    });
  }
}

function notConfigured(provider: StorageProviderId, missing: readonly string[]): AppError {
  return new AppError("SERVICE_UNAVAILABLE", {
    message: "Storage provider is not configured",
    metadata: { provider, missing },
  });
}

/** Same settings + same keys → the same client (a rotated key builds a new one). */
function fingerprint(settings: WasabiSettings, credentials: WasabiCredentials): string {
  return createHash("sha256")
    .update(
      [
        settings.region,
        settings.endpoint,
        settings.bucket,
        credentials.accessKeyId,
        credentials.secretAccessKey,
      ].join("\n"),
    )
    .digest("hex");
}

const globalForWasabi = globalThis as typeof globalThis & {
  __flexibxWasabiServices?: Map<string, StorageService>;
  __flexibxWasabiMemory?: MemoryStorageService;
};

function defaultMakeWasabi(settings: WasabiSettings, credentials: WasabiCredentials) {
  // Automated runs without object storage (STORAGE_DRIVER=test-memory): a separate
  // in-process store, so routing between providers stays observable.
  if (parseStorageDriver(process.env) === "test-memory") {
    globalForWasabi.__flexibxWasabiMemory ??= new MemoryStorageService();
    return globalForWasabi.__flexibxWasabiMemory;
  }
  const services = (globalForWasabi.__flexibxWasabiServices ??= new Map());
  const key = fingerprint(settings, credentials);
  let service = services.get(key);
  if (service === undefined) {
    service = createWasabiStorage(settings, credentials);
    services.clear(); // only the current configuration is kept
    services.set(key, service);
  }
  return service;
}

function defaultLegacyConfigured(): boolean {
  try {
    getStorage();
    return true;
  } catch {
    return false;
  }
}

export function createStorageRouter(options: StorageRouterOptions): ConfiguredStorageRouter {
  const legacy = options.legacy ?? getStorage;
  const readCredentials = options.wasabiCredentials ?? (() => parseWasabiCredentials(process.env));
  // Malformed keys count as missing: the admin view says "credentials", never the value.
  const credentials = () => {
    try {
      return readCredentials();
    } catch {
      return null;
    }
  };
  const makeWasabi = options.makeWasabi ?? defaultMakeWasabi;

  /** The service for `provider`, built from one settings snapshot. */
  const serviceFor = (
    provider: StorageProviderId,
    settings: PlatformStorageSettingsRow,
  ): StorageService => {
    if (provider === "LEGACY_S3") {
      try {
        return legacy();
      } catch {
        throw notConfigured(provider, ["environment"]);
      }
    }
    const status = resolveWasabi(settings, credentials());
    if (status.state !== "ready") throw notConfigured(provider, status.missing);
    return makeWasabi(status.settings, status.credentials);
  };

  const forProvider = async (provider: StorageProviderId): Promise<StorageService> =>
    // LEGACY_S3 needs no database read; WASABI reads the settings row once.
    serviceFor(
      provider,
      provider === "LEGACY_S3" ? DEFAULT_SETTINGS : await readStorageSettings(options.system),
    );

  return {
    forProvider,
    async writeTarget() {
      // One snapshot decides the provider, its service and what confirm() checks against.
      const settings = await readStorageSettings(options.system);
      const provider = settings.writeProvider;
      return {
        provider,
        storage: serviceFor(provider, settings),
        confirm: (tx) =>
          provider === "WASABI" ? confirmWasabiLocation(tx, settings) : Promise.resolve(),
      };
    },
    async status() {
      const settings = await readStorageSettings(options.system);
      let legacyConfigured: boolean;
      if (options.legacy === undefined) {
        legacyConfigured = defaultLegacyConfigured();
      } else {
        try {
          options.legacy();
          legacyConfigured = true;
        } catch {
          legacyConfigured = false;
        }
      }
      return { settings, wasabi: resolveWasabi(settings, credentials()), legacyConfigured };
    },
  };
}

let appRouter: ConfiguredStorageRouter | undefined;

/** The application's router (application database pool). */
export function getStorageRouter(): ConfiguredStorageRouter {
  appRouter ??= createStorageRouter({ system: getSystemDb() });
  return appRouter;
}

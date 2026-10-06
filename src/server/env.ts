import "server-only";

import { parseServerEnv, parseStorageEnv, type ServerEnv, type StorageEnv } from "./env-schema";

// Validated lazily (on first use) rather than at import time, so `next build` and
// `prisma generate` work without runtime secrets. The first request fails fast with a
// readable error if configuration is invalid.
let serverEnv: ServerEnv | undefined;
let storageEnv: StorageEnv | undefined;

export function getEnv(): ServerEnv {
  serverEnv ??= parseServerEnv(process.env);
  return serverEnv;
}

/** Storage settings are validated only when the storage service is first used. */
export function getStorageEnv(): StorageEnv {
  storageEnv ??= parseStorageEnv(process.env);
  return storageEnv;
}

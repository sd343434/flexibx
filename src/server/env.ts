import "server-only";

import {
  parseAuthEnv,
  parseServerEnv,
  parseStorageEnv,
  type AuthEnv,
  type ServerEnv,
  type StorageEnv,
} from "./env-schema";

// Validated lazily (on first use) rather than at import time, so `next build` and
// `prisma generate` work without runtime secrets. The first request fails fast with a
// readable error if configuration is invalid.
let serverEnv: ServerEnv | undefined;
let storageEnv: StorageEnv | undefined;
let authEnv: AuthEnv | undefined;

export function getEnv(): ServerEnv {
  serverEnv ??= parseServerEnv(process.env);
  return serverEnv;
}

/** Storage settings are validated only when the storage service is first used. */
export function getStorageEnv(): StorageEnv {
  storageEnv ??= parseStorageEnv(process.env);
  return storageEnv;
}

/** Auth settings are validated only when the auth layer is first used. */
export function getAuthEnv(): AuthEnv {
  authEnv ??= parseAuthEnv(process.env);
  return authEnv;
}

import "server-only";

import { parseStorageDriver } from "../env-schema";
import { getStorageEnv } from "../env";
import { MemoryStorageService } from "./memory-storage";
import { S3StorageService } from "./s3-storage";
import type { StorageService } from "./storage";

export * from "./storage";

// One instance per process, shared by every server bundle (route handlers and server
// actions can be bundled separately; the memory driver must see a single object map).
const globalForStorage = globalThis as typeof globalThis & { __flexibxStorage?: StorageService };

/**
 * The configured storage service: S3-compatible by default (validates storage env on
 * first use), or in-process memory for automated end-to-end runs
 * (STORAGE_DRIVER=test-memory — never a real deployment).
 */
export function getStorage(): StorageService {
  globalForStorage.__flexibxStorage ??=
    parseStorageDriver(process.env) === "test-memory"
      ? new MemoryStorageService()
      : new S3StorageService(getStorageEnv());
  return globalForStorage.__flexibxStorage;
}

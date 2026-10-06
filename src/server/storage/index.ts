import "server-only";

import { getStorageEnv } from "../env";
import { S3StorageService } from "./s3-storage";
import type { StorageService } from "./storage";

export * from "./storage";

let storage: StorageService | undefined;

/** The configured storage service (S3-compatible). Validates storage env on first use. */
export function getStorage(): StorageService {
  storage ??= new S3StorageService(getStorageEnv());
  return storage;
}

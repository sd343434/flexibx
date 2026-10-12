import "server-only";

import {
  parseAdsEnv,
  parseBillingEnv,
  parseAiEnv,
  parseAuthEnv,
  parseServerEnv,
  parseStorageEnv,
  parseVideoEnv,
  type AdsEnv,
  type BillingEnv,
  type AiEnv,
  type AuthEnv,
  type ServerEnv,
  type StorageEnv,
  type VideoEnv,
} from "./env-schema";

// Validated lazily (on first use) rather than at import time, so `next build` and
// `prisma generate` work without runtime secrets. The first request fails fast with a
// readable error if configuration is invalid.
let serverEnv: ServerEnv | undefined;
let storageEnv: StorageEnv | undefined;
let authEnv: AuthEnv | undefined;
let aiEnv: AiEnv | undefined;
let videoEnv: VideoEnv | undefined;
let adsEnv: AdsEnv | undefined;
let billingEnv: BillingEnv | undefined;

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

/** AI provider settings are validated only when an AI feature is first used. */
export function getAiEnv(): AiEnv {
  aiEnv ??= parseAiEnv(process.env);
  return aiEnv;
}

/** Video provider settings are validated only when video generation is first used. */
export function getVideoEnv(): VideoEnv {
  videoEnv ??= parseVideoEnv(process.env);
  return videoEnv;
}

/** Advertising platform settings are validated only when the advertising area is used. */
export function getAdsEnv(): AdsEnv {
  adsEnv ??= parseAdsEnv(process.env);
  return adsEnv;
}

/** Credits settings are validated only when credits are first used. */
export function getBillingEnv(): BillingEnv {
  billingEnv ??= parseBillingEnv(process.env);
  return billingEnv;
}

import type { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

import type { WasabiCredentials } from "../env-schema";

import { S3StorageService } from "./s3-storage";

// Wasabi adapter: Wasabi is S3-compatible, so it is the existing S3 adapter configured with
// a Wasabi endpoint, region, bucket and access keys. Nothing Wasabi-specific leaks past this
// file. Endpoint form per Wasabi's S3 API documentation: https://s3.<region>.wasabisys.com
// (verify the region's service URL in the Wasabi console; no region or bucket is assumed).

/** Non-secret Wasabi settings, edited by platform administrators. */
export interface WasabiSettings {
  readonly region: string;
  readonly endpoint: string;
  readonly bucket: string;
}

const REGION = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/**
 * The S3 service hostnames Wasabi documents for a region ("Service URLs for Wasabi's
 * Storage Regions"): s3.<region>.wasabisys.com, and for us-east-1 also the original
 * s3.wasabisys.com. Short aliases (e.g. s3.nl-1.wasabisys.com) are not accepted: one
 * canonical form per region keeps the region and endpoint provably consistent.
 */
export function wasabiHostsForRegion(region: string): readonly string[] {
  const regional = `s3.${region}.wasabisys.com`;
  return region === "us-east-1" ? [regional, "s3.wasabisys.com"] : [regional];
}

/** Validation of the admin form (and of stored values before they are used). */
export const wasabiSettingsSchema = z
  .strictObject({
    region: z.string().trim().toLowerCase().regex(REGION, "region_invalid"),
    endpoint: z
      .string()
      .trim()
      .max(255)
      .refine(isWasabiEndpoint, "endpoint_invalid")
      .transform((value) => new URL(value).origin),
    bucket: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "bucket_invalid")
      .refine((value) => !value.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(value), {
        message: "bucket_invalid",
      }),
  })
  // The endpoint must be the documented service URL of the region entered: a mismatched
  // pair would sign requests for one region and send them to another.
  .superRefine((value, ctx) => {
    // Only a pair of individually valid values is compared (each field reports its own
    // error otherwise, once).
    if (!REGION.test(value.region) || !isWasabiEndpoint(value.endpoint)) return;
    const host = new URL(value.endpoint).hostname;
    if (!wasabiHostsForRegion(value.region).includes(host)) {
      ctx.addIssue({ code: "custom", path: ["endpoint"], message: "endpoint_region_mismatch" });
    }
  });

/**
 * An https origin on a Wasabi S3 service hostname (s3.wasabisys.com or
 * s3.<region>.wasabisys.com), without credentials, path, query or port: keeps the "Wasabi"
 * provider from being pointed at an arbitrary host (or at Wasabi's console, IAM or STS).
 */
export function isWasabiEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === "" &&
    /^s3(\.[a-z]{2}-[a-z]+-\d{1,2})?\.wasabisys\.com$/.test(url.hostname)
  );
}

/** The Wasabi storage service (S3 API). `client` is for tests only. */
export function createWasabiStorage(
  settings: WasabiSettings,
  credentials: WasabiCredentials,
  client?: S3Client,
): S3StorageService {
  return new S3StorageService(
    {
      S3_REGION: settings.region,
      S3_BUCKET: settings.bucket,
      S3_ENDPOINT: settings.endpoint,
      S3_ACCESS_KEY_ID: credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      // Path-style addressing keeps bucket names with dots valid under TLS.
      S3_FORCE_PATH_STYLE: true,
      // Private bucket: objects are served only through access-checked routes.
      S3_PUBLIC_BASE_URL: undefined,
    },
    client,
  );
}

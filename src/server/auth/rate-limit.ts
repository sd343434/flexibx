import { AppError } from "../errors/app-error";

import type { Auth } from "./auth-config";
import {
  checkpointPath,
  RATE_LIMIT_RULES,
  subjectKey,
  type RateLimitBucket,
  type RateLimitRule,
} from "./rate-limit-policy";

// The limiter checkpoint for Flexibx's authentication entry points (see
// rate-limit-policy.ts). Pure (no `server-only`): built by auth.ts, used by tests.

export interface RateLimiterConfig {
  readonly secret: string;
  /** Public origin of the app (APP_URL); the checkpoint request's Origin. */
  readonly baseURL: string;
  /** Trusted client-IP header (AUTH_IP_HEADER); undefined = no client IP is trusted. */
  readonly ipHeader?: string | undefined;
}

export interface RateLimitCheck {
  readonly bucket: RateLimitBucket;
  /** Headers of the incoming request; only the trusted client-IP header is used. */
  readonly requestHeaders: Headers;
  /** Normalized email or user id, for subject-scoped buckets. */
  readonly subject?: string;
}

export type RateLimiter = (check: RateLimitCheck) => Promise<void>;

export function rateLimited(bucket: RateLimitBucket): AppError {
  // Same response whether or not an account exists; no IP or email in the metadata.
  return new AppError("RATE_LIMITED", { message: "Rate limit exceeded", metadata: { bucket } });
}

/**
 * Consumes one request from `bucket` through Better Auth's limiter, or throws
 * RATE_LIMITED. The checkpoint request copies nothing from the incoming request except
 * the configured client-IP header, and only for IP-scoped buckets, so a client cannot
 * pick its own key (an unconfigured `X-Forwarded-For` is never forwarded or read).
 * Any other failure of the checkpoint fails closed (INTERNAL).
 */
export function createRateLimiter(auth: Auth, config: RateLimiterConfig): RateLimiter {
  const origin = new URL(config.baseURL).origin;
  return async ({ bucket, requestHeaders, subject }) => {
    const rule: RateLimitRule = RATE_LIMIT_RULES[bucket];
    const headers = new Headers({ origin, "content-type": "application/json" });
    if (rule.scope === "ip" && config.ipHeader !== undefined) {
      const clientIp = requestHeaders.get(config.ipHeader);
      if (clientIp !== null) headers.set(config.ipHeader, clientIp);
    }
    if (rule.scope === "subject" && (subject === undefined || subject.trim() === "")) {
      throw new AppError("INTERNAL", {
        message: "Missing rate-limit subject",
        metadata: { bucket },
      });
    }
    const path = checkpointPath(
      bucket,
      subject === undefined ? undefined : subjectKey(config.secret, bucket, subject),
    );
    const response = await auth.handler(
      new Request(new URL(`/api/auth${path}`, config.baseURL), {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
    if (response.status === 429) throw rateLimited(bucket);
    if (!response.ok) {
      throw new AppError("INTERNAL", {
        message: "Rate-limit checkpoint failed",
        metadata: { bucket, status: response.status },
      });
    }
  };
}

import { createHmac } from "node:crypto";

// Authentication rate-limit policy: the single place that says which entry point is
// limited, by what key, and how hard. Pure (no `server-only`) for unit tests.
//
// Enforcement is Better Auth's own limiter (decision C8): its database storage
// (`rate_limits`), its client-IP resolution (`advanced.ipAddress`, decision 8) and its
// per-path rules. Flexibx's sign-in, sign-up, reset, verification and invitation entry
// points call Better Auth server-side (`auth.api.*`), which bypasses the HTTP router
// where the limiter runs, so each of them first passes a limiter checkpoint: a request
// through `auth.handler` to the no-op endpoint `/flexibx/rate-limit/<bucket>[/<subject>]`
// (see rate-limit.ts). The limiter keys that request like any other:
// `<trusted client ip>|<path>`.
//
// Two scopes:
// - "ip":      keyed by the trusted client IP (or Better Auth's documented fallback
//              when none can be resolved: one shared bucket per path).
// - "subject": keyed by an account (normalized email or user id) across all clients;
//              the checkpoint request carries no client-IP header, so the IP part of the
//              key is constant, and the subject is an HMAC — the raw email never reaches
//              the database or the logs.

export type RateLimitScope = "ip" | "subject";

export interface RateLimitRule {
  readonly scope: RateLimitScope;
  /** Window length in seconds. */
  readonly window: number;
  /** Requests allowed per window. */
  readonly max: number;
  /**
   * Count in fixed windows (Pass 15) instead of Better Auth's own rule, under which the
   * count resets only after `window` seconds WITHOUT an allowed request: a caller steadier
   * than one call per window then gets `max` calls and is refused until it pauses for a
   * whole window (measured: a once-a-minute scheduler lost the tick for 10 of every
   * 22 minutes). For buckets called continuously by schedulers and monitors. See
   * fixedWindowSlot.
   */
  readonly fixedWindow?: true;
}

/**
 * STATUS: APPROVED — HUMAN DECISION (Phase 2). Changing a value needs a new human
 * decision; change them only here (the tests derive from this table).
 *
 * Approved limits (Phase 2, Step 8). Rationale per bucket:
 * - sign-in: 10/min per client stops online guessing from one source; 10 per 15 min per
 *   account slows distributed guessing against one account. Trade-off: an attacker can
 *   lock one account's sign-in for 15 minutes (accepted; no account lockout state).
 * - sign-up: 10 per 10 min per client limits scripted account creation.
 * - password-reset-request / verification-resend: 5 per 15 min per client, and only 3
 *   per hour per address, so nobody can flood someone's mailbox.
 * - password-reset / verify-email: token submissions. Tokens are not guessable; these
 *   bound the work an attacker can cause (10 / 20 per 15 min per client).
 * - change-password: 5 per 15 min per signed-in user (current-password guessing).
 * - invitation-accept: 20 per 15 min per client (tokens are 256-bit; bounds lookups).
 * - invitation-create: 50 per hour per inviting user (deferred from Step 7).
 *
 * STATUS: APPROVED — HUMAN DECISION (Phase 4). AI generation (the server action that
 * calls the AI provider; using a stored suggestion is not limited here):
 * - ai-generate: 20 per 10 min per signed-in user.
 * - ai-generate-workspace: 100 per hour per workspace (subject = workspace id), shared
 *   by all its members. A database-backed cap of 300 generations per workspace per day
 *   applies on top (src/server/ai/ai-service.ts).
 *
 * STATUS: APPROVED — HUMAN DECISION (2026-10-09). Internal video-retention endpoint
 * (POST/GET /api/internal/video-retention, scheduler and monitoring calls combined):
 * - video-retention: 12 per 10 min, one shared subject for all callers holding the
 *   bearer secret. Consumed only after the secret is verified, so unauthenticated
 *   requests never use up the scheduler's quota. The run's advisory lock still keeps
 *   one run at a time; this limit only bounds how often the endpoint can be hit.
 *
 * STATUS: PROPOSED — PENDING HUMAN DECISION. Internal automation tick endpoint
 * (POST /api/internal/automation-tick, recovery of interrupted tasks, scheduled planning,
 * advancing runs):
 * - automation-tick: 12 per 10 min, one shared subject for all callers holding the bearer
 *   secret (room for a once-a-minute schedule plus a retry). Counted in fixed 10-minute
 *   windows (Pass 15, `fixedWindow`), so a steady schedule is never refused. Consumed only after the
 *   secret is verified, as for video-retention.
 *
 * STATUS: PROPOSED — PENDING HUMAN DECISION (Phase C). Two-factor authentication:
 * - two-factor-verify: 20 per 15 min per client for the sign-in second step. Better Auth
 *   adds 5 attempts per challenge and locks the account's factor for 15 minutes after
 *   10 consecutive failures, so a 6-digit code cannot be guessed online.
 * - two-factor-manage: 10 per 15 min per signed-in user for enroll / confirm / disable /
 *   regenerate backup codes (password and code guessing by a session holder).
 * - ops-status: 60 per 10 min, one shared subject for all callers holding the bearer
 *   secret of GET /api/internal/ops-status (an uptime monitor polling every minute plus
 *   manual checks). Consumed only after the secret is verified.
 */
export const RATE_LIMIT_RULES = {
  "sign-in": { scope: "ip", window: 60, max: 10 },
  "sign-in-account": { scope: "subject", window: 900, max: 10 },
  "sign-up": { scope: "ip", window: 600, max: 10 },
  "password-reset-request": { scope: "ip", window: 900, max: 5 },
  "password-reset-request-account": { scope: "subject", window: 3600, max: 3 },
  "password-reset": { scope: "ip", window: 900, max: 10 },
  "verification-resend": { scope: "ip", window: 900, max: 5 },
  "verification-resend-account": { scope: "subject", window: 3600, max: 3 },
  "verify-email": { scope: "ip", window: 900, max: 20 },
  "change-password": { scope: "subject", window: 900, max: 5 },
  "invitation-accept": { scope: "ip", window: 900, max: 20 },
  "invitation-create": { scope: "subject", window: 3600, max: 50 },
  "ai-generate": { scope: "subject", window: 600, max: 20 },
  "ai-generate-workspace": { scope: "subject", window: 3600, max: 100 },
  "video-retention": { scope: "subject", window: 600, max: 12, fixedWindow: true },
  "automation-tick": { scope: "subject", window: 600, max: 12, fixedWindow: true },
  "two-factor-verify": { scope: "ip", window: 900, max: 20 },
  "two-factor-manage": { scope: "subject", window: 900, max: 10 },
  "ops-status": { scope: "subject", window: 600, max: 60, fixedWindow: true },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMIT_RULES;

export const RATE_LIMIT_BUCKETS = Object.keys(RATE_LIMIT_RULES) as RateLimitBucket[];

/** Better Auth path prefix of the limiter checkpoint endpoint (internal only). */
export const RATE_LIMIT_CHECKPOINT_PREFIX = "/flexibx/rate-limit";

/**
 * Opaque, stable identifier for a subject (normalized email or user id) within a
 * bucket: HMAC-SHA256 keyed with AUTH_SECRET, so a leaked `rate_limits` table cannot be
 * reversed by hashing a list of known emails.
 */
/**
 * The subject suffix of a fixed-window bucket: the parity of the current window. Two keys
 * alternate, and a key is used again only two windows later, after at least one full
 * window without a request, so Better Auth's reset rule (`now - lastRequest >= window`)
 * always starts it from zero: at most `max` requests per fixed window, and two stored
 * rows per bucket instead of one per window. Empty for every other bucket.
 */
export function fixedWindowSlot(rule: RateLimitRule, nowMs: number): string {
  if (rule.fixedWindow !== true) return "";
  return `#w${String(Math.floor(nowMs / (rule.window * 1000)) % 2)}`;
}

export function subjectKey(secret: string, bucket: RateLimitBucket, subject: string): string {
  return createHmac("sha256", secret)
    .update(`${bucket}:${subject.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

/** The checkpoint path for one bucket (and subject, for subject-scoped buckets). */
export function checkpointPath(bucket: RateLimitBucket, subjectHash?: string): string {
  const rule: RateLimitRule = RATE_LIMIT_RULES[bucket];
  if (rule.scope === "subject") {
    if (subjectHash === undefined || !/^[0-9a-f]{32}$/.test(subjectHash)) {
      throw new Error(`Rate-limit bucket ${bucket} needs a subject key`);
    }
    return `${RATE_LIMIT_CHECKPOINT_PREFIX}/${bucket}/${subjectHash}`;
  }
  return `${RATE_LIMIT_CHECKPOINT_PREFIX}/${bucket}`;
}

/**
 * Better Auth `rateLimit.customRules`: one rule per bucket (exact path for IP buckets,
 * one wildcard segment for subject buckets) and none for `get-session`, which the proxy
 * calls on every page request to roll the session cookie (read-only; limiting it would
 * only break session renewal, and with no trusted IP all users would share one bucket).
 */
export function betterAuthCustomRules(): Record<string, { window: number; max: number } | false> {
  const rules: Record<string, { window: number; max: number } | false> = {
    "/get-session": false,
  };
  for (const bucket of RATE_LIMIT_BUCKETS) {
    const rule: RateLimitRule = RATE_LIMIT_RULES[bucket];
    const path =
      rule.scope === "subject"
        ? `${RATE_LIMIT_CHECKPOINT_PREFIX}/${bucket}/*`
        : `${RATE_LIMIT_CHECKPOINT_PREFIX}/${bucket}`;
    rules[path] = { window: rule.window, max: rule.max };
  }
  return rules;
}

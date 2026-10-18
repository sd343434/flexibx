import { createHmac } from "node:crypto";

import { z } from "zod";

import type { PerformanceMetric } from "@/generated/prisma/enums";

import { graphFailureKind } from "../meta/graph-errors";

// Reading Meta insights through the Graph API (Pass 6). Pure (no `server-only`, `fetch`,
// clock, sleep and randomness injected) so every failure mode is testable. Only GET
// requests are made, so a failed call can be retried safely; nothing is ever written to
// Meta. The Graph version is the deployment's META_GRAPH_VERSION (one place, env-schema).
//
// Endpoints (Graph API, read-only):
// - GET /{page-id}/insights?metric=…&period=day&since=…&until=…   (a Page's daily numbers)
// - GET /{ig-user-id}/insights?metric=…&period=day&metric_type=total_value&since&until
//   (an Instagram professional account's numbers for one day)
// - GET /{post-id}/insights?metric=…                    (a Page post's lifetime numbers)
// - GET /{post-id}?fields=reactions.summary(total_count).limit(0),
//       comments.summary(total_count).limit(0),shares     (a Page post's interactions)
// Every call carries `appsecret_proof` and a Page access token that the caller obtained
// for this run and never stores; tokens are never put into errors or logs.
//
// One metric per request: Meta rejects a whole request when one name in `metric=` is
// unknown or deprecated, and names change (impressions became views in 2025). A metric
// Meta does not offer for this account is reported as UNSUPPORTED — never as zero — and a
// missing value (null, or a day absent from the answer) is simply not stored.

/** Permissions each kind of source needs (checked against the connection's grant). */
export const META_INSIGHTS_SCOPES = {
  FACEBOOK_PAGE: ["pages_show_list", "pages_read_engagement", "read_insights"],
  INSTAGRAM_ACCOUNT: [
    "pages_show_list",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_manage_insights",
  ],
} as const;

/** Every permission the insights integration asks for at sign-in. */
export const ALL_META_INSIGHTS_SCOPES: readonly string[] = [
  ...new Set([...META_INSIGHTS_SCOPES.FACEBOOK_PAGE, ...META_INSIGHTS_SCOPES.INSTAGRAM_ACCOUNT]),
];

export interface MetricSpec {
  /** Meta's metric name. */
  readonly graph: string;
  readonly metric: PerformanceMetric;
}

/**
 * The metrics read, by scope. The one place to change when Meta renames a metric.
 * Checked against Meta's 2025 changes (Page impressions → page_media_view, unique
 * impressions → page_total_media_view_unique; Instagram impressions → views); confirm
 * against the Graph version in use before relying on a new one.
 */
export const META_METRIC_CATALOG = {
  page: [
    { graph: "page_media_view", metric: "VIEWS" },
    { graph: "page_total_media_view_unique", metric: "REACH" },
    { graph: "page_post_engagements", metric: "ENGAGEMENTS" },
  ],
  instagram: [
    { graph: "views", metric: "VIEWS" },
    { graph: "reach", metric: "REACH" },
    { graph: "total_interactions", metric: "ENGAGEMENTS" },
  ],
  post: [
    { graph: "post_media_view", metric: "VIEWS" },
    { graph: "post_total_media_view_unique", metric: "REACH" },
    { graph: "post_clicks", metric: "CLICKS" },
  ],
} as const satisfies Record<string, readonly MetricSpec[]>;

/** Failures that stop a whole run (the rest are reported per metric or per post). */
export type InsightsFailure =
  | "token_expired"
  | "permission_missing"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_malformed"
  | "call_budget_reached"
  | "deadline_reached";

export class InsightsProviderError extends Error {
  readonly code: InsightsFailure;
  /** Meta's numeric error code when it gave one (safe to record). */
  readonly platformCode: number | null;

  constructor(code: InsightsFailure, platformCode: number | null = null) {
    super(`Meta insights: ${code}`);
    this.name = "InsightsProviderError";
    this.code = code;
    this.platformCode = platformCode;
  }

  /** Worth trying the same call again after a pause. */
  get retryable(): boolean {
    return (
      this.code === "rate_limited" ||
      this.code === "provider_unavailable" ||
      this.code === "provider_timeout"
    );
  }
}

/** A metric or object Meta does not offer here (per call; the run goes on). */
type CallOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "unsupported" }
  | { readonly status: "not_found" };

export interface DailyPoint {
  /** The reporting day (UTC midnight of the day Meta reports). */
  readonly day: Date;
  readonly value: bigint;
}

export interface RetryPolicy {
  /** Attempts per call, including the first. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };
/** Per request. */
export const INSIGHTS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Delay before retry `attempt` (1 = the first retry): exponential, capped, with "equal
 * jitter" (half fixed, half random) so many workspaces do not retry in step.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * Math.min(Math.max(random(), 0), 1));
}

export interface MetaInsightsConfig {
  readonly appSecret: string;
  /** e.g. v26.0 (META_GRAPH_VERSION). */
  readonly version: string;
  readonly fetch?: typeof fetch;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Limits of one run: calls made and a deadline (both shared by every call of the run). */
export interface CallBudget {
  readonly maxCalls: number;
  calls: number;
  /** Aborted when the run's time is up. */
  readonly signal: AbortSignal;
}

/** Read through a function: the signal can be aborted while a call is awaited. */
const isAborted = (budget: CallBudget) => budget.signal.aborted;

export function createCallBudget(maxCalls: number, signal: AbortSignal): CallBudget {
  return { maxCalls, calls: 0, signal };
}

const graphError = z.object({
  error: z.object({
    code: z.number().int().optional(),
    error_subcode: z.number().int().optional(),
  }),
});
const metricValue = z.union([z.number(), z.string(), z.null()]).optional();
const insightsResponse = z.object({
  data: z.array(
    z.object({
      name: z.string().max(100),
      values: z
        .array(z.object({ value: metricValue, end_time: z.string().max(40).optional() }))
        .max(200)
        .optional(),
      total_value: z.object({ value: metricValue }).optional(),
    }),
  ),
});
const postFields = z.object({
  id: z.string().max(128),
  reactions: z.object({ summary: z.object({ total_count: z.number() }) }).optional(),
  comments: z.object({ summary: z.object({ total_count: z.number() }) }).optional(),
  shares: z.object({ count: z.number() }).optional(),
});

const ID = /^[0-9]{1,30}(_[0-9]{1,30})?$/;
const DAY_MS = 86_400_000;
const MAX_VALUE = 1_000_000_000_000n;

/** A whole, non-negative count; null when the value is absent (never coerced to 0). */
function countOf(value: unknown): bigint | null | "invalid" {
  if (value === null || value === undefined) return null;
  const number = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return "invalid";
  const big = BigInt(number);
  return big > MAX_VALUE ? "invalid" : big;
}

const isoDay = (at: Date) => at.toISOString().slice(0, 10);
const utcDay = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

export interface MetaInsightsClient {
  /** A Page's daily values of one metric over [from, to] (inclusive days). */
  pageDaily(
    pageToken: string,
    pageId: string,
    spec: MetricSpec,
    from: Date,
    to: Date,
    budget: CallBudget,
  ): Promise<CallOutcome<readonly DailyPoint[]>>;
  /** An Instagram professional account's value of one metric for one day. */
  instagramDay(
    pageToken: string,
    accountId: string,
    spec: MetricSpec,
    day: Date,
    budget: CallBudget,
  ): Promise<CallOutcome<bigint | null>>;
  /** A Page post's lifetime value of one metric (so far). */
  postLifetime(
    pageToken: string,
    postId: string,
    spec: MetricSpec,
    budget: CallBudget,
  ): Promise<CallOutcome<bigint | null>>;
  /** A Page post's reactions + comments + shares, as the post reports them now. */
  postInteractions(
    pageToken: string,
    postId: string,
    budget: CallBudget,
  ): Promise<CallOutcome<bigint>>;
}

export function createMetaInsightsClient(config: MetaInsightsConfig): MetaInsightsClient {
  const http = config.fetch ?? fetch;
  const retry = config.retry ?? DEFAULT_RETRY;
  const sleep =
    config.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = config.random ?? Math.random;
  const graph = `https://graph.facebook.com/${config.version}`;
  const proof = (token: string) =>
    createHmac("sha256", config.appSecret).update(token).digest("hex");

  /** One GET; resolves to the parsed JSON, "unsupported" or "not_found", or throws. */
  async function once(
    path: string,
    params: Record<string, string>,
    token: string,
    budget: CallBudget,
  ): Promise<unknown> {
    if (budget.signal.aborted) throw new InsightsProviderError("deadline_reached");
    if (budget.calls >= budget.maxCalls) throw new InsightsProviderError("call_budget_reached");
    budget.calls += 1;
    const url = new URL(`${graph}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", token);
    url.searchParams.set("appsecret_proof", proof(token));
    let response: Response;
    try {
      response = await http(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(INSIGHTS_REQUEST_TIMEOUT_MS), budget.signal]),
        cache: "no-store",
        // The URL carries the token: never follow a redirect to another host.
        redirect: "error",
      });
    } catch (error) {
      if (isAborted(budget)) throw new InsightsProviderError("deadline_reached");
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new InsightsProviderError(timedOut ? "provider_timeout" : "provider_unavailable");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const failure = graphError.safeParse(body);
    if (!response.ok || failure.success) {
      const code = failure.success ? (failure.data.error.code ?? null) : null;
      const kind = graphFailureKind(code);
      if (kind === "token_expired" || response.status === 401) {
        throw new InsightsProviderError("token_expired", code);
      }
      if (kind === "permission_missing" || response.status === 403) {
        throw new InsightsProviderError("permission_missing", code);
      }
      if (kind === "rate_limited" || response.status === 429) {
        throw new InsightsProviderError("rate_limited", code);
      }
      // 100: an invalid parameter — for insights, a metric this object does not offer
      // (or a name Meta retired); for an object read, an object that no longer exists.
      if (kind === "invalid_request") return { __outcome: "invalid" } as const;
      if (response.status === 404) return { __outcome: "not_found" } as const;
      // 1 / 2 / 5xx: Meta's side; anything else unknown is treated the same way.
      throw new InsightsProviderError("provider_unavailable", code);
    }
    return body;
  }

  /** `once` with bounded retries (exponential backoff with jitter) for transient failures. */
  async function get(
    path: string,
    params: Record<string, string>,
    token: string,
    budget: CallBudget,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(path, params, token, budget);
      } catch (error) {
        if (!(error instanceof InsightsProviderError) || !error.retryable) throw error;
        if (attempt >= retry.attempts) throw error;
        await sleep(backoffDelay(attempt, retry, random));
        if (isAborted(budget)) throw new InsightsProviderError("deadline_reached");
      }
    }
  }

  const outcomeOf = (body: unknown): "invalid" | "not_found" | null => {
    if (typeof body === "object" && body !== null && "__outcome" in body) {
      return (body as { __outcome: "invalid" | "not_found" }).__outcome;
    }
    return null;
  };

  const checkId = (id: string) => {
    if (!ID.test(id)) throw new InsightsProviderError("provider_malformed");
  };

  /** The named metric's entry, or the response is malformed. */
  function entryOf(body: unknown, spec: MetricSpec) {
    const parsed = insightsResponse.safeParse(body);
    if (!parsed.success) throw new InsightsProviderError("provider_malformed");
    const entry = parsed.data.data.find((item) => item.name === spec.graph);
    return entry ?? null;
  }

  return {
    async pageDaily(pageToken, pageId, spec, from, to, budget) {
      checkId(pageId);
      const body = await get(
        `/${pageId}/insights`,
        {
          metric: spec.graph,
          period: "day",
          since: isoDay(from),
          // `until` is exclusive: the day after the last day asked for.
          until: isoDay(new Date(to.getTime() + DAY_MS)),
        },
        pageToken,
        budget,
      );
      const outcome = outcomeOf(body);
      if (outcome === "invalid") return { status: "unsupported" };
      if (outcome === "not_found") return { status: "not_found" };
      const entry = entryOf(body, spec);
      // No entry: Meta has no values for these days (missing — not zero, and not an
      // unsupported metric, which Meta answers with an error).
      if (entry === null) return { status: "ok", value: [] };
      const points: DailyPoint[] = [];
      for (const item of entry.values ?? []) {
        const value = countOf(item.value);
        if (value === "invalid") throw new InsightsProviderError("provider_malformed");
        if (value === null || item.end_time === undefined) continue;
        const end = Date.parse(item.end_time);
        if (Number.isNaN(end)) throw new InsightsProviderError("provider_malformed");
        // A daily value's end_time is the end of its reporting day (Pacific time): the
        // day reported is the one before it.
        const day = utcDay(new Date(end - DAY_MS));
        if (day < utcDay(from) || day > utcDay(to)) continue;
        points.push({ day, value });
      }
      return { status: "ok", value: points };
    },

    async instagramDay(pageToken, accountId, spec, day, budget) {
      checkId(accountId);
      const start = utcDay(day);
      const body = await get(
        `/${accountId}/insights`,
        {
          metric: spec.graph,
          period: "day",
          metric_type: "total_value",
          since: String(Math.floor(start.getTime() / 1000)),
          until: String(Math.floor((start.getTime() + DAY_MS) / 1000)),
        },
        pageToken,
        budget,
      );
      const outcome = outcomeOf(body);
      if (outcome === "invalid") return { status: "unsupported" };
      if (outcome === "not_found") return { status: "not_found" };
      const entry = entryOf(body, spec);
      if (entry === null) return { status: "ok", value: null };
      const value = countOf(entry.total_value?.value ?? entry.values?.[0]?.value);
      if (value === "invalid") throw new InsightsProviderError("provider_malformed");
      return { status: "ok", value };
    },

    async postLifetime(pageToken, postId, spec, budget) {
      checkId(postId);
      const body = await get(`/${postId}/insights`, { metric: spec.graph }, pageToken, budget);
      const outcome = outcomeOf(body);
      if (outcome === "invalid") return { status: "unsupported" };
      if (outcome === "not_found") return { status: "not_found" };
      const entry = entryOf(body, spec);
      if (entry === null) return { status: "ok", value: null };
      const value = countOf(entry.values?.[0]?.value ?? entry.total_value?.value);
      if (value === "invalid") throw new InsightsProviderError("provider_malformed");
      return { status: "ok", value };
    },

    async postInteractions(pageToken, postId, budget) {
      checkId(postId);
      const body = await get(
        `/${postId}`,
        {
          fields:
            "id,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares",
        },
        pageToken,
        budget,
      );
      const outcome = outcomeOf(body);
      // An unknown post id reads as an invalid parameter: the post is gone.
      if (outcome !== null) return { status: "not_found" };
      const parsed = postFields.safeParse(body);
      if (!parsed.success) throw new InsightsProviderError("provider_malformed");
      const parts = [
        parsed.data.reactions?.summary.total_count,
        parsed.data.comments?.summary.total_count,
        parsed.data.shares?.count ?? 0,
      ];
      // Reactions and comments come back whenever the post can be read; without them the
      // number would be a guess.
      if (parts.some((part) => part === undefined)) return { status: "unsupported" };
      let total = 0n;
      for (const part of parts) {
        const value = countOf(part);
        if (value === "invalid" || value === null)
          throw new InsightsProviderError("provider_malformed");
        total += value;
      }
      return { status: "ok", value: total };
    },
  };
}

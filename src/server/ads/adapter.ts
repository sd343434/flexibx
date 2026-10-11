import type { JsonValue } from "../orchestration/approval-snapshot";

import type {
  AccountSnapshot,
  AdCampaignSpec,
  AdDeliveryStatus,
  AdPlatform,
  UnifiedAdAccount,
} from "./model";

// The advertising platform boundary (pure types). One adapter per platform translates
// between the platform's official API and the unified model. Nothing above this boundary
// knows a platform's URLs, field names or error codes. Writes (creating or changing
// campaigns — spending money) exist only as `launchCampaign`, which only the approval
// workflow (workflows/ad-launch.ts) calls, after a person approved the exact actions
// that `describeLaunch` returns. An adapter that cannot do something says so in its
// capabilities; callers check them and show the operation as unavailable.

export const AD_CAPABILITIES = [
  "connect",
  "listAccounts",
  "readCampaigns",
  "readInsights",
  "launchCampaign",
] as const;
export type AdCapability = (typeof AD_CAPABILITIES)[number];
export type AdCapabilities = Readonly<Record<AdCapability, boolean>>;

/** Normalized platform failures (never the platform's message, which may echo input). */
export const AD_FAILURES = [
  "oauth_invalid",
  "permission_missing",
  "token_expired",
  "rate_limited",
  "invalid_request",
  "provider_error",
  "unavailable",
] as const;
export type AdFailure = (typeof AD_FAILURES)[number];

export class AdPlatformError extends Error {
  readonly kind: AdFailure;
  /** The platform's numeric error code, when it gave one (safe to log and audit). */
  readonly platformCode: number | null;
  /**
   * True when a WRITE may have taken effect even though it failed (network error after
   * sending, timeout, 5xx). Such a write is never retried blindly: it is reconciled first.
   */
  readonly uncertain: boolean;

  constructor(kind: AdFailure, platformCode: number | null = null, uncertain = false) {
    super(`Advertising platform error: ${kind}`);
    this.name = "AdPlatformError";
    this.kind = kind;
    this.platformCode = platformCode;
    this.uncertain = uncertain;
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "provider_error";
  }
}

export interface OAuthGrant {
  readonly accessToken: string;
  /** When `accessToken` stops working (null: no stated expiry). */
  readonly expiresAt: Date | null;
  /** Present for platforms whose stored credential is a refresh token (Snapchat). */
  readonly refreshToken?: string;
  readonly externalUser: { readonly id: string; readonly name: string | null };
  readonly grantedScopes: readonly string[];
}

/** A fresh access token minted from a stored refresh token. */
export interface RefreshedAccess {
  readonly accessToken: string;
  /** A different refresh token when the platform rotated it (then it replaces the stored one). */
  readonly refreshToken: string | null;
}

/** Everything a launch needs, deterministic and already validated by the server. */
export interface LaunchRequest {
  readonly planId: string;
  readonly accountExternalId: string;
  readonly currency: string;
  readonly budgetTotalMinor: number;
  /** Inclusive dates, YYYY-MM-DD, in the ad account's time zone. */
  readonly startDate: string;
  readonly endDate: string;
  readonly spec: AdCampaignSpec;
  readonly media: { readonly id: string; readonly filename: string } | null;
  /** The ad account's IANA time zone (schedules start at its midnight), when known. */
  readonly timeZone?: string | null;
  /** The publishing identity (Page / profile / identity id), once resolved. */
  readonly identityId?: string | null;
}

/** One call the platform would receive, exactly as it would be sent (minus credentials). */
export interface ExternalAction {
  readonly method: "POST";
  readonly endpoint: string;
  readonly params: Readonly<Record<string, JsonValue>>;
}

/** The objects a paused campaign is built from, in dependency order. */
export const EXECUTION_STEPS = ["media", "campaign", "adset", "creative", "ad"] as const;
export type ExecutionStepKey = (typeof EXECUTION_STEPS)[number];

/** The creative file a launch uploads (read from the workspace's media library). */
export interface MediaPayload {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

/** Everything one creation step needs. `tag` marks every created object (idempotency). */
export interface StepContext {
  readonly request: LaunchRequest;
  readonly tag: string;
  /** The publishing identity (Facebook Page, Snap profile, TikTok identity). */
  readonly identityId: string;
  /** External ids created by earlier steps. */
  readonly ids: Readonly<Partial<Record<ExecutionStepKey, string>>>;
  readonly media: MediaPayload | null;
  /** Aborted when the task times out: in-flight requests stop (their outcome is unknown). */
  readonly signal?: AbortSignal;
}

export interface ExternalState {
  readonly campaign: AdDeliveryStatus;
  readonly adSet: AdDeliveryStatus | null;
  readonly ad: AdDeliveryStatus | null;
}

/**
 * A platform's write path. Called ONLY by the shared execution service
 * (ads/execution.ts), inside an approved orchestration task. Every created object is
 * PAUSED; `activate` is a separate, separately approved action.
 */
export interface AdWriter {
  /** False: the boundary exists but cannot run here yet (see `blocker`). */
  readonly ready: boolean;
  /** Why the write path cannot run (documented platform requirement), when not ready. */
  readonly blocker: string | null;
  /** Permissions the connection must hold for writes (checked before any call). */
  readonly writeScopes: readonly string[];
  /** Whether this write path can build a campaign with this objective. */
  supportsObjective(objective: AdCampaignSpec["objective"]): boolean;
  /** Whether budgets in this account currency can be expressed exactly as the platform expects. */
  supportsCurrency(currency: string): boolean;
  /** Whether every chosen placement can be published with the identities this path has. */
  supportsPlacements(placements: readonly AdCampaignSpec["placements"][number][]): boolean;
  /** The steps this platform needs, in order (a subset of EXECUTION_STEPS). */
  readonly steps: readonly ExecutionStepKey[];
  /**
   * The identities (Facebook Pages, …) this connection may publish ads as. `complete` is
   * false when the list was cut short (then a missing identity proves nothing).
   */
  listIdentities(
    accessToken: string,
    accountExternalId: string,
  ): Promise<{
    readonly identities: readonly { readonly id: string; readonly name: string }[];
    readonly complete: boolean;
  }>;
  /** Creates one object (paused) and returns its external id. */
  runStep(accessToken: string, step: ExecutionStepKey, context: StepContext): Promise<string>;
  /** Finds an object a step may already have created (by its tag); null when none. */
  findStep(
    accessToken: string,
    step: ExecutionStepKey,
    context: StepContext,
  ): Promise<string | null>;
  /** Turns the created campaign, ad set and ad on. */
  activate(
    accessToken: string,
    request: LaunchRequest,
    ids: Readonly<Partial<Record<ExecutionStepKey, string>>>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** The objects' actual delivery status on the platform. */
  readState(
    accessToken: string,
    ids: Readonly<Partial<Record<ExecutionStepKey, string>>>,
    signal?: AbortSignal,
  ): Promise<ExternalState>;
}

export interface AdPlatformAdapter {
  readonly platform: AdPlatform;
  readonly capabilities: AdCapabilities;
  /** The scopes requested at connection, and the ones reading requires. */
  readonly requiredScopes: readonly string[];
  /**
   * What is stored (encrypted) for the workspace: the access token itself (Meta, a
   * long-lived user token; the default), or a refresh token from which a short-lived
   * access token is minted for each use (Snapchat) through `refreshAccessToken`.
   */
  readonly credential?: "access_token" | "refresh_token";
  refreshAccessToken?(refreshToken: string): Promise<RefreshedAccess>;
  authorizeUrl(params: { readonly state: string; readonly redirectUri: string }): string;
  exchangeCode(params: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<OAuthGrant>;
  listAccounts(accessToken: string): Promise<UnifiedAdAccount[]>;
  readAccount(
    accessToken: string,
    account: {
      readonly externalId: string;
      readonly currency: string;
      /** The account's IANA time zone (its reporting days), when known. */
      readonly timeZone?: string | null;
    },
    days: number,
  ): Promise<AccountSnapshot>;
  /** The exact external calls a launch makes (pure; shown for review and approval). */
  describeLaunch(request: LaunchRequest): readonly ExternalAction[];
  /** The write path (see AdWriter); absent for read-only platforms. */
  readonly writer?: AdWriter;
  /**
   * Legacy single-call launch, used only when there is no `writer`. Present only when
   * `capabilities.launchCampaign`; called only by the approval workflow.
   */
  launchCampaign?(
    accessToken: string,
    request: LaunchRequest,
  ): Promise<{ readonly externalCampaignId: string }>;
}

/** Why a platform cannot be used here (shown to people; never "working"). */
export type AdPlatformUnavailable = "not_configured" | "not_implemented";

export type AdPlatformEntry =
  | { readonly platform: AdPlatform; readonly available: true; readonly adapter: AdPlatformAdapter }
  | {
      readonly platform: AdPlatform;
      readonly available: false;
      readonly reason: AdPlatformUnavailable;
    };

export type AdAdapters = Readonly<Record<AdPlatform, AdPlatformEntry>>;

/** Days between two inclusive YYYY-MM-DD dates (1 for the same day). */
export function inclusiveDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";

import { recordAudit } from "../audit/audit-log";
import { getDb, getSystemDb } from "../db/client";
import type { GuardedPrismaClient } from "../db/prisma";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";
import { isRole } from "../tenancy/roles";
import { parseInput } from "../validation/parse";

import { AdPlatformError, type AdAdapters, type AdPlatformAdapter } from "./adapter";
import {
  adsError,
  adsNotConfigured,
  adsNotConnected,
  adsUnavailableOperation,
  failureCodeOf,
  fromPlatformError,
} from "./errors";
import { AD_PLATFORMS, type AdPlatform, type UnifiedAdAccount } from "./model";
import { adTokenKey, getAdAdapters, redirectUriFor } from "./registry";
import { decryptToken, encryptToken, TokenVaultError } from "./token-vault";
import { revokeSocialAccess } from "../social/channel-access";

// Workspace connections to advertising platforms: the OAuth handshake, the encrypted
// token's lifecycle, ad account discovery and selection, and read-only syncs. Every
// operation is scoped to the caller's workspace; connecting and selecting accounts need
// ads.manage (owners, admins), reading results ads.view, syncing ads.plan. A token is
// decrypted only inside `withPlatformToken`, used for the call and dropped.

export interface AdsDeps {
  readonly db: GuardedPrismaClient;
  readonly adapters: AdAdapters;
  /** ENCRYPTION_KEY, or null when not configured (then nothing can connect). */
  readonly tokenKey: string | null;
  readonly now?: () => Date;
}

/** How long a person has to finish the platform's consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Expired states are kept this long (support/debugging), then deleted. */
export const STATE_RETENTION_MS = 24 * 3_600_000;
/** Pending authorizations allowed per workspace in the TTL window (abuse bound). */
export const MAX_PENDING_STATES = 10;
/** Marks an account the connection no longer grants (see saveAccounts). */
export const ACCESS_LOST = "access_lost";
/** Days of results read per sync. */
export const SYNC_DAYS = 30;

const nowOf = (deps: { readonly now?: () => Date }) => (deps.now ?? (() => new Date()))();
export const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

const platformSchema = z.enum(AD_PLATFORMS);

/** The adapter of a platform this deployment can use, or the reason it cannot. */
export function adapterFor(adapters: AdAdapters, platform: AdPlatform): AdPlatformAdapter {
  const entry = adapters[platform];
  if (!entry.available) {
    throw entry.reason === "not_configured"
      ? adsNotConfigured()
      : adsUnavailableOperation(`${platform}.connect`);
  }
  return entry.adapter;
}

// ── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Starts a connection (ads.manage): stores a single-use state (only its hash) bound to
 * this person and workspace, and returns the platform's consent URL.
 */
export async function startConnection(
  deps: AdsDeps,
  ctx: TenantContext,
  input: { readonly platform: unknown; readonly locale: "ar" | "en"; readonly redirectUri: string },
): Promise<{ readonly url: string }> {
  assertCan(ctx, "ads.manage");
  const platform = parseInput(platformSchema, input.platform, "platform");
  const adapter = adapterFor(deps.adapters, platform);
  if (deps.tokenKey === null) throw adsNotConfigured();
  const now = nowOf(deps);
  const state = randomBytes(32).toString("base64url");
  await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId}::uuid FOR UPDATE`;
    // States are only useful for minutes: drop this workspace's long-expired ones.
    await tx.adOAuthState.deleteMany({
      where: {
        workspaceId: ctx.workspaceId,
        expiresAt: { lt: new Date(now.getTime() - STATE_RETENTION_MS) },
      },
    });
    const pending = await tx.adOAuthState.count({
      where: { workspaceId: ctx.workspaceId, consumedAt: null, expiresAt: { gt: now } },
    });
    if (pending >= MAX_PENDING_STATES) {
      throw new AppError("RATE_LIMITED", { metadata: { resource: "ad_oauth_state" } });
    }
    await tx.adOAuthState.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        platform,
        stateHash: hashState(state),
        locale: input.locale,
        createdAt: now,
        expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
      },
    });
    await recordAudit(tx, ctx, {
      action: "ads.connect_started",
      entityType: "ad_connection",
      entityId: null,
      metadata: { platform },
    });
  });
  return { url: adapter.authorizeUrl({ state, redirectUri: input.redirectUri }) };
}

export type ConnectOutcome =
  | "connected"
  | "oauth_invalid"
  | "denied"
  | "forbidden"
  | "permission_missing"
  | "not_configured"
  | "provider_error";

export interface ConnectResult {
  readonly outcome: ConnectOutcome;
  /** Where to send the person back (null when the state could not be trusted). */
  readonly slug: string | null;
  readonly locale: "ar" | "en";
}

/**
 * Completes the platform redirect. SYSTEM PATH (reviewed): the state is looked up by its
 * hash with the system client because the redirect carries no workspace; it is consumed
 * atomically (single use, unexpired), must belong to the signed-in person and to the
 * platform whose callback received it, and that person must still hold ads.manage in the
 * state's workspace. Only then is the code exchanged, the credential encrypted and
 * stored (the access token, or the refresh token for refresh-token platforms), and the
 * ad accounts discovered.
 */
export async function completeConnection(
  deps: AdsDeps & { readonly system: PrismaClient },
  input: {
    /** The platform whose callback received the redirect. */
    readonly platform: AdPlatform;
    readonly sessionUserId: string;
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
    readonly redirectUri: string;
  },
): Promise<ConnectResult> {
  const invalid: ConnectResult = { outcome: "oauth_invalid", slug: null, locale: "ar" };
  if (input.state === null || !/^[A-Za-z0-9_-]{20,128}$/.test(input.state)) return invalid;
  const now = nowOf(deps);
  const row = await deps.system.adOAuthState.findUnique({
    where: { stateHash: hashState(input.state) },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      platform: true,
      locale: true,
      workspace: { select: { slug: true, deletedAt: true } },
    },
  });
  if (row === null) return invalid;
  // Single use: whoever consumes it first wins; an expired or used state does nothing.
  const consumed = await deps.system.adOAuthState.updateMany({
    where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  const locale = row.locale === "en" ? "en" : "ar";
  if (
    consumed.count === 0 ||
    row.userId !== input.sessionUserId ||
    row.platform !== input.platform
  ) {
    return { outcome: "oauth_invalid", slug: null, locale };
  }
  const slug = row.workspace.deletedAt === null ? row.workspace.slug : null;
  const membership = await deps.system.workspaceMember.findFirst({
    where: { workspaceId: row.workspaceId, userId: row.userId, workspace: { deletedAt: null } },
    select: { role: true },
  });
  if (slug === null || membership === null || !isRole(membership.role)) {
    return { outcome: "forbidden", slug: null, locale };
  }
  const ctx: TenantContext = {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: membership.role,
  };
  if (!can(ctx.role, "ads.manage")) return { outcome: "forbidden", slug, locale };
  const platform = row.platform;

  const fail = async (outcome: ConnectOutcome, platformCode: number | null = null) => {
    await recordAudit(deps.db, ctx, {
      action: "ads.connect_failed",
      entityType: "ad_connection",
      entityId: null,
      metadata: { platform, reason: outcome, platformCode },
    });
    return { outcome, slug, locale } satisfies ConnectResult;
  };

  if (input.error !== null) return fail("denied");
  if (input.code === null || input.code.length > 2048) return fail("oauth_invalid");
  const entry = deps.adapters[platform];
  if (!entry.available || deps.tokenKey === null) return fail("not_configured");
  const adapter = entry.adapter;

  let grant;
  try {
    grant = await adapter.exchangeCode({ code: input.code, redirectUri: input.redirectUri });
  } catch (error) {
    if (error instanceof AdPlatformError) {
      return fail(
        error.kind === "oauth_invalid" || error.kind === "invalid_request"
          ? "oauth_invalid"
          : error.kind === "permission_missing"
            ? "permission_missing"
            : "provider_error",
        error.platformCode,
      );
    }
    throw error;
  }
  const missing = adapter.requiredScopes.filter((scope) => !grant.grantedScopes.includes(scope));
  const binding = { workspaceId: ctx.workspaceId, platform };
  const usesRefresh = adapter.credential === "refresh_token";
  const stored = usesRefresh ? (grant.refreshToken ?? null) : grant.accessToken;
  if (stored === null || stored === "") return fail("oauth_invalid");
  const ciphertext = missing.length === 0 ? encryptToken(deps.tokenKey, stored, binding) : null;

  const connection = await deps.db.$transaction(async (tx) => {
    const data = {
      status: missing.length === 0 ? ("ACTIVE" as const) : ("ERROR" as const),
      externalUserId: grant.externalUser.id,
      externalUserName: grant.externalUser.name,
      scopes: [...grant.grantedScopes],
      tokenCiphertext: ciphertext,
      // A refresh token states no expiry; the short access tokens are never stored.
      tokenExpiresAt: usesRefresh ? null : grant.expiresAt,
      connectedByUserId: ctx.userId,
      lastErrorCode: missing.length === 0 ? null : "permission_missing",
      lastCheckedAt: now,
    };
    const saved = await tx.adConnection.upsert({
      where: { workspaceId_platform: { workspaceId: ctx.workspaceId, platform } },
      create: { workspaceId: ctx.workspaceId, platform, ...data },
      update: { ...data, version: { increment: 1 } },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: missing.length === 0 ? "ads.connected" : "ads.connect_failed",
      entityType: "ad_connection",
      entityId: saved.id,
      metadata: {
        platform,
        scopes: [...grant.grantedScopes],
        ...(missing.length === 0 ? {} : { reason: "permission_missing", missing }),
      },
    });
    return saved;
  });
  if (missing.length > 0) return { outcome: "permission_missing", slug, locale };

  // Discover the ad accounts now; a failure here leaves a working connection to retry.
  try {
    const accounts = await adapter.listAccounts(grant.accessToken);
    await saveAccounts(deps.db, ctx, connection.id, platform, accounts);
  } catch (error) {
    await deps.db.adConnection.updateMany({
      where: { workspaceId: ctx.workspaceId, id: connection.id },
      data: { lastErrorCode: failureCodeOf(error).slice(0, 60) },
    });
  }
  return { outcome: "connected", slug, locale };
}

// ── Token access ─────────────────────────────────────────────────────────────

async function markConnection(
  db: Db,
  workspaceId: string,
  platform: AdPlatform,
  data: { readonly status?: "EXPIRED" | "ERROR"; readonly lastErrorCode: string },
) {
  await db.adConnection.updateMany({
    where: { workspaceId, platform, status: { in: ["ACTIVE", "ERROR", "EXPIRED"] } },
    data: { ...data, lastCheckedAt: new Date() },
  });
}

/**
 * Runs `callback` with the workspace's access token for `platform`: the decrypted stored
 * token, or — for refresh-token platforms — a fresh access token minted from the stored
 * refresh token for this call only (a rotated refresh token replaces the stored one).
 * Expired, revoked, unreadable or platform-rejected credentials update the connection's
 * status and surface as a clear error; tokens never leave this function's callback.
 */
export async function withPlatformToken<T>(
  deps: AdsDeps,
  workspaceId: string,
  platform: AdPlatform,
  callback: (token: string, adapter: AdPlatformAdapter) => Promise<T>,
): Promise<T> {
  const adapter = adapterFor(deps.adapters, platform);
  if (deps.tokenKey === null) throw adsNotConfigured();
  const connection = await deps.db.adConnection.findFirst({
    where: { workspaceId, platform },
    select: { status: true, tokenCiphertext: true, tokenExpiresAt: true },
  });
  const ciphertext = connection?.tokenCiphertext ?? null;
  if (connection === null || ciphertext === null || connection.status === "REVOKED") {
    throw adsNotConnected();
  }
  if (connection.status === "ERROR") throw adsError("CONFLICT", "ads_permission_missing");
  const now = nowOf(deps);
  if (
    connection.status === "EXPIRED" ||
    (connection.tokenExpiresAt !== null && connection.tokenExpiresAt <= now)
  ) {
    await markConnection(deps.db, workspaceId, platform, {
      status: "EXPIRED",
      lastErrorCode: "token_expired",
    });
    throw adsError("CONFLICT", "ads_token_expired");
  }
  let token: string;
  try {
    token = decryptToken(deps.tokenKey, ciphertext, { workspaceId, platform });
  } catch (error) {
    if (!(error instanceof TokenVaultError)) throw error;
    // Wrong key (rotated) or tampered row: unusable until reconnected.
    await markConnection(deps.db, workspaceId, platform, {
      status: "ERROR",
      lastErrorCode: "token_unreadable",
    });
    throw adsNotConnected();
  }
  try {
    if (adapter.credential === "refresh_token") {
      if (adapter.refreshAccessToken === undefined) throw new AdPlatformError("unavailable");
      const access = await adapter.refreshAccessToken(token);
      if (access.refreshToken !== null) {
        // Compare-and-set: a concurrent rotation or a reconnect keeps its own value.
        await deps.db.adConnection.updateMany({
          where: { workspaceId, platform, tokenCiphertext: ciphertext },
          data: {
            tokenCiphertext: encryptToken(deps.tokenKey, access.refreshToken, {
              workspaceId,
              platform,
            }),
          },
        });
      }
      return await callback(access.accessToken, adapter);
    }
    return await callback(token, adapter);
  } catch (error) {
    if (error instanceof AdPlatformError) {
      if (error.kind === "token_expired") {
        await markConnection(deps.db, workspaceId, platform, {
          status: "EXPIRED",
          lastErrorCode: "token_expired",
        });
      } else if (error.kind === "permission_missing") {
        await markConnection(deps.db, workspaceId, platform, {
          lastErrorCode: "permission_missing",
        });
      }
      throw fromPlatformError(error);
    }
    throw error;
  }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

async function saveAccounts(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  connectionId: string,
  platform: AdPlatform,
  accounts: readonly UnifiedAdAccount[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const account of accounts) {
      const data = {
        name: account.name,
        currency: account.currency,
        timeZone: account.timeZone,
        externalStatus: account.status,
      };
      await tx.adAccount.upsert({
        where: {
          connectionId_externalId: { connectionId, externalId: account.externalId },
          workspaceId: ctx.workspaceId,
        },
        create: {
          workspaceId: ctx.workspaceId,
          connectionId,
          platform,
          externalId: account.externalId,
          ...data,
        },
        update: data,
      });
    }
    // Partial or narrowed authorization: accounts this connection can no longer see are
    // deselected and marked, so nothing keeps planning or syncing against them. They are
    // kept (with their plans) and become usable again if access is granted back.
    const seen = accounts.map((account) => account.externalId);
    const lost = await tx.adAccount.updateMany({
      where: { workspaceId: ctx.workspaceId, connectionId, externalId: { notIn: seen } },
      data: { selected: false, syncErrorCode: ACCESS_LOST },
    });
    await tx.adAccount.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        connectionId,
        externalId: { in: seen },
        syncErrorCode: ACCESS_LOST,
      },
      data: { syncErrorCode: null },
    });
    await recordAudit(tx, ctx, {
      action: "ads.accounts_refreshed",
      entityType: "ad_connection",
      entityId: connectionId,
      metadata: { platform, accounts: accounts.length, accessLost: lost.count },
    });
  });
}

/** Re-reads the connection's ad accounts from the platform (ads.manage). */
export async function refreshAccounts(
  deps: AdsDeps,
  ctx: TenantContext,
  platformInput: unknown,
): Promise<{ readonly accounts: number }> {
  assertCan(ctx, "ads.manage");
  const platform = parseInput(platformSchema, platformInput, "platform");
  const connection = await deps.db.adConnection.findFirst({
    where: { workspaceId: ctx.workspaceId, platform },
    select: { id: true },
  });
  if (connection === null) throw adsNotConnected();
  const accounts = await withPlatformToken(deps, ctx.workspaceId, platform, (token, adapter) =>
    adapter.listAccounts(token),
  );
  await saveAccounts(deps.db, ctx, connection.id, platform, accounts);
  return { accounts: accounts.length };
}

/** Chooses whether the workspace works with an ad account (ads.manage). */
export async function selectAccount(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: { readonly accountId: string; readonly selected: boolean },
): Promise<void> {
  assertCan(ctx, "ads.manage");
  if (!isUuid(input.accountId)) throw notFound();
  await db.$transaction(async (tx) => {
    if (input.selected) {
      // Only an account the workspace's live connection still grants can be selected.
      const account = await tx.adAccount.findFirst({
        where: { workspaceId: ctx.workspaceId, id: input.accountId },
        select: { syncErrorCode: true, connection: { select: { status: true } } },
      });
      if (account === null) throw notFound();
      if (account.syncErrorCode === ACCESS_LOST || account.connection.status !== "ACTIVE") {
        throw adsError("CONFLICT", "ads_account_unavailable");
      }
    }
    const updated = await tx.adAccount.updateMany({
      where: { workspaceId: ctx.workspaceId, id: input.accountId },
      data: { selected: input.selected },
    });
    if (updated.count === 0) throw notFound();
    await recordAudit(tx, ctx, {
      action: "ads.account_selected",
      entityType: "ad_account",
      entityId: input.accountId,
      metadata: { selected: input.selected },
    });
  });
}

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "ad_account" } });

/**
 * Reads one selected account's campaigns, ad sets, ads and last-30-day results from the
 * platform (read-only) and stores them as the account's snapshot (ads.plan).
 */
export async function syncAccount(
  deps: AdsDeps,
  ctx: TenantContext,
  accountId: string,
): Promise<{ readonly campaigns: number }> {
  assertCan(ctx, "ads.plan");
  if (!isUuid(accountId)) throw notFound();
  const account = await deps.db.adAccount.findFirst({
    where: { workspaceId: ctx.workspaceId, id: accountId },
    select: {
      id: true,
      platform: true,
      externalId: true,
      currency: true,
      timeZone: true,
      selected: true,
    },
  });
  if (account === null) throw notFound();
  if (!account.selected) throw adsError("CONFLICT", "ads_account_unavailable");
  const adapter = adapterFor(deps.adapters, account.platform);
  if (!adapter.capabilities.readCampaigns) throw adsUnavailableOperation("readCampaigns");
  try {
    const snapshot = await withPlatformToken(deps, ctx.workspaceId, account.platform, (token) =>
      adapter.readAccount(
        token,
        { externalId: account.externalId, currency: account.currency, timeZone: account.timeZone },
        SYNC_DAYS,
      ),
    );
    await deps.db.$transaction(async (tx) => {
      await tx.adAccount.updateMany({
        where: { workspaceId: ctx.workspaceId, id: account.id },
        data: {
          snapshot: snapshot as object,
          lastSyncedAt: nowOf(deps),
          syncErrorCode: null,
        },
      });
      await recordAudit(tx, ctx, {
        action: "ads.synced",
        entityType: "ad_account",
        entityId: account.id,
        metadata: {
          platform: account.platform,
          campaigns: snapshot.campaigns.length,
          adSets: snapshot.adSets.length,
          ads: snapshot.ads.length,
          truncated: snapshot.truncated,
        },
      });
    });
    return { campaigns: snapshot.campaigns.length };
  } catch (error) {
    const field =
      error instanceof AppError ? (error.fields[0]?.code ?? error.code) : failureCodeOf(error);
    await deps.db.adAccount.updateMany({
      where: { workspaceId: ctx.workspaceId, id: account.id },
      data: { syncErrorCode: field.slice(0, 60) },
    });
    await recordAudit(deps.db, ctx, {
      action: "ads.sync_failed",
      entityType: "ad_account",
      entityId: account.id,
      metadata: { platform: account.platform, code: field.slice(0, 60) },
    });
    throw error;
  }
}

/**
 * Disconnects a platform (ads.manage): the stored token is deleted at once. Revoking the
 * app's access on the platform side is done by the person in their platform settings
 * (Flexibx makes no write call to the platform here).
 */
export async function disconnect(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  platformInput: unknown,
): Promise<void> {
  assertCan(ctx, "ads.manage");
  const platform = parseInput(platformSchema, platformInput, "platform");
  await db.$transaction(async (tx) => {
    const updated = await tx.adConnection.updateMany({
      where: { workspaceId: ctx.workspaceId, platform, status: { not: "REVOKED" } },
      data: {
        status: "REVOKED",
        tokenCiphertext: null,
        tokenExpiresAt: null,
        lastErrorCode: null,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw adsNotConnected();
    await tx.adAccount.updateMany({
      where: { workspaceId: ctx.workspaceId, platform },
      data: { selected: false },
    });
    // The Meta grant also serves the AI Social Manager: its Pages stop with it.
    const socialChannelsDisabled =
      platform === "META" ? await revokeSocialAccess(tx, ctx.workspaceId) : 0;
    await recordAudit(tx, ctx, {
      action: "ads.disconnected",
      entityType: "ad_connection",
      entityId: null,
      metadata: { platform, socialChannelsDisabled },
    });
  });
}

/** A platform's OAuth redirect, wired to this deployment's clients, adapters and key. */
export async function completePlatformCallback(
  platform: AdPlatform,
  input: {
    readonly sessionUserId: string;
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
  },
): Promise<ConnectResult> {
  return completeConnection(
    { db: getDb(), system: getSystemDb(), adapters: getAdAdapters(), tokenKey: adTokenKey() },
    { ...input, platform, redirectUri: redirectUriFor(platform) },
  );
}

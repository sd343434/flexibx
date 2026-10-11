import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { AdPlatformError } from "../ads/adapter";
import type { WhatsAppAdapter, WhatsAppBusinessSnapshot } from "../ads/adapters/whatsapp";
import { whatsAppSnapshotSchema } from "../ads/adapters/whatsapp";
import { withPlatformToken, type AdsDeps } from "../ads/connections";
import { adsError, adsNotConfigured, failureCodeOf } from "../ads/errors";
import { recordAudit } from "../audit/audit-log";
import type { Db } from "../db/types";
import { AppError } from "../errors/app-error";
import { isUuid, type TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

// WhatsApp Business accounts of a workspace: reading their business numbers and message
// templates (read-only), and the message-status counts recorded from verified webhooks.
// Nothing here sends a message: there is no send path in Flexibx.

export const STATUS_WINDOW_DAYS = 7;

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "ad_account" } });

/** Reads one selected WhatsApp account's numbers and templates and stores them (ads.plan). */
export async function syncWhatsAppAccount(
  deps: AdsDeps & { readonly whatsapp: WhatsAppAdapter | null },
  ctx: TenantContext,
  accountId: string,
): Promise<{ readonly phoneNumbers: number; readonly templates: number }> {
  assertCan(ctx, "ads.plan");
  if (!isUuid(accountId)) throw notFound();
  const account = await deps.db.adAccount.findFirst({
    where: { workspaceId: ctx.workspaceId, id: accountId, platform: "WHATSAPP" },
    select: { id: true, externalId: true, selected: true },
  });
  if (account === null) throw notFound();
  if (!account.selected) throw adsError("CONFLICT", "ads_account_unavailable");
  const whatsapp = deps.whatsapp;
  if (whatsapp === null) throw adsNotConfigured();
  try {
    const snapshot = await withPlatformToken(deps, ctx.workspaceId, "WHATSAPP", (token) =>
      whatsapp.readBusiness(token, account.externalId),
    );
    const fetchedAt = (deps.now ?? (() => new Date()))();
    await deps.db.$transaction(async (tx) => {
      const data = {
        phoneNumbers: snapshot.phoneNumbers as unknown as Prisma.InputJsonValue,
        templates: snapshot.templates as unknown as Prisma.InputJsonValue,
        fetchedAt,
      };
      await tx.whatsAppSnapshot.upsert({
        where: { accountId: account.id, workspaceId: ctx.workspaceId },
        create: { workspaceId: ctx.workspaceId, accountId: account.id, ...data },
        update: data,
      });
      await tx.adAccount.updateMany({
        where: { workspaceId: ctx.workspaceId, id: account.id },
        data: { lastSyncedAt: fetchedAt, syncErrorCode: null },
      });
      await recordAudit(tx, ctx, {
        action: "whatsapp.synced",
        entityType: "ad_account",
        entityId: account.id,
        metadata: {
          phoneNumbers: snapshot.phoneNumbers.length,
          templates: snapshot.templates.length,
          truncated: snapshot.truncated,
        },
      });
    });
    return { phoneNumbers: snapshot.phoneNumbers.length, templates: snapshot.templates.length };
  } catch (error) {
    const code = (
      error instanceof AppError
        ? (error.fields[0]?.code ?? error.code)
        : error instanceof AdPlatformError
          ? `ads_${error.kind}`
          : failureCodeOf(error)
    ).slice(0, 60);
    await deps.db.adAccount.updateMany({
      where: { workspaceId: ctx.workspaceId, id: account.id },
      data: { syncErrorCode: code },
    });
    await recordAudit(deps.db, ctx, {
      action: "whatsapp.sync_failed",
      entityType: "ad_account",
      entityId: account.id,
      metadata: { code },
    });
    throw error;
  }
}

export interface WhatsAppAccountView {
  readonly id: string;
  readonly name: string;
  readonly externalId: string;
  readonly status: string;
  readonly selected: boolean;
  readonly usable: boolean;
  readonly lastSyncedAt: Date | null;
  readonly syncErrorCode: string | null;
  readonly snapshot: Pick<WhatsAppBusinessSnapshot, "phoneNumbers" | "templates"> | null;
  /** Webhook events of the last STATUS_WINDOW_DAYS days, by status. */
  readonly statusCounts: Readonly<Record<string, number>>;
}

/** The workspace's WhatsApp accounts with their stored reads and recent status counts (ads.view). */
export async function getWhatsAppAccounts(
  db: Db,
  ctx: TenantContext,
  now: Date = new Date(),
): Promise<WhatsAppAccountView[]> {
  assertCan(ctx, "ads.view");
  const accounts = await db.adAccount.findMany({
    where: { workspaceId: ctx.workspaceId, platform: "WHATSAPP" },
    orderBy: [{ selected: "desc" }, { name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      externalId: true,
      externalStatus: true,
      selected: true,
      lastSyncedAt: true,
      syncErrorCode: true,
      connection: { select: { status: true } },
      whatsappSnapshot: { select: { phoneNumbers: true, templates: true } },
    },
  });
  if (accounts.length === 0) return [];
  const counts = await db.whatsAppWebhookEvent.groupBy({
    by: ["accountId", "status"],
    where: {
      workspaceId: ctx.workspaceId,
      accountId: { in: accounts.map((account) => account.id) },
      eventAt: { gte: new Date(now.getTime() - STATUS_WINDOW_DAYS * 86_400_000) },
    },
    _count: { _all: true },
  });
  return accounts.map((account) => {
    const parsed =
      account.whatsappSnapshot === null
        ? null
        : whatsAppSnapshotSchema.safeParse({
            phoneNumbers: account.whatsappSnapshot.phoneNumbers,
            templates: account.whatsappSnapshot.templates,
            truncated: false,
          });
    return {
      id: account.id,
      name: account.name,
      externalId: account.externalId,
      status: account.externalStatus,
      selected: account.selected,
      usable: account.selected && account.connection.status === "ACTIVE",
      lastSyncedAt: account.lastSyncedAt,
      syncErrorCode: account.syncErrorCode,
      snapshot:
        parsed?.success === true
          ? { phoneNumbers: parsed.data.phoneNumbers, templates: parsed.data.templates }
          : null,
      statusCounts: Object.fromEntries(
        counts
          .filter((row) => row.accountId === account.id)
          .map((row) => [row.status, row._count._all]),
      ),
    };
  });
}

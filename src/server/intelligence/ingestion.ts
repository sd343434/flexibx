import type { MarketingChannel, MetricSource } from "@/generated/prisma/enums";

import { recordAudit } from "../audit/audit-log";
import type { GuardedPrismaClient } from "../db/prisma";
import type { GuardedTransactionClient } from "../db/types";
import { conflict, notFound } from "../marketing/common";
import type { TenantContext } from "../tenancy/context";
import { assertCan } from "../tenancy/permissions";

import {
  manualSourceRef,
  parseCsv,
  validateRow,
  type ObservationRow,
  type RowIssue,
} from "./metrics";
import { MetricsProviderError, type MetricsProvider } from "./providers";

// Importing performance observations (Pass 5). Every import is one batch with a
// provider-scoped identity: repeating the same batch returns the first result and stores
// nothing. Rows are validated one by one (metrics.ts); an invalid row is reported, never
// guessed. Across batches, an observation that already exists in an import that is not
// voided is a duplicate when the value is the same and a conflict when it differs — the
// first value stays, nothing is overwritten. Imports of one workspace run one at a time
// (a transaction-scoped advisory lock), so two concurrent imports of the same numbers
// cannot both count them. Permission: campaign.manage.

export const MAX_ISSUES = 50;
/** How long a provider may take before the attempt is recorded as failed. */
export const PROVIDER_TIMEOUT_MS = 15_000;

export interface ImportResult {
  readonly importId: string;
  readonly status: "SUCCEEDED" | "FAILED" | "VOIDED";
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  /** True when this batch had been imported before (nothing was stored now). */
  readonly repeated: boolean;
  /** Row-level problems (row number in the source, code), at most MAX_ISSUES. */
  readonly issues: readonly { readonly row: number; readonly code: string }[];
}

interface PreparedRow {
  readonly line: number;
  readonly sourceRef: string;
  readonly result: ReturnType<typeof validateRow>;
}

const lockKey = (workspaceId: string) => `metric-import:${workspaceId}`;

/** The shared import pipeline (one transaction, workspace lock held throughout). */
async function storeBatch(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  batch: {
    readonly provider: string;
    readonly source: Exclude<MetricSource, "VERIFIED">;
    readonly externalId: string;
    readonly campaignId: string;
    readonly channel: MarketingChannel;
    readonly rows: readonly PreparedRow[];
  },
): Promise<ImportResult> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(ctx.workspaceId)}))`;
    const previous = await tx.metricImport.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        provider: batch.provider,
        externalId: batch.externalId,
      },
      select: {
        id: true,
        status: true,
        rowsAccepted: true,
        rowsDuplicate: true,
        rowsRejected: true,
        issues: true,
      },
    });
    if (previous !== null) {
      return {
        importId: previous.id,
        status: previous.status,
        accepted: previous.rowsAccepted,
        duplicates: previous.rowsDuplicate,
        rejected: previous.rowsRejected,
        repeated: true,
        issues: Array.isArray(previous.issues)
          ? (previous.issues as { row: number; code: string }[])
          : [],
      };
    }
    const campaign = await tx.campaign.findFirst({
      where: { workspaceId: ctx.workspaceId, id: batch.campaignId },
      select: { id: true, status: true },
    });
    if (campaign === null) throw notFound("campaign");
    if (campaign.status === "ARCHIVED") {
      throw conflict("campaign", "campaign_locked", { status: campaign.status });
    }

    const contentIds = [
      ...new Set(
        batch.rows.flatMap((row) =>
          row.result.ok && row.result.row.contentItemId !== null
            ? [row.result.row.contentItemId]
            : [],
        ),
      ),
    ];
    const ownContent = new Set(
      (
        await tx.contentItem.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            campaignId: batch.campaignId,
            id: { in: contentIds },
          },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const refs = [...new Set(batch.rows.map((row) => row.sourceRef))];
    const existing = new Map(
      (
        await tx.metricObservation.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            provider: batch.provider,
            sourceRef: { in: refs },
            import: { status: { not: "VOIDED" } },
          },
          select: { sourceRef: true, value: true, currency: true },
        })
      ).map((row) => [row.sourceRef, row]),
    );

    const issues: { row: number; code: RowIssue }[] = [];
    const accepted: (ObservationRow & { sourceRef: string })[] = [];
    const seen = new Map<string, ObservationRow>();
    let duplicates = 0;
    const reject = (line: number, code: RowIssue) => {
      if (issues.length < MAX_ISSUES) issues.push({ row: line, code });
    };
    let rejected = 0;
    for (const prepared of batch.rows) {
      if (!prepared.result.ok) {
        rejected += 1;
        reject(prepared.line, prepared.result.issue);
        continue;
      }
      const row = prepared.result.row;
      if (row.contentItemId !== null && !ownContent.has(row.contentItemId)) {
        // Another workspace's content looks exactly like content that does not exist.
        rejected += 1;
        reject(prepared.line, "content_not_in_campaign");
        continue;
      }
      const same = (other: { value: bigint; currency: string | null }) =>
        other.value === row.value && other.currency === row.currency;
      const earlier = existing.get(prepared.sourceRef) ?? seen.get(prepared.sourceRef);
      if (earlier !== undefined) {
        if (same(earlier)) {
          duplicates += 1;
        } else {
          rejected += 1;
          reject(
            prepared.line,
            existing.has(prepared.sourceRef) ? "conflict" : "duplicate_in_batch",
          );
        }
        continue;
      }
      seen.set(prepared.sourceRef, row);
      accepted.push({ ...row, sourceRef: prepared.sourceRef });
    }

    const failed = accepted.length === 0 && duplicates === 0;
    const created = await tx.metricImport.create({
      data: {
        workspaceId: ctx.workspaceId,
        provider: batch.provider,
        source: batch.source,
        // A failed attempt stored nothing: it keeps no claim on the batch identity, so the
        // same batch can be retried once it is corrected.
        externalId: failed
          ? `${batch.externalId.slice(0, 70)}#failed:${crypto.randomUUID()}`
          : batch.externalId,
        status: failed ? "FAILED" : "SUCCEEDED",
        rowsReceived: batch.rows.length,
        rowsAccepted: accepted.length,
        rowsDuplicate: duplicates,
        rowsRejected: rejected,
        errorCode: failed ? (batch.rows.length === 0 ? "no_rows" : "no_valid_rows") : null,
        issues,
        importedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    if (accepted.length > 0) {
      await tx.metricObservation.createMany({
        data: accepted.map((row) => ({
          workspaceId: ctx.workspaceId,
          importId: created.id,
          campaignId: batch.campaignId,
          contentItemId: row.contentItemId,
          channel: batch.channel,
          provider: batch.provider,
          source: batch.source,
          metric: row.metric,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          value: row.value,
          currency: row.currency,
          sourceRef: row.sourceRef,
        })),
      });
    }
    await recordAudit(tx, ctx, {
      action: "metrics.imported",
      entityType: "campaign",
      entityId: batch.campaignId,
      metadata: {
        importId: created.id,
        provider: batch.provider,
        source: batch.source,
        accepted: accepted.length,
        duplicates,
        rejected,
      },
    });
    return {
      importId: created.id,
      status: failed ? "FAILED" : "SUCCEEDED",
      accepted: accepted.length,
      duplicates,
      rejected,
      repeated: false,
      issues,
    };
  });
}

/**
 * A person's import (CSV text, MANUAL). `batchKey` identifies the submission (the form
 * sends a fresh one per attempt and resubmits the same one on retry).
 */
export async function importManualCsv(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  input: {
    readonly campaignId: string;
    readonly channel: MarketingChannel;
    readonly batchKey: string;
    readonly csv: string;
    readonly today: Date;
  },
): Promise<ImportResult> {
  assertCan(ctx, "campaign.manage");
  const parsed = parseCsv(input.csv);
  if (parsed.headerIssue !== null)
    throw conflict("csv", "metrics_csv_invalid", { issue: parsed.headerIssue });
  const rows = parsed.rows.map((entry): PreparedRow => {
    const [periodStart = "", periodEnd = "", metric = "", value = "", currency = "", content = ""] =
      entry.fields;
    const result =
      entry.fields.length === 6
        ? validateRow(
            { periodStart, periodEnd, metric, value, currency, contentItemId: content },
            input.today,
          )
        : ({ ok: false, issue: "columns" } as const);
    return {
      line: entry.line,
      sourceRef: result.ok
        ? manualSourceRef(input.campaignId, input.channel, result.row)
        : `invalid:${String(entry.line)}`,
      result,
    };
  });
  return storeBatch(db, ctx, {
    provider: "manual",
    source: "MANUAL",
    externalId: input.batchKey,
    campaignId: input.campaignId,
    channel: input.channel,
    rows,
  });
}

/**
 * Reads observations from a provider and imports them. A provider failure (timeout,
 * unavailable, malformed answer) is recorded as a FAILED import — nothing stale is shown
 * as fresh — and the error code (never the provider's response) is returned.
 */
export async function syncFromProvider(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  provider: MetricsProvider,
  input: {
    readonly campaignId: string;
    readonly channel: MarketingChannel;
    readonly from: Date;
    readonly to: Date;
    readonly today: Date;
    readonly timeoutMs?: number;
  },
): Promise<ImportResult> {
  assertCan(ctx, "campaign.manage");
  const contents = await db.contentItem.findMany({
    where: { workspaceId: ctx.workspaceId, campaignId: input.campaignId },
    select: { id: true },
    take: 200,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  try {
    const batch = await provider.fetch({
      campaignId: input.campaignId,
      contentItemIds: contents.map((row) => row.id),
      from: input.from,
      to: input.to,
      signal: controller.signal,
    });
    return await storeBatch(db, ctx, {
      provider: provider.name,
      source: provider.source,
      externalId: batch.batchId,
      campaignId: input.campaignId,
      channel: input.channel,
      rows: batch.rows.map((row, index) => ({
        line: index + 1,
        sourceRef: `${provider.name}:${row.ref}`,
        result: validateRow(row, input.today),
      })),
    });
  } catch (error) {
    const code =
      error instanceof MetricsProviderError
        ? error.code
        : controller.signal.aborted
          ? "provider_timeout"
          : null;
    if (code === null) throw error;
    return await recordFailure(db, ctx, provider, input.campaignId, code);
  } finally {
    clearTimeout(timer);
  }
}

async function recordFailure(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  provider: MetricsProvider,
  campaignId: string,
  code: string,
): Promise<ImportResult> {
  return db.$transaction(async (tx: GuardedTransactionClient) => {
    const campaign = await tx.campaign.findFirst({
      where: { workspaceId: ctx.workspaceId, id: campaignId },
      select: { id: true },
    });
    if (campaign === null) throw notFound("campaign");
    const created = await tx.metricImport.create({
      data: {
        workspaceId: ctx.workspaceId,
        provider: provider.name,
        source: provider.source,
        // A failed attempt has no batch identity: each one is recorded on its own.
        externalId: `failed:${crypto.randomUUID()}`,
        status: "FAILED",
        rowsReceived: 0,
        rowsAccepted: 0,
        rowsDuplicate: 0,
        rowsRejected: 0,
        errorCode: code,
        importedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: "metrics.import_failed",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { importId: created.id, provider: provider.name, code },
    });
    return {
      importId: created.id,
      status: "FAILED" as const,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      repeated: false,
      issues: [],
    };
  });
}

/** Withdraws an import: its observations stop counting everywhere (kept as history). */
export async function voidImport(
  db: GuardedPrismaClient,
  ctx: TenantContext,
  importId: string,
): Promise<void> {
  assertCan(ctx, "campaign.manage");
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(ctx.workspaceId)}))`;
    const row = await tx.metricImport.findFirst({
      where: { workspaceId: ctx.workspaceId, id: importId },
      select: { status: true },
    });
    if (row === null) throw notFound("campaign");
    if (row.status !== "SUCCEEDED") {
      throw conflict("import", "metrics_import_not_voidable", { status: row.status });
    }
    await tx.metricImport.updateMany({
      where: { workspaceId: ctx.workspaceId, id: importId, status: "SUCCEEDED" },
      data: { status: "VOIDED", voidedAt: new Date() },
    });
    await recordAudit(tx, ctx, {
      action: "metrics.import_voided",
      entityType: "metric_import",
      entityId: importId,
    });
  });
}

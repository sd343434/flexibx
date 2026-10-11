import type { Db } from "../db/types";

import {
  AdPlatformError,
  inclusiveDays,
  type AdWriter,
  type ExecutionStepKey,
  type ExternalState,
  type StepContext,
} from "./adapter";
import { adsError } from "./errors";
import type { AdPlatform } from "./model";

// The shared execution service: the ONLY code that makes advertising writes, always from
// inside an approved orchestration task (workflows/ad-launch.ts, ad-activate.ts). It is
// platform-neutral; each platform contributes an AdWriter.
//
// Safety rules it enforces:
// - Nothing runs unless execution is enabled on this server, the platform's writer is
//   ready, the connection is active and holds the write permissions, and the plan's
//   budget is within the workspace's spending limits for its currency.
// - Every external write is recorded in the ledger (ad_execution_steps) IN_FLIGHT before
//   it is sent. A write that may have happened (AdPlatformError.uncertain) is recorded
//   UNCERTAIN and is never sent again blindly: the next attempt first looks the object up
//   by its tag; found → reused; definitely absent → written once more.
// - Created objects are PAUSED; activation is a separate, separately approved action.
// - Steps that already succeeded are never repeated (idempotent resume).

export type StepStatus = "IN_FLIGHT" | "SUCCEEDED" | "UNCERTAIN" | "FAILED";
type LedgerKey = ExecutionStepKey | "activate";

/** The tag every object of a plan carries (in its name), used to find it again. */
export function executionTag(planId: string): string {
  return `fx-${planId.replaceAll("-", "").slice(0, 12)}`;
}

/** Refused unless the workspace's spending limits for this currency allow the plan. */
export async function assertWithinSpendLimits(
  db: Db,
  workspaceId: string,
  plan: {
    readonly budgetMinor: number;
    readonly currency: string;
    readonly startDate: string;
    readonly endDate: string;
  },
): Promise<void> {
  const limit = await db.adSpendLimit.findFirst({
    where: { workspaceId, currency: plan.currency },
    select: { maxPlanBudgetMinor: true, maxDailyBudgetMinor: true },
  });
  if (limit === null) throw adsError("CONFLICT", "ads_spend_limit_missing");
  if (BigInt(plan.budgetMinor) > limit.maxPlanBudgetMinor) {
    throw adsError("CONFLICT", "ads_spend_limit_exceeded");
  }
  const days = Math.max(1, inclusiveDays(plan.startDate, plan.endDate));
  if (BigInt(Math.ceil(plan.budgetMinor / days)) > limit.maxDailyBudgetMinor) {
    throw adsError("CONFLICT", "ads_daily_limit_exceeded");
  }
}

/** Refused unless the connection is active and was granted every write permission. */
export async function assertWriteAccess(
  db: Db,
  workspaceId: string,
  platform: AdPlatform,
  writer: AdWriter,
): Promise<void> {
  if (!writer.ready) throw adsError("CONFLICT", "ads_operation_unavailable");
  const connection = await db.adConnection.findFirst({
    where: { workspaceId, platform },
    select: { status: true, scopes: true },
  });
  if (connection === null || connection.status === "REVOKED") {
    throw adsError("CONFLICT", "ads_not_connected");
  }
  if (connection.status === "EXPIRED") throw adsError("CONFLICT", "ads_token_expired");
  if (connection.status !== "ACTIVE") throw adsError("CONFLICT", "ads_permission_missing");
  const missing = writer.writeScopes.filter((scope) => !connection.scopes.includes(scope));
  if (missing.length > 0) {
    throw adsError("CONFLICT", "ads_permission_missing", { missing });
  }
}

/** The ledger of a plan: step → row. */
export async function readLedger(db: Db, workspaceId: string, planId: string) {
  const rows = await db.adExecutionStep.findMany({
    where: { workspaceId, planId },
    select: { step: true, status: true, externalId: true, errorCode: true, attempts: true },
  });
  return new Map(rows.map((row) => [row.step as LedgerKey, row]));
}

/** True when any external object of the plan exists or may exist (edits are then refused). */
export async function hasExternalObjects(
  db: Db,
  workspaceId: string,
  planId: string,
): Promise<boolean> {
  const count = await db.adExecutionStep.count({
    where: {
      workspaceId,
      planId,
      OR: [{ externalId: { not: null } }, { status: { in: ["UNCERTAIN", "IN_FLIGHT"] } }],
    },
  });
  return count > 0;
}

async function setStep(
  db: Db,
  workspaceId: string,
  planId: string,
  step: LedgerKey,
  data: {
    readonly status: StepStatus;
    readonly externalId?: string | null;
    readonly errorCode?: string | null;
    readonly attempt?: boolean;
  },
) {
  await db.adExecutionStep.upsert({
    where: { planId_step: { planId, step }, workspaceId },
    create: {
      workspaceId,
      planId,
      step,
      status: data.status,
      externalId: data.externalId ?? null,
      errorCode: data.errorCode ?? null,
      attempts: data.attempt === true ? 1 : 0,
    },
    update: {
      status: data.status,
      ...(data.externalId === undefined ? {} : { externalId: data.externalId }),
      errorCode: data.errorCode ?? null,
      ...(data.attempt === true ? { attempts: { increment: 1 } } : {}),
    },
  });
}

const failureCode = (error: unknown) =>
  error instanceof AdPlatformError ? `ads_${error.kind}` : "unexpected";

export interface StepEvent {
  readonly step: LedgerKey;
  readonly outcome: "succeeded" | "failed" | "uncertain" | "reconciled";
  readonly externalId: string | null;
  readonly code: string | null;
}

/**
 * Creates the plan's objects (all PAUSED), step by step, resuming from the ledger.
 * Returns the external ids. Throws on the first failure, leaving the ledger accurate:
 * FAILED (not created) or UNCERTAIN (may exist — reconciled on the next attempt).
 */
export async function runCreationSteps(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly planId: string;
  readonly writer: AdWriter;
  readonly token: string;
  readonly context: Omit<StepContext, "ids">;
  readonly onEvent?: (event: StepEvent) => Promise<void>;
  /** Runs right before every external write (e.g. the emergency stop); throws to stop. */
  readonly beforeWrite?: () => Promise<void>;
}): Promise<Readonly<Partial<Record<ExecutionStepKey, string>>>> {
  const { db, workspaceId, planId, writer, token } = args;
  const ledger = await readLedger(db, workspaceId, planId);
  const ids: Partial<Record<ExecutionStepKey, string>> = {};
  const emit = async (event: StepEvent) => args.onEvent?.(event);

  for (const step of writer.steps) {
    // The task timed out: stop before sending anything more (nothing in flight here).
    if (args.context.signal?.aborted === true) throw new AdPlatformError("provider_error");
    // The media step exists only when there is a file to upload.
    if (step === "media" && args.context.media === null) continue;
    const row = ledger.get(step);
    if (row?.status === "SUCCEEDED" && row.externalId !== null) {
      ids[step] = row.externalId;
      continue;
    }
    const context: StepContext = { ...args.context, ids: { ...ids } };
    // A write that may have happened is looked up before anything is written again.
    if (row !== undefined && (row.status === "UNCERTAIN" || row.status === "IN_FLIGHT")) {
      let found: string | null;
      try {
        found = await writer.findStep(token, step, context);
      } catch (error) {
        await emit({ step, outcome: "uncertain", externalId: null, code: failureCode(error) });
        throw adsError("CONFLICT", "ads_outcome_unknown", { step });
      }
      if (found !== null) {
        await setStep(db, workspaceId, planId, step, { status: "SUCCEEDED", externalId: found });
        await emit({ step, outcome: "reconciled", externalId: found, code: null });
        ids[step] = found;
        continue;
      }
      // Definitely not created: safe to write it (once).
    }
    await args.beforeWrite?.();
    await setStep(db, workspaceId, planId, step, { status: "IN_FLIGHT", attempt: true });
    try {
      const externalId = await writer.runStep(token, step, context);
      await setStep(db, workspaceId, planId, step, { status: "SUCCEEDED", externalId });
      await emit({ step, outcome: "succeeded", externalId, code: null });
      ids[step] = externalId;
    } catch (error) {
      const code = failureCode(error);
      const uncertain = !(error instanceof AdPlatformError) || error.uncertain;
      await setStep(db, workspaceId, planId, step, {
        status: uncertain ? "UNCERTAIN" : "FAILED",
        errorCode: code.slice(0, 60),
      });
      await emit({ step, outcome: uncertain ? "uncertain" : "failed", externalId: null, code });
      throw error;
    }
  }
  return ids;
}

/** Turns the created objects on, once. An unknown outcome is recorded, never repeated. */
export async function runActivation(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly planId: string;
  readonly writer: AdWriter;
  readonly token: string;
  readonly request: StepContext["request"];
  readonly ids: Readonly<Partial<Record<ExecutionStepKey, string>>>;
  readonly signal?: AbortSignal;
  readonly beforeWrite?: () => Promise<void>;
}): Promise<ExternalState> {
  const { db, workspaceId, planId, writer, token, signal } = args;
  const row = (await readLedger(db, workspaceId, planId)).get("activate");
  if (row !== undefined && row.status !== "FAILED") {
    // Done before, or possibly done: read the platform before writing anything again.
    let state: ExternalState;
    try {
      state = await writer.readState(token, args.ids, signal);
    } catch {
      throw adsError("CONFLICT", "ads_outcome_unknown");
    }
    if (state.campaign === "ACTIVE") {
      await setStep(db, workspaceId, planId, "activate", { status: "SUCCEEDED" });
      return state;
    }
    // Confirmed not active: setting the status creates nothing and charges nothing by
    // itself, so this newly approved activation may set it again.
  }
  await args.beforeWrite?.();
  await setStep(db, workspaceId, planId, "activate", { status: "IN_FLIGHT", attempt: true });
  try {
    await writer.activate(token, args.request, args.ids, signal);
  } catch (error) {
    const uncertain = !(error instanceof AdPlatformError) || error.uncertain;
    await setStep(db, workspaceId, planId, "activate", {
      status: uncertain ? "UNCERTAIN" : "FAILED",
      errorCode: failureCode(error).slice(0, 60),
    });
    throw error;
  }
  await setStep(db, workspaceId, planId, "activate", { status: "SUCCEEDED" });
  // The writes were accepted, so the campaign may be delivering: a status that cannot be
  // read is an unknown outcome (checked by reading on the next attempt), never a failure.
  try {
    return await writer.readState(token, args.ids, signal);
  } catch {
    throw adsError("CONFLICT", "ads_outcome_unknown");
  }
}

/** The created objects' ids from the ledger (for activation and reconciliation). */
export async function createdIds(db: Db, workspaceId: string, planId: string) {
  const ledger = await readLedger(db, workspaceId, planId);
  const ids: Partial<Record<ExecutionStepKey, string>> = {};
  for (const [step, row] of ledger) {
    if (step !== "activate" && row.status === "SUCCEEDED" && row.externalId !== null) {
      ids[step] = row.externalId;
    }
  }
  return ids;
}

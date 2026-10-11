import { createHash } from "node:crypto";

import type { TaskRisk } from "./planner";

// The exact action a person approves (pure, unit tested). A task that acts outside
// Flexibx or spends money describes its action deterministically from its inputs before
// it may run; the description is stored, hashed over canonical JSON, decided on, and
// described again right before execution — any difference requires a new approval.

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What a task's `describe` returns. Amounts are integer minor units (e.g. halalas). */
export interface ActionDescription {
  /** Stable machine name, e.g. `publish_post`, `boost_campaign`. */
  readonly action: string;
  /** What exactly will happen: ids, channel, text excerpt… (JSON, ≤ 4 KB). */
  readonly details: Readonly<Record<string, JsonValue>>;
  /** Required for SPEND, refused otherwise. */
  readonly amount?: { readonly minor: number; readonly currency: string };
}

/** The stored snapshot: the description plus what it belongs to. */
export interface ApprovalSnapshot {
  readonly workflow: string;
  readonly task: string;
  readonly risk: Exclude<TaskRisk, "INTERNAL">;
  readonly action: string;
  readonly details: Readonly<Record<string, JsonValue>>;
  readonly amount: { readonly minor: number; readonly currency: string } | null;
}

const ACTION = /^[a-z][a-z_]{1,39}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Room for a full campaign description (every platform call of a launch). */
export const MAX_DETAILS_BYTES = 16_384;
/** Upper bound on one approved amount in minor units (10^12, far above any campaign). */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every((item) => isJson(item, depth + 1));
  }
  return false;
}

/** JSON with object keys sorted at every level: the same action always hashes the same. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${(value as readonly JsonValue[]).map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotHash(snapshot: ApprovalSnapshot): string {
  return createHash("sha256")
    .update(canonicalJson(snapshot as unknown as JsonValue))
    .digest("hex");
}

/**
 * Builds the snapshot of a task's described action, or names what is wrong with the
 * description (then the task fails closed — it never runs).
 */
export function buildSnapshot(
  scope: { readonly workflow: string; readonly task: string; readonly risk: TaskRisk },
  description: unknown,
): { readonly ok: true; readonly snapshot: ApprovalSnapshot } | { readonly ok: false } {
  if (scope.risk === "INTERNAL") return { ok: false };
  if (typeof description !== "object" || description === null) return { ok: false };
  const { action, details, amount } = description as Record<string, unknown>;
  if (typeof action !== "string" || !ACTION.test(action)) return { ok: false };
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return { ok: false };
  }
  if (!isJson(details)) return { ok: false };
  if (Buffer.byteLength(canonicalJson(details), "utf8") > MAX_DETAILS_BYTES) return { ok: false };
  let money: ApprovalSnapshot["amount"] = null;
  if (scope.risk === "SPEND") {
    if (typeof amount !== "object" || amount === null) return { ok: false };
    const { minor, currency } = amount as Record<string, unknown>;
    if (
      typeof minor !== "number" ||
      !Number.isSafeInteger(minor) ||
      minor <= 0 ||
      minor > MAX_AMOUNT_MINOR ||
      typeof currency !== "string" ||
      !CURRENCY.test(currency)
    ) {
      return { ok: false };
    }
    money = { minor, currency };
  } else if (amount !== undefined) {
    // Money is only ever committed by a task declared SPEND.
    return { ok: false };
  }
  return {
    ok: true,
    snapshot: {
      workflow: scope.workflow,
      task: scope.task,
      risk: scope.risk,
      action,
      details: details as Readonly<Record<string, JsonValue>>,
      amount: money,
    },
  };
}

/** Reads a stored snapshot back (defensively: it is JSON from the database). */
export function readSnapshot(value: unknown): ApprovalSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { workflow, task, risk, amount } = record;
  if (typeof workflow !== "string" || typeof task !== "string") return null;
  if (risk !== "EXTERNAL" && risk !== "SPEND") return null;
  const built = buildSnapshot(
    { workflow, task, risk },
    {
      action: record.action,
      details: record.details,
      ...(amount === null || amount === undefined ? {} : { amount }),
    },
  );
  return built.ok ? built.snapshot : null;
}

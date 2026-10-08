import type { Db } from "../db/types";
import { AppError, type FieldError } from "../errors/app-error";
import type { TenantContext } from "../tenancy/context";
import type { ValidationCode } from "../validation/field-errors";

import { resolveTimeZone, zonedLocalToUtc } from "./time";

// Shared helpers for the Marketing Core services.

export type MarketingResource =
  "brand" | "audience" | "goal" | "pillar" | "campaign" | "content" | "asset";

/** One answer for an unknown id and another workspace's id, so nothing leaks. */
export function notFound(resource: MarketingResource): AppError {
  return new AppError("NOT_FOUND", { metadata: { resource } });
}

export function fieldError(
  path: string,
  code: ValidationCode,
  params?: FieldError["params"],
): AppError {
  return new AppError("VALIDATION_FAILED", {
    message: `Invalid ${path}: ${code}`,
    fields: [params === undefined ? { path, code } : { path, code, params }],
  });
}

export function conflict(path: string, code: ValidationCode, metadata: Record<string, unknown>) {
  return new AppError("CONFLICT", {
    message: `Conflict on ${path}: ${code}`,
    fields: [{ path, code }],
    metadata,
  });
}

/** A per-workspace record cap was reached (bounds pages that list everything). */
export function limitReached(resource: MarketingResource, maximum: number): AppError {
  return new AppError("CONFLICT", {
    message: `${resource} limit reached`,
    fields: [{ path: resource, code: "too_big", params: { maximum } }],
    metadata: { resource, maximum },
  });
}

/** The workspace's IANA time zone (a valid default when unset or unknown). */
export async function workspaceTimeZone(db: Db, ctx: TenantContext): Promise<string> {
  const workspace = await db.workspace.findUnique({
    where: { id: ctx.workspaceId },
    select: { timezone: true },
  });
  return resolveTimeZone(workspace?.timezone);
}

/** Converts a datetime-local value to UTC in `zone`; a bad value is a field error. */
export function toInstant(value: string | null, zone: string, path: string): Date | null {
  if (value === null) return null;
  const instant = zonedLocalToUtc(value, zone);
  if (instant === null) throw fieldError(path, "invalid_format", { format: "datetime" });
  return instant;
}

type ReferenceKind = "audience" | "goal" | "pillar" | "campaign";

interface ReferenceRow {
  readonly id: string;
  readonly archived: boolean;
}

async function loadReferences(
  db: Db,
  ctx: TenantContext,
  kind: ReferenceKind,
  ids: readonly string[],
): Promise<ReferenceRow[]> {
  const where = { workspaceId: ctx.workspaceId, id: { in: [...ids] } };
  switch (kind) {
    case "audience":
      return (await db.audience.findMany({ where, select: { id: true } })).map((row) => ({
        id: row.id,
        archived: false,
      }));
    case "goal":
      return (await db.marketingGoal.findMany({ where, select: { id: true, status: true } })).map(
        (row) => ({ id: row.id, archived: row.status === "ARCHIVED" }),
      );
    case "pillar":
      return (await db.contentPillar.findMany({ where, select: { id: true, status: true } })).map(
        (row) => ({ id: row.id, archived: row.status === "ARCHIVED" }),
      );
    case "campaign":
      return (await db.campaign.findMany({ where, select: { id: true, status: true } })).map(
        (row) => ({ id: row.id, archived: row.status === "ARCHIVED" }),
      );
  }
}

/**
 * Resolves related-record ids inside the current workspace. An id that does not exist
 * here (including another workspace's id) is `reference_not_found`; an archived record
 * can stay linked where it already was (`keep`) but cannot be newly linked
 * (`reference_archived`). The database triggers enforce the same-workspace rule again.
 */
export async function resolveReferences(
  db: Db,
  ctx: TenantContext,
  kind: ReferenceKind,
  ids: readonly string[],
  path: string,
  keep: readonly string[] = [],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await loadReferences(db, ctx, kind, unique);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of unique) {
    const row = byId.get(id);
    if (row === undefined) throw fieldError(path, "reference_not_found");
    if (row.archived && !keep.includes(id)) throw fieldError(path, "reference_archived");
  }
  return unique;
}

/** Single optional reference (null stays null). */
export async function resolveReference(
  db: Db,
  ctx: TenantContext,
  kind: ReferenceKind,
  id: string | null,
  path: string,
  current: string | null = null,
): Promise<string | null> {
  if (id === null) return null;
  const [resolved] = await resolveReferences(
    db,
    ctx,
    kind,
    [id],
    path,
    current === null ? [] : [current],
  );
  return resolved ?? null;
}

/** Names of the fields whose values differ (for audit metadata — names only, no values). */
export function changedFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(after).filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
}

import type { PrismaClient } from "@/generated/prisma/client";

import { AppError } from "../errors/app-error";

/**
 * Workspace-owned models and how their `workspaceId` is enforced.
 * EVERY new model with a `workspace_id` column MUST be registered here.
 *
 * - required:   workspaceId must be a concrete UUID on every read/write.
 * - nullable:   workspaceId must be stated explicitly (UUID, or `null` for platform rows).
 * - appendOnly: rows can be created and read, never updated or deleted.
 */
export const TENANT_MODELS = {
  WorkspaceMember: { workspaceId: "required", appendOnly: false },
  WorkspaceInvitation: { workspaceId: "required", appendOnly: false },
  AuditLog: { workspaceId: "nullable", appendOnly: true },
  // Marketing Core (Phase 3).
  Brand: { workspaceId: "required", appendOnly: false },
  Audience: { workspaceId: "required", appendOnly: false },
  MarketingGoal: { workspaceId: "required", appendOnly: false },
  ContentPillar: { workspaceId: "required", appendOnly: false },
  Campaign: { workspaceId: "required", appendOnly: false },
  CampaignGoal: { workspaceId: "required", appendOnly: false },
  CampaignPillar: { workspaceId: "required", appendOnly: false },
  ContentItem: { workspaceId: "required", appendOnly: false },
  MediaAsset: { workspaceId: "required", appendOnly: false },
  ContentItemAsset: { workspaceId: "required", appendOnly: false },
} as const satisfies Record<string, { workspaceId: "required" | "nullable"; appendOnly: boolean }>;

/** The tenant root. Reads/updates must target one workspace by `id`; hard deletes are blocked. */
export const TENANT_ROOT_MODEL = "Workspace";

/**
 * Workspace-owned relations of the tenant root. Prisma runs nested writes inside the
 * parent operation without passing them through this guard, so writes to the root may
 * not touch these relations at all; they are changed only through their own guarded
 * top-level model operations.
 */
export const TENANT_ROOT_RELATIONS = [
  "members",
  "auditLogs",
  "clients",
  "invitations",
  "brand",
  "audiences",
  "marketingGoals",
  "contentPillars",
  "campaigns",
  "campaignGoals",
  "campaignPillars",
  "contentItems",
  "mediaAssets",
  "contentItemAssets",
] as const;

/**
 * Authentication tables (Better Auth). Global/system data — never workspace-scoped and
 * never reachable through the application client: only the auth layer touches them,
 * through the system client. This also keeps raw session tokens out of app code.
 */
export const AUTH_MODELS: ReadonlySet<string> = new Set([
  "Session",
  "Account",
  "Verification",
  "RateLimit",
]);

/**
 * Global (non-tenant) models and the relations they must not reach through the
 * application client: tenant data (queried through workspace-scoped models) and
 * authentication data (auth layer only).
 */
export const GLOBAL_MODEL_TENANT_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  User: [
    "memberships",
    "auditLogs",
    "sessions",
    "accounts",
    "invitationsCreated",
    "contentCreated",
    "mediaUploaded",
  ],
};

// Every operation that is not a create — all reads (findUnique/First/Many, count,
// aggregate, groupBy) and any operation Prisma adds in future — must carry a workspace
// scope. Default-deny: only creates are checked differently.
const UPDATE_OPERATIONS = new Set(["update", "updateMany", "updateManyAndReturn", "upsert"]);
const DELETE_OPERATIONS = new Set(["delete", "deleteMany"]);
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

type Mode = "required" | "nullable";
type Args = Record<string, unknown>;

function isRecord(value: unknown): value is Args {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScopeValue(value: unknown, mode: Mode): boolean {
  if (typeof value === "string" && value.length > 0) return true;
  if (mode === "nullable" && value === null) return true;
  if (isRecord(value) && Object.keys(value).length === 1 && "equals" in value) {
    return isScopeValue(value.equals, mode);
  }
  return false;
}

/** True if a `where` clause pins exactly one workspace (top-level or compound unique key). */
export function hasWorkspaceScope(where: unknown, mode: Mode): boolean {
  if (!isRecord(where)) return false;
  if ("workspaceId" in where && isScopeValue(where.workspaceId, mode)) return true;
  return Object.entries(where).some(
    ([key, value]) =>
      key.startsWith("workspaceId_") &&
      isRecord(value) &&
      isScopeValue(value.workspaceId, "required"),
  );
}

function violation(model: string, operation: string, reason: string): AppError {
  return new AppError("TENANT_SCOPE_MISSING", {
    message: `Tenant guard: ${model}.${operation} rejected — ${reason}`,
    metadata: { model, operation },
  });
}

function assertCreateData(model: string, operation: string, data: unknown, mode: Mode) {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!isRecord(row) || !("workspaceId" in row) || !isScopeValue(row.workspaceId, mode)) {
      throw violation(model, operation, "data.workspaceId must be set explicitly");
    }
  }
}

function assertNoWorkspaceChange(model: string, operation: string, data: unknown) {
  if (isRecord(data) && ("workspaceId" in data || "workspace" in data)) {
    throw violation(model, operation, "moving a record to another workspace is not allowed");
  }
}

function assertNoNestedTenantWrites(model: string, operation: string, payloads: unknown[]) {
  for (const payload of payloads) {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      const relation = isRecord(row)
        ? TENANT_ROOT_RELATIONS.find((name) => name in row)
        : undefined;
      if (relation !== undefined) {
        throw violation(
          model,
          operation,
          `nested writes to ${relation} are not allowed; use the ${relation} model's own guarded operations`,
        );
      }
    }
  }
}

function touchesRelations(args: Args, relations: readonly string[]): boolean {
  return ["include", "select", "data"].some((key) => {
    const value = args[key];
    return (
      isRecord(value) &&
      relations.some((relation) => relation in value && value[relation] !== false)
    );
  });
}

/**
 * Validates one Prisma operation against the tenancy rules. Throws TENANT_SCOPE_MISSING
 * (a 500: it indicates a programming error, never user input) when a query could read
 * or write across workspaces.
 */
export function assertTenantSafe(model: string, operation: string, rawArgs: unknown): void {
  const args: Args = isRecord(rawArgs) ? rawArgs : {};

  if (model in TENANT_MODELS) {
    const rule = TENANT_MODELS[model as keyof typeof TENANT_MODELS];
    const mode = rule.workspaceId;

    if (rule.appendOnly && (UPDATE_OPERATIONS.has(operation) || DELETE_OPERATIONS.has(operation))) {
      throw violation(model, operation, "model is append-only");
    }
    if (CREATE_OPERATIONS.has(operation)) {
      assertCreateData(model, operation, args.data, mode);
      return;
    }
    if (!hasWorkspaceScope(args.where, mode)) {
      throw violation(model, operation, "where.workspaceId is required");
    }
    if (UPDATE_OPERATIONS.has(operation)) {
      assertNoWorkspaceChange(model, operation, operation === "upsert" ? args.update : args.data);
      if (operation === "upsert") assertCreateData(model, operation, args.create, mode);
    }
    return;
  }

  if (model === TENANT_ROOT_MODEL) {
    if (DELETE_OPERATIONS.has(operation)) {
      throw violation(
        model,
        operation,
        "workspaces are soft-deleted (set deletedAt); hard deletes are blocked",
      );
    }
    if (CREATE_OPERATIONS.has(operation) || UPDATE_OPERATIONS.has(operation)) {
      assertNoNestedTenantWrites(model, operation, [args.data, args.create, args.update]);
    }
    if (CREATE_OPERATIONS.has(operation)) return;
    const where = args.where;
    if (!isRecord(where) || typeof where.id !== "string") {
      throw violation(model, operation, "where.id must target a single workspace");
    }
    return;
  }

  if (AUTH_MODELS.has(model)) {
    throw violation(
      model,
      operation,
      "authentication tables are only accessible to the auth layer",
    );
  }

  const relations = GLOBAL_MODEL_TENANT_RELATIONS[model];
  if (relations !== undefined && touchesRelations(args, relations)) {
    throw violation(
      model,
      operation,
      `protected relations (${relations.join(", ")}) must be queried through their own scoped model or the auth layer`,
    );
  }
}

/** Returns a Prisma client that enforces `assertTenantSafe` on every model operation. */
export function withTenantGuard(client: PrismaClient) {
  return client.$extends({
    name: "flexibx-tenant-guard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          assertTenantSafe(model, operation, args);
          return query(args);
        },
      },
    },
  });
}

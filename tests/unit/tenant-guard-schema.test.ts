import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AppError } from "@/server/errors/app-error";
import {
  APPEND_ONLY_RELATIONS,
  assertTenantSafe,
  AUTH_MODELS,
  GLOBAL_MODEL_TENANT_RELATIONS,
  TENANT_MODELS,
  TENANT_ROOT_RELATIONS,
} from "@/server/db/tenant-guard";

// The guard's relation lists checked against the schema itself, so a new model or relation
// that is not registered fails here instead of opening a nested-write bypass.

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

/** model → [field, target model] for every relation field. */
function relations(): Map<string, [string, string][]> {
  const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1] ?? ""));
  const out = new Map<string, [string, string][]>();
  for (const block of schema.split(/^model /m).slice(1)) {
    const name = block.slice(0, block.indexOf(" "));
    const fields: [string, string][] = [];
    for (const line of block.split("\n").slice(1)) {
      const match = /^\s+(\w+)\s+(\w+)(\[\]|\?)?(\s|$)/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined && models.has(match[2])) {
        fields.push([match[1], match[2]]);
      }
    }
    out.set(name, fields);
  }
  return out;
}

const tenant = (model: string) => model in TENANT_MODELS;
const appendOnly = (model: string) =>
  model in TENANT_MODELS && TENANT_MODELS[model as keyof typeof TENANT_MODELS].appendOnly;

describe("tenant guard registry matches the schema", () => {
  const all = relations();

  it("blocks nested writes from Workspace to every workspace-owned model", () => {
    const missing = (all.get("Workspace") ?? [])
      .filter(([, target]) => tenant(target))
      .map(([field]) => field)
      .filter((field) => !(TENANT_ROOT_RELATIONS as readonly string[]).includes(field));
    expect(missing).toEqual([]);
  });

  it("blocks reaching workspace or auth data through User", () => {
    const missing = (all.get("User") ?? [])
      .filter(([, target]) => tenant(target) || AUTH_MODELS.has(target))
      .map(([field]) => field)
      .filter((field) => !(GLOBAL_MODEL_TENANT_RELATIONS.User ?? []).includes(field));
    expect(missing).toEqual([]);
  });

  it("blocks nested writes from any workspace model into an append-only model", () => {
    const missing: string[] = [];
    for (const [model, fields] of all) {
      if (!tenant(model)) continue;
      for (const [field, target] of fields) {
        if (appendOnly(target) && !(APPEND_ONLY_RELATIONS[model] ?? []).includes(field)) {
          missing.push(`${model}.${field}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

function rejected(model: string, operation: string, args: unknown): boolean {
  try {
    assertTenantSafe(model, operation, args);
    return false;
  } catch (error) {
    return error instanceof AppError && error.code === "TENANT_SCOPE_MISSING";
  }
}

const WS = "6b1f8e1e-7c1a-4f61-9a43-3f0e2a2c5d10";
const ID = "0d6f4a52-1b6e-4b0c-9a55-2f4f0a1d9e33";

describe("nested writes cannot reach credits or the social manager", () => {
  const credit = ["creditAccount", "creditHolds", "creditLedgerEntries", "creditRecharges"];
  const social = [
    "socialChannels",
    "socialAgents",
    "socialInteractions",
    "socialReplies",
    "socialLessons",
    "socialAutoReplyClaims",
  ];
  it.each([...credit, ...social])("Workspace.update with %s is rejected", (relation) => {
    expect(
      rejected("Workspace", "update", {
        where: { id: WS },
        data: { [relation]: { deleteMany: {} } },
      }),
    ).toBe(true);
  });

  it("a credit hold cannot delete or rewrite its ledger entries", () => {
    for (const write of [{ deleteMany: {} }, { updateMany: { where: {}, data: { amount: 0 } } }]) {
      expect(
        rejected("CreditHold", "update", {
          where: { workspaceId: WS, id: ID },
          data: { entries: write },
        }),
      ).toBe(true);
    }
  });

  it("plain field updates on those models still pass", () => {
    expect(
      rejected("CreditHold", "updateMany", {
        where: { workspaceId: WS, id: ID, status: "HELD" },
        data: { status: "RELEASED" },
      }),
    ).toBe(false);
    expect(rejected("Workspace", "update", { where: { id: WS }, data: { name: "x" } })).toBe(false);
  });
});

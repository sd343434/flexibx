import { randomBytes } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters } from "@/server/ads/adapter";
import { createMetaAdapter } from "@/server/ads/adapters/meta";
import { completeConnection, selectAccount, startConnection } from "@/server/ads/connections";
import { executionTag, runCreationSteps } from "@/server/ads/execution";
import {
  createAdPlan,
  getAdPlanReview,
  refreshPlanIdentities,
  selectPlanIdentity,
  reopenAdPlan,
  requestActivation,
  submitAdPlan,
  updateAdPlan,
  type ExecutionDeps,
} from "@/server/ads/planner";
import { setSpendLimit } from "@/server/ads/spend-limits";
import { createFakeProvider } from "@/server/ai/fake-provider";
import { decideApproval } from "@/server/orchestration/approvals";
import { executeRun, type OrchestrationDeps } from "@/server/orchestration/engine";
import { setAutomationPaused } from "@/server/orchestration/policy";
import { adActivateWorkflow } from "@/server/orchestration/workflows/ad-activate";
import {
  adLaunchWorkflow,
  type AdLaunchServices,
} from "@/server/orchestration/workflows/ad-launch";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

// The shared advertising executor on the real database, driving the real Meta writer
// against a deterministic stand-in for graph.facebook.com that keeps the objects it was
// asked to create. Nothing here reaches Meta, publishes an ad or spends money: these
// tests prove Flexibx's own guarantees (approval, ledger, idempotency, reconciliation,
// limits, isolation), NOT that Meta accepts these requests — that needs a real test
// ad account (docs/ADVERTISING.md).

const { system, db } = createTestDb();
const KEY = randomBytes(32).toString("base64");
const TOKEN = "EAAB-exec-secret-token";
const REDIRECT = "https://app.test/api/integrations/meta/callback";
const WRITE_SCOPES = ["ads_read", "ads_management", "pages_show_list", "pages_manage_ads"];
const ai = { provider: createFakeProvider(), timeoutMs: 5_000 };

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── a stand-in for the Graph API that remembers what it created ──────────────

type Fault =
  /** Refused: nothing created. */
  | "refuse"
  /** Created, but the answer is lost (HTTP 500). */
  | "created_then_500"
  /** The connection drops before Meta sees it: nothing created, outcome unknown. */
  | "network";

interface GraphObject {
  id: string;
  edge: string;
  name: string;
  status: string;
  params: Record<string, string>;
}

function fakeGraph(options: { permissions?: string[]; pages?: Record<string, unknown>[] } = {}) {
  const calls: {
    method: string;
    path: string;
    params: Record<string, string>;
    token?: string | null;
  }[] = [];
  const objects = new Map<string, GraphObject>();
  const faults = new Map<string, Fault>(); // "METHOD path" → next fault (once)
  // "METHOD path" → runs after the object was created, before the answer (once).
  const afterCreate = new Map<string, () => Promise<void>>();
  // "METHOD path" → the request never answers until it is aborted (a slow platform).
  const hang = new Set<string>();
  let markHanging: () => void = () => undefined;
  const hanging = new Promise<void>((resolve) => {
    markHanging = resolve;
  });
  let sequence = 0;
  const pages: Record<string, unknown>[] = [
    {
      id: "555000",
      name: "Cafe Page",
      tasks: ["ADVERTISE", "ANALYZE"],
      access_token: "PAGE-TOKEN-555000",
    },
    // A Page the person can only analyse: never used to advertise.
    { id: "555001", name: "Another Page", tasks: ["ANALYZE"], access_token: "PAGE-TOKEN-555001" },
    ...(options.pages ?? []),
  ];
  const removePage = (id: string) => {
    const index = pages.findIndex((page) => page.id === id);
    if (index >= 0) pages.splice(index, 1);
  };

  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    const method = init?.method ?? "GET";
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (init?.body instanceof URLSearchParams) Object.assign(params, Object.fromEntries(init.body));
    if (init?.body instanceof FormData) params.upload = "file";
    const usedToken = params.access_token ?? null;
    delete params.access_token;
    delete params.appsecret_proof;
    calls.push({ method, path, params, token: usedToken });
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

    const key = `${method} ${path}`;
    if (hang.has(key)) {
      markHanging();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const fault = faults.get(key);
    if (fault !== undefined) faults.delete(key);
    if (fault === "network") throw new TypeError("fetch failed");
    if (fault === "refuse") return json({ error: { code: 100, message: "Invalid" } }, 400);

    if (path === "/oauth/access_token") return json({ access_token: TOKEN, expires_in: 5_000_000 });
    if (path === "/me") return json({ id: "777", name: "Graph Tester" });
    if (path === "/me/permissions") {
      return json({
        data: (options.permissions ?? WRITE_SCOPES).map((permission) => ({
          permission,
          status: "granted",
        })),
      });
    }
    if (path === "/me/adaccounts") {
      return json({
        data: [
          {
            id: "act_111",
            account_id: "111",
            name: "Main SAR",
            currency: "SAR",
            timezone_name: "Asia/Riyadh",
            account_status: 1,
          },
        ],
      });
    }
    if (path === "/me/accounts") {
      return json({ data: pages });
    }
    const edge = /^\/act_111\/(adimages|campaigns|adsets|adcreatives|ads)$/.exec(path)?.[1];
    if (edge !== undefined && method === "POST") {
      let result: unknown;
      if (edge === "adimages") {
        result = { images: { "storefront.png": { hash: "h4sh" } } };
      } else {
        sequence += 1;
        const id = `${edge}${String(sequence)}`;
        objects.set(id, {
          id,
          edge,
          name: params.name ?? "",
          status: params.status ?? "PAUSED",
          params,
        });
        result = { id };
      }
      const hook = afterCreate.get(key);
      if (hook !== undefined) {
        afterCreate.delete(key);
        await hook();
      }
      if (fault === "created_then_500") return json({ error: { code: 2 } }, 500);
      return json(result);
    }
    if (edge !== undefined && method === "GET") {
      // An ad account's campaigns or creatives (every one: Meta lists, Flexibx matches).
      return json({
        data: [...objects.values()]
          .filter((object) => object.edge === edge)
          .map(({ id, name }) => ({ id, name })),
      });
    }
    // A parent's children: a campaign's ad sets, an ad set's ads.
    const children = /^\/([A-Za-z0-9]+)\/(adsets|ads)$/.exec(path);
    if (children !== null && method === "GET") {
      const [, parent, child] = children;
      const link = child === "adsets" ? "campaign_id" : "adset_id";
      return json({
        data: [...objects.values()]
          .filter((object) => object.edge === child && object.params[link] === parent)
          .map(({ id, name }) => ({ id, name })),
      });
    }
    const object = objects.get(path.slice(1));
    if (object !== undefined && method === "POST") {
      object.status = params.status ?? object.status;
      if (fault === "created_then_500") return json({ error: { code: 2 } }, 500);
      return json({ success: true });
    }
    if (object !== undefined && method === "GET") {
      return json({ id: object.id, effective_status: object.status });
    }
    return json({ error: { code: 803 } }, 404);
  };

  const meta = createMetaAdapter({
    appId: "1234567890",
    appSecret: "x".repeat(32),
    version: "v26.0",
    fetch: fetchImpl,
  });
  const posts = (suffix: string) =>
    calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));
  const writes = () =>
    calls.filter((call) => call.method === "POST" && call.path !== "/oauth/access_token");
  return {
    meta,
    calls,
    objects,
    faults,
    posts,
    writes,
    hang,
    hanging: () => hanging,
    afterCreate,
    removePage,
  };
}

type Graph = ReturnType<typeof fakeGraph>;

function adapters(graph: Graph): AdAdapters {
  return {
    META: { platform: "META", available: true, adapter: graph.meta },
    SNAPCHAT: { platform: "SNAPCHAT", available: false, reason: "not_implemented" },
    TIKTOK: { platform: "TIKTOK", available: false, reason: "not_implemented" },
    WHATSAPP: { platform: "WHATSAPP", available: false, reason: "not_implemented" },
  };
}

async function member(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `m-${crypto.randomUUID()}@test.flexibx.local`, name: role },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return createTenantContext({ userId: user.id, workspaceId: ctx.workspaceId, role });
}

const plusDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** A workspace connected to the fake Graph with a reviewed plan ready to submit. */
async function ready(options: { permissions?: string[]; pages?: Record<string, unknown>[] } = {}) {
  const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
  const graph = fakeGraph(options);
  const all = adapters(graph);
  const connectDeps = { db, system, adapters: all, tokenKey: KEY };
  const { url } = await startConnection(connectDeps, owner, {
    platform: "META",
    locale: "en",
    redirectUri: REDIRECT,
  });
  const result = await completeConnection(connectDeps, {
    sessionUserId: owner.userId,
    state: new URL(url).searchParams.get("state") ?? "",
    code: "auth-code",
    error: null,
    platform: "META",
    redirectUri: REDIRECT,
  });
  expect(result.outcome).toBe("connected");
  const account = await system.adAccount.findFirstOrThrow({
    where: { workspaceId: owner.workspaceId, externalId: "111" },
  });
  await selectAccount(db, owner, { accountId: account.id, selected: true });
  await system.mediaAsset.create({
    data: {
      workspaceId: owner.workspaceId,
      filename: "storefront.png",
      contentType: "image/png",
      sizeBytes: 3,
      storageKey: `workspaces/${owner.workspaceId}/content-media/${crypto.randomUUID()}.png`,
      storageProvider: "LEGACY_S3",
      altText: "Our storefront",
    },
  });
  const switches = { enabled: true };
  const deps: OrchestrationDeps<AdLaunchServices> & ExecutionDeps = {
    db,
    adapters: all,
    executionEnabled: true,
    tokenKey: KEY,
    services: {
      ads: () => all,
      tokenKey: () => KEY,
      executionEnabled: () => switches.enabled,
      readMedia: (ctx, assetId) =>
        system.mediaAsset
          .findFirst({ where: { workspaceId: ctx.workspaceId, id: assetId } })
          .then((asset) =>
            asset === null
              ? null
              : {
                  body: new Uint8Array([1, 2, 3]),
                  contentType: asset.contentType,
                  filename: asset.filename,
                },
          ),
    },
    workflows: { ad_launch: adLaunchWorkflow, ad_activate: adActivateWorkflow },
  };
  await setSpendLimit(db, owner, { currency: "SAR", maxPlanBudget: "5000", maxDailyBudget: "500" });
  const { planId } = await createAdPlan(
    db,
    owner,
    ai,
    { accountId: account.id, budget: "900", startDate: plusDays(1), endDate: plusDays(10) },
    "en",
  );
  // Facebook placements (Instagram placements need an identity Flexibx does not select).
  const proposal = (await system.adPlan.findUniqueOrThrow({ where: { id: planId } }))
    .proposal as Record<string, unknown>;
  await system.adPlan.update({
    where: { id: planId },
    data: { proposal: { ...proposal, placements: ["FACEBOOK_FEED", "FACEBOOK_STORIES"] } },
  });
  await updateAdPlan(db, owner, planId, {
    budget: "900",
    startDate: plusDays(1),
    endDate: plusDays(10),
    campaignName: "Autumn traffic",
    headline: "Fresh every morning",
    primaryText: "Specialty coffee in Riyadh",
    destinationUrl: "https://shop.example.com/autumn",
  });
  return { owner, graph, deps, switches, planId, accountId: account.id };
}

type Ready = Awaited<ReturnType<typeof ready>>;

const taskOf = (runId: string, key: string) =>
  system.agentTask.findFirstOrThrow({ where: { runId, key } });

/** Submits, reaches the approval step, and approves exactly what is described. */
async function submitAndApprove({ owner, deps, planId }: Ready) {
  const { runId } = await submitAdPlan(deps, owner, planId);
  expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
    state: "NEEDS_ATTENTION",
  });
  const task = await taskOf(runId, "launch");
  expect(task.state).toBe("NEEDS_APPROVAL");
  await decideApproval(db, owner, {
    taskId: task.id,
    decision: "APPROVED",
    snapshotHash: task.approvalHash,
  });
  return { runId, task };
}

async function activateAndApprove({ owner, deps, planId }: Ready) {
  const { runId } = await requestActivation(deps, owner, planId);
  expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
    state: "NEEDS_ATTENTION",
  });
  const task = await taskOf(runId, "activate");
  expect(task).toMatchObject({ state: "NEEDS_APPROVAL", risk: "SPEND" });
  await decideApproval(db, owner, {
    taskId: task.id,
    decision: "APPROVED",
    snapshotHash: task.approvalHash,
  });
  return { runId, task };
}

const ledger = (planId: string) =>
  system.adExecutionStep.findMany({ where: { planId }, orderBy: { createdAt: "asc" } });

// ── creation, paused, then a separately approved activation ─────────────────

describe("executing a Meta plan", () => {
  it("creates everything paused after approval, then activates only after a second approval", async () => {
    const setup = await ready();
    const { owner, deps, graph, planId } = setup;
    const manager = await member(owner, WorkspaceRole.MANAGER);
    await expect(submitAdPlan(deps, manager, planId)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const { runId } = await submitAdPlan(deps, owner, planId);
    // The Page the ads publish as is fixed at submission and shown for approval.
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      identityExternalId: "555000",
    });
    await executeRun(deps, owner.workspaceId, runId);
    expect(graph.writes()).toHaveLength(0);
    const task = await taskOf(runId, "launch");
    expect(task.approvalRequest).toMatchObject({
      action: "launch_ad_campaign",
      amount: { minor: 90_000, currency: "SAR" },
      details: {
        identity: "555000",
        destination: "https://shop.example.com/autumn",
        createdPaused: true,
      },
    });
    const described = (task.approvalRequest as { details: { calls: { endpoint: string }[] } })
      .details.calls;
    expect(described.map((call) => call.endpoint)).toEqual([
      "/act_111/adimages",
      "/act_111/campaigns",
      "/act_111/adsets",
      "/act_111/adcreatives",
      "/act_111/ads",
    ]);

    // A manager cannot approve spending; an admin can.
    await expect(
      decideApproval(db, manager, {
        taskId: task.id,
        decision: "APPROVED",
        snapshotHash: task.approvalHash,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await member(owner, WorkspaceRole.ADMIN);
    await decideApproval(db, admin, {
      taskId: task.id,
      decision: "APPROVED",
      snapshotHash: task.approvalHash,
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({ state: "SUCCEEDED" });

    // In order, every object PAUSED, the budget in the currency's minor units.
    expect(graph.writes().map((call) => call.path)).toEqual([
      "/act_111/adimages",
      "/act_111/campaigns",
      "/act_111/adsets",
      "/act_111/adcreatives",
      "/act_111/ads",
    ]);
    const [, campaign, adset, creative, ad] = graph.writes();
    const tag = executionTag(planId);
    expect(campaign?.params).toMatchObject({
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
      // Ad sets may not borrow budget from each other: the approved amount is the cap.
      is_adset_budget_sharing_enabled: "false",
    });
    // The approved audience only (Advantage+ audience off).
    expect(JSON.parse(adset?.params.targeting ?? "{}")).toMatchObject({
      targeting_automation: { advantage_audience: 0 },
    });
    expect(campaign?.params.name).toContain(`[${tag}]`);
    expect(adset?.params).toMatchObject({
      status: "PAUSED",
      lifetime_budget: "90000",
      campaign_id: "campaigns1",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    expect(JSON.parse(creative?.params.object_story_spec ?? "{}")).toMatchObject({
      page_id: "555000",
      link_data: { image_hash: "h4sh", link: "https://shop.example.com/autumn" },
    });
    expect(ad?.params).toMatchObject({ status: "PAUSED", adset_id: "adsets2" });
    expect([...graph.objects.values()].every((object) => object.status === "PAUSED")).toBe(true);

    expect((await ledger(planId)).map((row) => [row.step, row.status, row.externalId])).toEqual([
      ["media", "SUCCEEDED", "h4sh"],
      ["campaign", "SUCCEEDED", "campaigns1"],
      ["adset", "SUCCEEDED", "adsets2"],
      ["creative", "SUCCEEDED", "adcreatives3"],
      ["ad", "SUCCEEDED", "ads4"],
    ]);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: "LAUNCHED",
      externalCampaignId: "campaigns1",
      externalStatus: "PAUSED",
      activationStatus: null,
    });
    expect(await system.auditLog.count({ where: { action: "ads.step_succeeded" } })).toBe(5);
    // Re-running the finished run sends nothing.
    await executeRun(deps, owner.workspaceId, runId);
    expect(graph.writes()).toHaveLength(5);

    const review = await getAdPlanReview(db, owner, deps.adapters, planId, {
      executionEnabled: true,
    });
    expect(review.execution).toMatchObject({
      identity: "555000",
      activationStatus: null,
      externalStatus: "PAUSED",
      canRequestActivation: true,
    });

    // Activation is its own approved action.
    await expect(requestActivation(deps, manager, planId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const activation = await activateAndApprove(setup);
    expect(activation.task.approvalRequest).toMatchObject({
      action: "activate_ad_campaign",
      amount: { minor: 90_000, currency: "SAR" },
      details: { campaign: "campaigns1", adSet: "adsets2", ad: "ads4", status: "ACTIVE" },
    });
    expect(graph.writes()).toHaveLength(5);
    expect(await executeRun(deps, owner.workspaceId, activation.runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(
      graph
        .writes()
        .slice(5)
        .map((call) => [call.path, call.params.status]),
    ).toEqual([
      ["/ads4", "ACTIVE"],
      ["/adsets2", "ACTIVE"],
      ["/campaigns1", "ACTIVE"],
    ]);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      activationStatus: "ACTIVE",
      externalStatus: "ACTIVE",
    });
    await executeRun(deps, owner.workspaceId, activation.runId);
    expect(graph.writes()).toHaveLength(8);
    await expect(requestActivation(deps, owner, planId)).rejects.toMatchObject({
      fields: [{ code: "ads_plan_locked" }],
    });
    expect(
      (await system.auditLog.findMany({ select: { action: true } })).map((row) => row.action),
    ).toEqual(
      expect.arrayContaining([
        "ads.launch_requested",
        "ads.launch_succeeded",
        "ads.activation_requested",
        "ads.activation_succeeded",
        "ads.state_reconciled",
      ]),
    );
    // No token anywhere in what Flexibx stored.
    const dump = JSON.stringify([
      await system.adExecutionStep.findMany(),
      await system.auditLog.findMany(),
      await system.agentTask.findMany(),
    ]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("PAGE-TOKEN");
    // Only the creative uses the Page token; everything else the person's token.
    expect(creative?.token).toBe("PAGE-TOKEN-555000");
    expect(campaign?.token).toBe(TOKEN);
  });

  it("refuses an unsupported objective before any call", async () => {
    const setup = await ready();
    const plan = await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } });
    await system.adPlan.update({
      where: { id: setup.planId },
      data: { proposal: { ...(plan.proposal as object), objective: "SALES" } },
    });
    await expect(submitAdPlan(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_operation_unavailable" }],
    });
    expect(setup.graph.writes()).toHaveLength(0);
  });
});

// ── partial failures, unknown outcomes and recovery ─────────────────────────

describe("recovering a partial creation", () => {
  async function failThenResume(setup: Ready) {
    await reopenAdPlan(db, setup.owner, setup.planId);
    // Objects exist: the plan they were built from can no longer change.
    await expect(
      updateAdPlan(db, setup.owner, setup.planId, {
        budget: "100",
        startDate: plusDays(1),
        endDate: plusDays(10),
        campaignName: "Changed",
        headline: "Changed",
        primaryText: "Changed",
      }),
    ).rejects.toMatchObject({ fields: [{ code: "ads_external_objects_exist" }] });
    const { runId } = await submitAndApprove(setup);
    return executeRun(setup.deps, setup.owner.workspaceId, runId);
  }

  it("resumes after a refused step without creating anything twice", async () => {
    const setup = await ready();
    setup.graph.faults.set("POST /act_111/adsets", "refuse");
    const { runId } = await submitAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect((await ledger(setup.planId)).map((row) => [row.step, row.status])).toEqual([
      ["media", "SUCCEEDED"],
      ["campaign", "SUCCEEDED"],
      ["adset", "FAILED"],
    ]);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      status: "FAILED",
      failureCode: "ads_provider_error",
    });

    expect(await failThenResume(setup)).toMatchObject({ state: "SUCCEEDED" });
    expect(setup.graph.posts("/campaigns")).toHaveLength(1);
    expect(setup.graph.posts("/adimages")).toHaveLength(1);
    expect(setup.graph.posts("/adsets")).toHaveLength(2); // the refused one and the real one
    expect([...setup.graph.objects.values()].filter((o) => o.edge === "campaigns")).toHaveLength(1);
  });

  it("never resends a write whose outcome is unknown: it finds the object first", async () => {
    const setup = await ready();
    setup.graph.faults.set("POST /act_111/campaigns", "created_then_500");
    const { runId } = await submitAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      status: "FAILED",
      failureCode: "ads_outcome_unknown",
    });
    expect((await ledger(setup.planId)).at(-1)).toMatchObject({
      step: "campaign",
      status: "UNCERTAIN",
      externalId: null,
    });
    // The engine does not retry it by itself.
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    expect(setup.graph.posts("/campaigns")).toHaveLength(1);

    expect(await failThenResume(setup)).toMatchObject({ state: "SUCCEEDED" });
    expect(setup.graph.posts("/campaigns")).toHaveLength(1);
    expect(
      setup.graph.calls.some((call) => call.method === "GET" && call.path === "/act_111/campaigns"),
    ).toBe(true);
    expect(await system.auditLog.count({ where: { action: "ads.step_uncertain" } })).toBe(1);
    expect(await system.auditLog.count({ where: { action: "ads.step_reconciled" } })).toBe(1);
  });

  it("writes again only when the lookup proves the object does not exist", async () => {
    const setup = await ready();
    setup.graph.faults.set("POST /act_111/campaigns", "network");
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    expect(await failThenResume(setup)).toMatchObject({ state: "SUCCEEDED" });
    expect(setup.graph.posts("/campaigns")).toHaveLength(2);
    expect([...setup.graph.objects.values()].filter((o) => o.edge === "campaigns")).toHaveLength(1);
  });

  it("stops when the lookup itself fails, without writing", async () => {
    const setup = await ready();
    setup.graph.faults.set("POST /act_111/campaigns", "network");
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    setup.graph.faults.set("GET /act_111/campaigns", "network");
    expect(await failThenResume(setup)).toMatchObject({ state: "FAILED" });
    expect(setup.graph.posts("/campaigns")).toHaveLength(1);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      failureCode: "ads_outcome_unknown",
    });
  });

  it("reconciles an activation whose answer was lost instead of repeating it blindly", async () => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    setup.graph.faults.set("POST /campaigns1", "created_then_500");
    const first = await activateAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, first.runId)).toMatchObject({
      state: "FAILED",
    });
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      activationStatus: "UNCERTAIN",
    });
    const sent = setup.graph.writes().length;
    // A person asks again; it needs a new approval, and then the platform is read first.
    const second = await activateAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, second.runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(setup.graph.writes()).toHaveLength(sent);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      activationStatus: "ACTIVE",
    });
  });

  it("never reports a failed activation when Meta accepted it but its status cannot be read", async () => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    // The three activation writes succeed; the read of the result is lost.
    setup.graph.faults.set("GET /campaigns1", "network");
    const first = await activateAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, first.runId)).toMatchObject({
      state: "FAILED",
    });
    // The campaign may be delivering: "outcome unknown", not "failed".
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      activationStatus: "UNCERTAIN",
      failureCode: "ads_outcome_unknown",
    });
    const sent = setup.graph.writes().length;
    const second = await activateAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, second.runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    // Meta is read first and nothing is written again.
    expect(setup.graph.writes()).toHaveLength(sent);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      activationStatus: "ACTIVE",
      externalStatus: "ACTIVE",
    });
  });
});

// ── what is checked again right before any external write ───────────────────

describe("re-checks at execution time", () => {
  it("asks again when the identity or destination changes after approval", async () => {
    const setup = await ready();
    const { runId, task } = await submitAndApprove(setup);
    await system.adPlan.update({
      where: { id: setup.planId },
      data: { identityExternalId: "999999" },
    });
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    expect(setup.graph.writes()).toHaveLength(0);
    const again = await taskOf(runId, "launch");
    expect(again).toMatchObject({ state: "NEEDS_APPROVAL", approvalRound: 2 });
    expect(again.approvalHash).not.toBe(task.approvalHash);
  });

  it("sends nothing under the emergency stop, and resumes only when it is lifted", async () => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    await setAutomationPaused(db, setup.owner, true);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toEqual({
      status: "paused",
    });
    expect(setup.graph.writes()).toHaveLength(0);
    await setAutomationPaused(db, setup.owner, false);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "SUCCEEDED",
    });
  });

  const changes: [string, (setup: Ready) => Promise<unknown>, string][] = [
    [
      "execution turned off",
      (setup) => Promise.resolve((setup.switches.enabled = false)),
      "ads_execution_disabled",
    ],
    [
      "a lowered spending limit",
      (setup) =>
        setSpendLimit(db, setup.owner, {
          currency: "SAR",
          maxPlanBudget: "100",
          maxDailyBudget: "50",
        }),
      "ads_spend_limit_exceeded",
    ],
    [
      "a lost write permission",
      (setup) =>
        system.adConnection.updateMany({
          where: { workspaceId: setup.owner.workspaceId },
          data: { scopes: ["ads_read"] },
        }),
      "ads_permission_missing",
    ],
    [
      "an expired token",
      (setup) =>
        system.adConnection.updateMany({
          where: { workspaceId: setup.owner.workspaceId },
          data: { status: "EXPIRED" },
        }),
      "account_unavailable",
    ],
    [
      "a revoked connection",
      (setup) =>
        system.adConnection.updateMany({
          where: { workspaceId: setup.owner.workspaceId },
          data: { status: "REVOKED", tokenCiphertext: null },
        }),
      "account_unavailable",
    ],
  ];

  it.each(changes)("fails closed after approval on %s", async (_label, change, code) => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    await change(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.graph.writes()).toHaveLength(0);
    expect(await taskOf(runId, "launch")).toMatchObject({ state: "FAILED", failureCode: code });
  });

  it("keeps workspaces apart", async () => {
    const setup = await ready();
    const other = await createTenant(system, { role: WorkspaceRole.OWNER });
    for (const attempt of [
      () => submitAdPlan(setup.deps, other, setup.planId),
      () => requestActivation(setup.deps, other, setup.planId),
      () => getAdPlanReview(db, other, setup.deps.adapters, setup.planId),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // The ledger cannot point at another workspace's plan.
    await expect(
      system.adExecutionStep.create({
        data: {
          workspaceId: other.workspaceId,
          planId: setup.planId,
          step: "campaign",
          status: "SUCCEEDED",
        },
      }),
    ).rejects.toThrow();
    // A spending limit belongs to one workspace: another workspace's limit allows nothing here.
    await setSpendLimit(db, other, {
      currency: "SAR",
      maxPlanBudget: "5000",
      maxDailyBudget: "500",
    });
    await system.adSpendLimit.deleteMany({ where: { workspaceId: setup.owner.workspaceId } });
    await expect(submitAdPlan(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_spend_limit_missing" }],
    });
  });
});

// ── identity and timeouts ───────────────────────────────────────────────────

describe("identity and timeouts", () => {
  it("advertises only as a Page with the ADVERTISE task, and never guesses between several", async () => {
    const setup = await ready({
      pages: [{ id: "555002", name: "Second Page", tasks: ["ADVERTISE"] }],
    });
    await expect(submitAdPlan(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_identity_ambiguous" }],
    });
    expect(await system.agentRun.count()).toBe(0);
    expect(setup.graph.writes()).toHaveLength(0);
  });

  it("stops at a timeout: the write in flight is recorded as unknown and nothing more is sent", async () => {
    const setup = await ready();
    const writer = setup.graph.meta.writer;
    if (writer === undefined) throw new Error("no writer");
    const controller = new AbortController();
    const plan = await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } });
    const { readCampaignSpec } = await import("@/server/ads/model");
    const spec = readCampaignSpec(plan.proposal);
    if (spec === null) throw new Error("no spec");
    setup.graph.hang.add("POST /act_111/adsets");
    const run = runCreationSteps({
      db,
      workspaceId: setup.owner.workspaceId,
      planId: setup.planId,
      writer,
      token: "token",
      context: {
        request: {
          planId: plan.id,
          accountExternalId: "111",
          currency: "SAR",
          budgetTotalMinor: 90_000,
          startDate: plusDays(1),
          endDate: plusDays(10),
          timeZone: "Asia/Riyadh",
          media: null,
          spec,
        },
        tag: executionTag(plan.id),
        identityId: "555000",
        media: null,
        signal: controller.signal,
      },
    });
    await setup.graph.hanging();
    controller.abort();
    await expect(run).rejects.toMatchObject({ uncertain: true });
    expect((await ledger(setup.planId)).map((row) => [row.step, row.status])).toEqual([
      ["campaign", "SUCCEEDED"],
      ["adset", "UNCERTAIN"],
    ]);
    expect(setup.graph.posts("/adcreatives")).toHaveLength(0);
    expect(setup.graph.posts("/ads")).toHaveLength(0);
  });
});

// ── Page choice, placements, interruptions and concurrency ──────────────────

describe("choosing the Page and the placements", () => {
  it("lets a person choose among several Pages and publishes as exactly that Page", async () => {
    const setup = await ready({
      pages: [
        {
          id: "555002",
          name: "Second Page",
          tasks: ["ADVERTISE", "MANAGE"],
          access_token: "PAGE-TOKEN-555002",
        },
      ],
    });
    const manager = await member(setup.owner, WorkspaceRole.MANAGER);
    await expect(submitAdPlan(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_identity_ambiguous" }],
    });
    // Listing is read-only on Meta and chooses nothing when there are several.
    expect(await refreshPlanIdentities(setup.deps, manager, setup.planId)).toEqual({
      count: 2,
      complete: true,
    });
    expect(setup.graph.writes()).toHaveLength(0);
    const listed = await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } });
    expect(listed).toMatchObject({ identityExternalId: null });
    // Only a listed Page can be chosen.
    await expect(selectPlanIdentity(db, manager, setup.planId, "555001")).rejects.toMatchObject({
      fields: [{ code: "ads_identity_missing" }],
    });
    await selectPlanIdentity(db, manager, setup.planId, "555002");
    const { runId, task } = await submitAndApprove(setup);
    expect(task.approvalRequest).toMatchObject({
      details: { identity: "555002", identityName: "Second Page" },
    });
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const creative = setup.graph.posts("/adcreatives")[0];
    expect(JSON.parse(creative?.params.object_story_spec ?? "{}")).toMatchObject({
      page_id: "555002",
    });
    // Created with that Page's own token (Meta's documented prerequisite).
    expect(creative?.token).toBe("PAGE-TOKEN-555002");
    expect(
      await system.auditLog.count({
        where: { action: { in: ["ads.identities_listed", "ads.identity_selected"] } },
      }),
    ).toBe(2);
  });

  it("refuses a chosen Page that Meta no longer lists, without guessing another", async () => {
    const setup = await ready({
      pages: [{ id: "555002", name: "Second Page", tasks: ["ADVERTISE"] }],
    });
    await refreshPlanIdentities(setup.deps, setup.owner, setup.planId);
    await selectPlanIdentity(db, setup.owner, setup.planId, "555002");
    // The person lost access to that Page on Meta.
    setup.graph.removePage("555002");
    await expect(submitAdPlan(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_identity_missing" }],
    });
    expect(await system.agentRun.count()).toBe(0);
  });

  it("does not create the creative when the Page token is no longer available at write time", async () => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    // Access to the Page was withdrawn on Meta after approval.
    setup.graph.removePage("555000");
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.graph.posts("/adcreatives")).toHaveLength(0);
    expect((await ledger(setup.planId)).at(-1)).toMatchObject({
      step: "creative",
      status: "FAILED",
      errorCode: "ads_permission_missing",
    });
  });

  it("refuses automatic or Instagram placements before any call, and accepts Facebook ones", async () => {
    const setup = await ready();
    for (const placements of [["AUTOMATIC"], ["FACEBOOK_FEED", "INSTAGRAM_FEED"]]) {
      const plan = await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } });
      await system.adPlan.update({
        where: { id: setup.planId },
        data: { proposal: { ...(plan.proposal as object), placements } },
      });
      await expect(submitAdPlan(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
        fields: [{ code: "ads_operation_unavailable" }],
      });
      const review = await getAdPlanReview(db, setup.owner, setup.deps.adapters, setup.planId, {
        executionEnabled: true,
      });
      expect(review.launch).toEqual({ available: false, reason: "placement_unsupported" });
    }
    // The person picks Facebook placements in the plan form: launchable again.
    await updateAdPlan(db, setup.owner, setup.planId, {
      budget: "900",
      startDate: plusDays(1),
      endDate: plusDays(10),
      campaignName: "Autumn traffic",
      headline: "Fresh every morning",
      primaryText: "Specialty coffee in Riyadh",
      destinationUrl: "https://shop.example.com/autumn",
      placements: ["FACEBOOK_FEED", "FACEBOOK_REELS"],
    });
    expect(
      (
        await getAdPlanReview(db, setup.owner, setup.deps.adapters, setup.planId, {
          executionEnabled: true,
        })
      ).launch,
    ).toEqual({ available: true });
    expect(setup.graph.writes()).toHaveLength(0);
  });
});

describe("interruptions and concurrency", () => {
  it("stops between writes when the emergency stop is pressed mid-creation, then resumes without duplicates", async () => {
    const setup = await ready();
    setup.graph.afterCreate.set("POST /act_111/campaigns", () =>
      setAutomationPaused(db, setup.owner, true),
    );
    const { runId } = await submitAndApprove(setup);
    // The engine itself sees the stop after the task and holds the rest of the run.
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toEqual({
      status: "paused",
    });
    // The campaign was created before the stop; nothing after it was sent.
    expect(setup.graph.writes().map((call) => call.path)).toEqual([
      "/act_111/adimages",
      "/act_111/campaigns",
    ]);
    expect(await taskOf(runId, "launch")).toMatchObject({ failureCode: "automation_paused" });
    expect((await ledger(setup.planId)).map((row) => [row.step, row.status])).toEqual([
      ["media", "SUCCEEDED"],
      ["campaign", "SUCCEEDED"],
    ]);
    await setAutomationPaused(db, setup.owner, false);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.graph.writes()).toHaveLength(2);
    await reopenAdPlan(db, setup.owner, setup.planId);
    const again = await submitAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, again.runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(setup.graph.posts("/campaigns")).toHaveLength(1);
  });

  it("recovers after a worker died mid-write: the object is found, not created again", async () => {
    const setup = await ready();
    // The ad set is created on Meta, then the worker dies before recording anything.
    setup.graph.faults.set("POST /act_111/adsets", "created_then_500");
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    // What a crash leaves behind: the step in flight, the plan still submitted, the run
    // failed by lease recovery (outcome unknown).
    await system.adExecutionStep.updateMany({
      where: { planId: setup.planId, step: "adset" },
      data: { status: "IN_FLIGHT", errorCode: null },
    });
    await system.adPlan.update({
      where: { id: setup.planId },
      data: { status: "SUBMITTED", failureCode: null },
    });
    expect(await system.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      state: "FAILED",
    });
    await reopenAdPlan(db, setup.owner, setup.planId);
    const again = await submitAndApprove(setup);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, again.runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(setup.graph.posts("/adsets")).toHaveLength(1);
    expect(
      setup.graph.calls.some((call) => call.method === "GET" && call.path === "/campaigns1/adsets"),
    ).toBe(true);
  });

  it("creates one run for simultaneous duplicate submissions", async () => {
    const setup = await ready();
    const results = await Promise.allSettled([
      submitAdPlan(setup.deps, setup.owner, setup.planId),
      submitAdPlan(setup.deps, setup.owner, setup.planId),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await system.agentRun.count()).toBe(1);
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      status: "SUBMITTED",
    });
  });

  it("lets an activation be asked again after its worker died, reading Meta before writing", async () => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const { runId: activation } = await requestActivation(setup.deps, setup.owner, setup.planId);
    // While its run is alive, a second request is refused.
    await expect(requestActivation(setup.deps, setup.owner, setup.planId)).rejects.toMatchObject({
      fields: [{ code: "ads_plan_locked" }],
    });
    // The worker died (lease recovery failed the run) with the request still REQUESTED.
    await system.agentRun.update({
      where: { id: activation },
      data: { state: "FAILED", finishedAt: new Date(), failureCode: "outcome_unknown" },
    });
    const again = await activateAndApprove(setup);
    expect(again.runId).not.toBe(activation);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, again.runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(await system.adPlan.findUniqueOrThrow({ where: { id: setup.planId } })).toMatchObject({
      activationStatus: "ACTIVE",
    });
  });

  it("never lets a recommendation act: activation, budget and creation each need their own approval", async () => {
    const setup = await ready();
    const { runId } = await submitAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const writes = setup.graph.writes().length;
    // Nothing in the optimization module performs a write or creates a run.
    const optimization = await import("@/server/ads/optimization");
    expect(
      Object.keys(optimization).filter(
        (key) => typeof (optimization as Record<string, unknown>)[key] === "function",
      ),
    ).toEqual(["recommendOptimizations"]);
    expect(setup.graph.writes()).toHaveLength(writes);
    expect(await system.agentRun.count({ where: { workflow: "ad_activate" } })).toBe(0);
  });
});

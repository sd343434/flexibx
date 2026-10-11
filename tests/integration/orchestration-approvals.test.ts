import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalList } from "@/app/[locale]/w/[workspaceSlug]/autopilot/autopilot-views";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { decideApproval, listPendingApprovals } from "@/server/orchestration/approvals";
import { decideApprovalAction } from "@/server/orchestration/automation-actions";
import {
  cancelRun,
  createRun,
  executeRun,
  recoverStaleTasks,
  type OrchestrationDeps,
} from "@/server/orchestration/engine";
import { setAutomationPaused } from "@/server/orchestration/policy";
import { TaskError, type TaskDefinition } from "@/server/orchestration/workflow";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTenant, createTestDb, resetDatabase } from "./helpers";

// Human approval of automation tasks that act outside Flexibx or spend money, on the real
// database: one decision per request, the exact action recorded, one execution per
// approval, re-checks of the approver and the action before execution, rejection,
// cancellation races and the emergency stop. Test handlers only count calls — nothing
// is published and no money moves.

vi.mock("next/server", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, after: () => undefined };
});

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

// ── a campaign workflow: prepare → publish (EXTERNAL) → boost (SPEND) → report ──────

interface World {
  post: string;
  budgetMinor: number;
  failPublish: number;
}

type Calls = Record<string, number>;

function campaign(world: World) {
  const calls: Calls = {};
  const counted =
    (key: string, run?: () => void): TaskDefinition<Calls>["run"] =>
    () => {
      calls[key] = (calls[key] ?? 0) + 1;
      run?.();
      return Promise.resolve({ status: "succeeded", output: { done: key } });
    };
  const deps: OrchestrationDeps<Calls> = {
    db,
    services: calls,
    workflows: {
      campaign: {
        id: "campaign",
        summaryTask: "report",
        tasks: [
          {
            key: "prepare",
            dependsOn: [],
            risk: "INTERNAL",
            maxAttempts: 1,
            timeoutMs: 5_000,
            run: counted("prepare"),
          },
          {
            key: "publish",
            dependsOn: ["prepare"],
            risk: "EXTERNAL",
            maxAttempts: 2,
            timeoutMs: 5_000,
            describe: () =>
              Promise.resolve({
                action: "publish_post",
                details: { post: world.post, channel: "instagram" },
              }),
            run: counted("publish", () => {
              if (world.failPublish > 0) {
                world.failPublish -= 1;
                throw new TaskError("channel_unavailable", true);
              }
            }),
          },
          {
            key: "boost",
            dependsOn: ["publish"],
            risk: "SPEND",
            maxAttempts: 1,
            timeoutMs: 5_000,
            describe: () =>
              Promise.resolve({
                action: "boost_post",
                details: { post: world.post },
                amount: { minor: world.budgetMinor, currency: "SAR" },
              }),
            run: counted("boost"),
          },
          {
            key: "report",
            dependsOn: ["boost"],
            risk: "INTERNAL",
            maxAttempts: 1,
            timeoutMs: 5_000,
            run: counted("report"),
          },
        ],
      },
    },
  };
  return { deps, calls };
}

async function setup(world: Partial<World> = {}) {
  const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
  const state: World = { post: "p-1", budgetMinor: 5_000, failPublish: 0, ...world };
  const { deps, calls } = campaign(state);
  const { runId } = await createRun(
    deps,
    { workspaceId: owner.workspaceId, requestedByUserId: owner.userId },
    "campaign",
    "MANUAL",
    `manual:${crypto.randomUUID()}`,
  );
  return { owner, world: state, deps, calls, runId };
}

/** Another member of the same workspace. */
async function member(ctx: TenantContext, role: WorkspaceRole): Promise<TenantContext> {
  const user = await system.user.create({
    data: { email: `m-${crypto.randomUUID()}@test.flexibx.local`, name: `Member ${role}` },
  });
  await system.workspaceMember.create({
    data: { workspaceId: ctx.workspaceId, userId: user.id, role },
  });
  return createTenantContext({ userId: user.id, workspaceId: ctx.workspaceId, role });
}

async function task(runId: string, key: string) {
  return system.agentTask.findFirstOrThrow({
    where: { runId, key },
    select: {
      id: true,
      state: true,
      attempts: true,
      approvalRound: true,
      approvalHash: true,
      approvalRequest: true,
      approvedDecisionId: true,
      failureCode: true,
    },
  });
}

async function decide(
  ctx: TenantContext,
  runId: string,
  key: string,
  decision: "APPROVED" | "REJECTED",
  extra: { note?: string; snapshotHash?: string } = {},
) {
  const row = await task(runId, key);
  return decideApproval(db, ctx, {
    taskId: row.id,
    decision,
    snapshotHash: extra.snapshotHash ?? row.approvalHash ?? "",
    ...(extra.note === undefined ? {} : { note: extra.note }),
  });
}

const audits = async (workspaceId: string, action: string) =>
  system.auditLog.findMany({
    where: { workspaceId, action },
    orderBy: { createdAt: "asc" },
    select: { actorUserId: true, metadata: true },
  });

const decisions = (taskId: string) =>
  system.agentTaskApproval.findMany({ where: { taskId }, orderBy: { round: "asc" } });

// ── approve ──────────────────────────────────────────────────────────────────

describe("approving", () => {
  it("runs exactly the approved action once, then asks again for the next one", async () => {
    const { owner, deps, calls, runId } = await setup();
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({
      status: "finished",
      state: "NEEDS_ATTENTION",
    });
    expect(calls).toEqual({ prepare: 1 });
    const asked = await task(runId, "publish");
    expect(asked).toMatchObject({ state: "NEEDS_APPROVAL", approvalRound: 1, attempts: 0 });
    expect(asked.approvalRequest).toEqual({
      workflow: "campaign",
      task: "publish",
      risk: "EXTERNAL",
      action: "publish_post",
      details: { post: "p-1", channel: "instagram" },
      amount: null,
    });
    expect(await task(runId, "boost")).toMatchObject({ state: "PENDING", approvalRound: 0 });

    await decide(owner, runId, "publish", "APPROVED", { note: "  Looks right  " });
    expect(await task(runId, "publish")).toMatchObject({
      state: "PENDING",
      approvedDecisionId: expect.any(String) as string,
    });
    expect((await system.agentRun.findUniqueOrThrow({ where: { id: runId } })).state).toBe(
      "RUNNING",
    );

    // The publish runs; the spending step is a separate action and needs its own approval.
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
      state: "NEEDS_ATTENTION",
    });
    expect(calls).toEqual({ prepare: 1, publish: 1 });
    expect(await task(runId, "publish")).toMatchObject({
      state: "SUCCEEDED",
      approvedDecisionId: null, // the grant was used up
    });
    const boost = await task(runId, "boost");
    expect(boost).toMatchObject({ state: "NEEDS_APPROVAL", approvalRound: 1 });
    expect(boost.approvalRequest).toMatchObject({
      risk: "SPEND",
      amount: { minor: 5_000, currency: "SAR" },
    });

    const admin = await member(owner, WorkspaceRole.ADMIN);
    await decide(admin, runId, "boost", "APPROVED");
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({
      status: "finished",
      state: "SUCCEEDED",
    });
    expect(calls).toEqual({ prepare: 1, publish: 1, boost: 1, report: 1 });

    // The decisions: who, what exactly, how much — immutable rows.
    const [publishDecision] = await decisions(asked.id);
    expect(publishDecision).toMatchObject({
      round: 1,
      decision: "APPROVED",
      decidedByUserId: owner.userId,
      note: "Looks right",
      risk: "EXTERNAL",
      snapshotHash: asked.approvalHash,
      amountMinor: null,
      currency: null,
    });
    const [boostDecision] = await decisions(boost.id);
    expect(boostDecision).toMatchObject({
      decidedByUserId: admin.userId,
      risk: "SPEND",
      amountMinor: 5_000n,
      currency: "SAR",
      snapshotHash: boost.approvalHash,
    });

    // The audit trail carries each decision with its snapshot, and each use of a grant.
    const granted = await audits(owner.workspaceId, "automation.approval_granted");
    expect(granted.map((row) => row.actorUserId)).toEqual([owner.userId, admin.userId]);
    expect(granted[1]?.metadata).toMatchObject({
      task: "boost",
      round: 1,
      risk: "SPEND",
      snapshotHash: boost.approvalHash,
      snapshot: { action: "boost_post", amount: { minor: 5_000, currency: "SAR" } },
      amountMinor: 5_000,
      currency: "SAR",
      hasNote: false,
    });
    expect(await audits(owner.workspaceId, "automation.approval_used")).toHaveLength(2);
  });

  it("uses an approval once: a retry after a failure needs a new approval", async () => {
    const { owner, deps, calls, runId } = await setup({ failPublish: 1 });
    await executeRun(deps, owner.workspaceId, runId);
    await decide(owner, runId, "publish", "APPROVED");
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({ status: "waiting" });
    expect(calls.publish).toBe(1);
    expect(await task(runId, "publish")).toMatchObject({
      state: "PENDING",
      attempts: 1,
      approvedDecisionId: null,
      failureCode: "channel_unavailable",
    });
    // The backoff passes: the engine asks again instead of re-running on the old approval.
    await system.agentTask.updateMany({ where: { runId }, data: { runAfter: new Date(0) } });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
      state: "NEEDS_ATTENTION",
    });
    expect(calls.publish).toBe(1);
    expect(await task(runId, "publish")).toMatchObject({
      state: "NEEDS_APPROVAL",
      approvalRound: 2,
    });
    await decide(owner, runId, "publish", "APPROVED");
    await executeRun(deps, owner.workspaceId, runId);
    expect(calls.publish).toBe(2);
    expect(await task(runId, "publish")).toMatchObject({ state: "SUCCEEDED", attempts: 2 });
  });
});

// ── reject ───────────────────────────────────────────────────────────────────

describe("rejecting", () => {
  it("fails the task and ends the run without running anything after it", async () => {
    const { owner, deps, calls, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    await decide(owner, runId, "publish", "REJECTED", { note: "Wrong channel" });
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({
      status: "finished",
      state: "FAILED",
    });
    expect(calls).toEqual({ prepare: 1 });
    const run = await system.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ failureCode: "publish:approval_rejected" });
    expect(run.finishedAt).not.toBeNull();
    expect(await task(runId, "publish")).toMatchObject({
      state: "FAILED",
      failureCode: "approval_rejected",
      attempts: 0,
    });
    expect(await task(runId, "boost")).toMatchObject({ state: "CANCELLED", approvalRound: 0 });
    expect(await task(runId, "report")).toMatchObject({ state: "CANCELLED" });
    const [decision] = await decisions((await task(runId, "publish")).id);
    expect(decision).toMatchObject({ decision: "REJECTED", note: "Wrong channel" });
    const [audit] = await audits(owner.workspaceId, "automation.approval_rejected");
    expect(audit?.metadata).toMatchObject({ task: "publish", hasNote: true });
  });
});

// ── stale approvals ──────────────────────────────────────────────────────────

describe("stale approvals", () => {
  it("asks again when the action changed between approval and execution", async () => {
    const { owner, world, deps, calls, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    const before = await task(runId, "publish");
    await decide(owner, runId, "publish", "APPROVED");
    world.post = "p-2"; // what would be published is no longer what was approved
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
      state: "NEEDS_ATTENTION",
    });
    expect(calls.publish).toBeUndefined();
    const after = await task(runId, "publish");
    expect(after).toMatchObject({
      state: "NEEDS_APPROVAL",
      approvalRound: 2,
      approvedDecisionId: null,
    });
    expect(after.approvalHash).not.toBe(before.approvalHash);
    expect(after.approvalRequest).toMatchObject({ details: { post: "p-2" } });
    const [stale] = await audits(owner.workspaceId, "automation.approval_stale");
    expect(stale?.metadata).toMatchObject({
      task: "publish",
      reason: "action_changed",
      previousHash: before.approvalHash,
      snapshotHash: after.approvalHash,
    });
    // A decision on what the person saw before is refused: it is not what would run.
    await expect(
      decide(owner, runId, "publish", "APPROVED", { snapshotHash: before.approvalHash ?? "" }),
    ).rejects.toMatchObject({ code: "CONFLICT", fields: [{ code: "approval_changed" }] });
    await decide(owner, runId, "publish", "APPROVED");
    await executeRun(deps, owner.workspaceId, runId);
    expect(calls.publish).toBe(1);
  });

  it("asks again when the approver lost the right to approve before execution", async () => {
    const { owner, deps, calls, runId } = await setup();
    const admin = await member(owner, WorkspaceRole.ADMIN);
    await executeRun(deps, owner.workspaceId, runId);
    await decide(admin, runId, "publish", "APPROVED");
    await system.workspaceMember.updateMany({
      where: { workspaceId: owner.workspaceId, userId: admin.userId },
      data: { role: WorkspaceRole.EDITOR },
    });
    await executeRun(deps, owner.workspaceId, runId);
    expect(calls.publish).toBeUndefined();
    expect(await task(runId, "publish")).toMatchObject({
      state: "NEEDS_APPROVAL",
      approvalRound: 2,
    });
    const [stale] = await audits(owner.workspaceId, "automation.approval_stale");
    expect(stale?.metadata).toMatchObject({ reason: "approver_no_access" });
  });
});

// ── who may decide ───────────────────────────────────────────────────────────

describe("authorization", () => {
  it("lets only current owners and admins of the workspace decide", async () => {
    const { owner, deps, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    const publish = await task(runId, "publish");
    for (const role of [WorkspaceRole.MANAGER, WorkspaceRole.EDITOR, WorkspaceRole.CLIENT]) {
      const ctx = await member(owner, role);
      await expect(decide(ctx, runId, "publish", "APPROVED")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    // An admin demoted after loading the page: the decision re-checks the membership.
    const demoted = await member(owner, WorkspaceRole.ADMIN);
    await system.workspaceMember.updateMany({
      where: { workspaceId: owner.workspaceId, userId: demoted.userId },
      data: { role: WorkspaceRole.VIEWER },
    });
    await expect(decide(demoted, runId, "publish", "APPROVED")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Removed from the workspace altogether.
    const removed = await member(owner, WorkspaceRole.ADMIN);
    await system.workspaceMember.deleteMany({
      where: { workspaceId: owner.workspaceId, userId: removed.userId },
    });
    await expect(decide(removed, runId, "publish", "REJECTED")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await decisions(publish.id)).toHaveLength(0);
    expect(await task(runId, "publish")).toMatchObject({ state: "NEEDS_APPROVAL" });
  });

  it("does not reach a task of another workspace", async () => {
    const { owner, deps, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    const publish = await task(runId, "publish");
    const outsider = await createTenant(system, { role: WorkspaceRole.OWNER });
    await expect(
      decideApproval(db, outsider, {
        taskId: publish.id,
        decision: "APPROVED",
        snapshotHash: publish.approvalHash,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listPendingApprovals(db, outsider)).toEqual([]);
    expect(await listPendingApprovals(db, owner)).toMatchObject([
      { taskId: publish.id, key: "publish", round: 1, snapshotHash: publish.approvalHash },
    ]);
    expect(await decisions(publish.id)).toHaveLength(0);
  });

  it("refuses malformed or unexpected input", async () => {
    const { owner, deps, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    const publish = await task(runId, "publish");
    const valid = { taskId: publish.id, decision: "APPROVED", snapshotHash: publish.approvalHash };
    for (const input of [
      { ...valid, decision: "MAYBE" },
      { ...valid, snapshotHash: "abc" },
      { ...valid, taskId: "not-a-uuid" },
      { ...valid, note: "x".repeat(501) },
    ]) {
      await expect(decideApproval(db, owner, input)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
    // The server action refuses unknown fields before anything else.
    const result = await decideApprovalAction({
      slug: owner.slug,
      taskId: publish.id,
      decision: "APPROVED",
      snapshotHash: publish.approvalHash,
      note: "",
      workspaceId: owner.workspaceId,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await decisions(publish.id)).toHaveLength(0);
  });
});

// ── duplicates, cancellation, emergency stop ─────────────────────────────────

describe("races", () => {
  it("records one decision per request, even when two arrive together", async () => {
    const { owner, deps, runId } = await setup();
    const admin = await member(owner, WorkspaceRole.ADMIN);
    await executeRun(deps, owner.workspaceId, runId);
    const results = await Promise.allSettled([
      decide(owner, runId, "publish", "APPROVED"),
      decide(admin, runId, "publish", "REJECTED"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused?.reason).toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "approval_not_pending" }],
    });
    const publish = await task(runId, "publish");
    expect(await decisions(publish.id)).toHaveLength(1);
    // A later repeat changes nothing either.
    await expect(decide(owner, runId, "publish", "APPROVED")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await decisions(publish.id)).toHaveLength(1);
  });

  it("gives a late approval after cancellation no effect", async () => {
    const { owner, deps, calls, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    const publish = await task(runId, "publish");
    await cancelRun(db, owner, runId);
    await expect(
      decideApproval(db, owner, {
        taskId: publish.id,
        decision: "APPROVED",
        snapshotHash: publish.approvalHash,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", fields: [{ code: "approval_not_pending" }] });
    expect(await decisions(publish.id)).toHaveLength(0);
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({
      status: "finished",
      state: "CANCELLED",
    });
    expect(calls.publish).toBeUndefined();
  });

  it("refuses a decision once the run itself is over, whatever the task says", async () => {
    const { owner, deps, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    // Defence in depth: even a task left waiting in a finished run cannot be approved.
    await system.agentRun.update({
      where: { id: runId },
      data: { state: "CANCELLED", failureCode: null, finishedAt: new Date() },
    });
    await expect(decide(owner, runId, "publish", "APPROVED")).rejects.toMatchObject({
      code: "CONFLICT",
      fields: [{ code: "approval_not_pending" }],
    });
    expect(await decisions((await task(runId, "publish")).id)).toHaveLength(0);
  });

  it("voids an unused approval when the run is cancelled before execution", async () => {
    const { owner, deps, calls, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    await decide(owner, runId, "publish", "APPROVED");
    await cancelRun(db, owner, runId);
    expect(await task(runId, "publish")).toMatchObject({
      state: "CANCELLED",
      approvedDecisionId: null,
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({
      state: "CANCELLED",
    });
    expect(calls.publish).toBeUndefined();
  });

  it("lets the emergency stop override an approval until it is lifted", async () => {
    const { owner, deps, calls, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    await setAutomationPaused(db, owner, true);
    // Deciding is still possible while stopped; executing is not.
    await decide(owner, runId, "publish", "APPROVED");
    expect(await executeRun(deps, owner.workspaceId, runId)).toEqual({ status: "paused" });
    expect(calls.publish).toBeUndefined();
    expect(await task(runId, "publish")).toMatchObject({
      state: "PENDING",
      approvedDecisionId: expect.any(String) as string,
    });
    await setAutomationPaused(db, owner, false);
    await executeRun(deps, owner.workspaceId, runId);
    expect(calls.publish).toBe(1);
  });
});

// ── integrity ────────────────────────────────────────────────────────────────

describe("integrity", () => {
  it("keeps decisions immutable and never replays an external step whose runner died", async () => {
    const { owner, deps, calls, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    const { decisionId } = await decide(owner, runId, "publish", "APPROVED");
    await expect(
      system.agentTaskApproval.update({
        where: { id: decisionId },
        data: { decision: "REJECTED" },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.agentTaskApproval.deleteMany({ where: { workspaceId: owner.workspaceId } }),
    ).rejects.toThrow();
    // A grant can only point at an approval of the task's current request.
    const boost = await task(runId, "boost");
    await expect(
      system.agentTask.update({
        where: { id: boost.id },
        data: { approvedDecisionId: decisionId },
      }),
    ).rejects.toThrow();

    // The publish was claimed and its runner died: the outcome is unknown, so it fails
    // for a person to check — no automatic retry, no new approval request.
    await system.agentTask.updateMany({
      where: { runId, key: "publish" },
      data: {
        state: "RUNNING",
        attempts: 1,
        approvedDecisionId: null,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    expect(await recoverStaleTasks(system, new Date())).toBe(1);
    expect(await task(runId, "publish")).toMatchObject({
      state: "FAILED",
      failureCode: "outcome_unknown",
    });
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({ state: "FAILED" });
    expect(calls.publish).toBeUndefined();
  });

  it("fails a step closed when its action cannot be described validly", async () => {
    const { owner, deps, calls, runId } = await setup({ budgetMinor: 0 });
    await executeRun(deps, owner.workspaceId, runId);
    await decide(owner, runId, "publish", "APPROVED");
    expect(await executeRun(deps, owner.workspaceId, runId)).toMatchObject({ state: "FAILED" });
    expect(await task(runId, "boost")).toMatchObject({
      state: "FAILED",
      failureCode: "invalid_action",
      approvalRound: 0,
    });
    expect(calls.boost).toBeUndefined();
  });
});

// ── rendered approvals ───────────────────────────────────────────────────────

function render(locale: "ar" | "en", node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "ar" ? ar : en,
      timeZone: "Asia/Riyadh",
      children: node,
    }),
  );
}

describe("Autopilot approvals view", () => {
  it("shows the exact action and amount, and decision buttons only to approvers", async () => {
    const { owner, deps, runId } = await setup();
    await executeRun(deps, owner.workspaceId, runId);
    await decide(owner, runId, "publish", "APPROVED");
    await executeRun(deps, owner.workspaceId, runId);
    const approvals = await listPendingApprovals(db, owner);
    expect(approvals).toHaveLength(1);
    const props = { slug: owner.slug, timeZone: "Asia/Riyadh", approvals };

    const html = render(
      "en",
      createElement(ApprovalList, { ...props, locale: "en", canApprove: true }),
    );
    expect(html).toContain('data-risk="SPEND"');
    expect(html).toContain("boost_post");
    expect(html).toMatch(/data-testid="automation-approval-amount">SAR\s?50\.00</);
    expect(html).toContain("Spends money");
    expect(html).toContain('data-testid="automation-approve"');
    expect(html).toContain('data-testid="automation-reject"');
    // Confirmation comes first: the submit buttons appear only after a click.
    expect(html).not.toContain("automation-approve-submit");

    const arabic = render(
      "ar",
      createElement(ApprovalList, { ...props, locale: "ar", canApprove: false }),
    );
    expect(arabic).toContain("ينفق مالًا");
    expect(arabic).toContain("الموافقة أو الرفض متاحان للمالكين والمسؤولين فقط.");
    expect(arabic).not.toContain('data-testid="automation-approve"');

    const empty = render(
      "en",
      createElement(ApprovalList, { ...props, approvals: [], locale: "en", canApprove: true }),
    );
    expect(empty).toContain("Nothing is waiting for approval.");
  });
});

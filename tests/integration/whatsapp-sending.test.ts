import { randomBytes } from "node:crypto";

import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { OptimizationList } from "@/app/[locale]/w/[workspaceSlug]/ads/ads-views";
import { WhatsAppMessaging } from "@/app/[locale]/w/[workspaceSlug]/integrations/messaging-views";

import { WorkspaceRole } from "@/generated/prisma/enums";
import type { AdAdapters } from "@/server/ads/adapter";
import type { IntegrationsPage } from "@/server/ads/ads-queries";
import { createWhatsAppAdapter } from "@/server/ads/adapters/whatsapp";
import { completeConnection, selectAccount, startConnection } from "@/server/ads/connections";
import { decideApproval } from "@/server/orchestration/approvals";
import { executeRun, type OrchestrationDeps } from "@/server/orchestration/engine";
import { setAutomationPaused } from "@/server/orchestration/policy";
import {
  whatsappSendWorkflow,
  type WhatsAppSendServices,
} from "@/server/orchestration/workflows/whatsapp-send";
import { createTenantContext, type TenantContext } from "@/server/tenancy/context";
import {
  addWhatsAppContact,
  listWhatsAppContacts,
  optOutWhatsAppContact,
} from "@/server/whatsapp/contacts";
import { CONTACT_DAILY_CAP, WORKSPACE_DAILY_CAP } from "@/server/whatsapp/messaging";
import {
  listWhatsAppMessages,
  requestWhatsAppSend,
  resolveUncertainMessage,
} from "@/server/whatsapp/sending";
import { parseWebhook, recordWebhookEvents } from "@/server/whatsapp/webhook";
import { syncWhatsAppAccount } from "@/server/whatsapp/whatsapp-service";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTenant, createTestDb, resetDatabase } from "./helpers";

// WhatsApp sending on the real database with a deterministic stand-in for the Cloud API:
// nothing is sent to anyone. All numbers are in the unassigned +999 country code (never a
// real customer). These tests prove Flexibx's own rules — consent, opt-out, templates,
// the 24-hour window, approval, exactly-once sending, unknown outcomes, delivery reports
// in any order, caps and isolation — NOT that Meta delivers these requests.

const { system, db } = createTestDb();
const KEY = randomBytes(32).toString("base64");
const WABA = "1000000001";
const NUMBER_ID = "2000000001";
const CUSTOMER = "+999 55 000 0001";
const CUSTOMER_DIGITS = "999550000001";
const OTHER = "+999 55 000 0002";
const REDIRECT = "https://app.test/api/integrations/whatsapp/callback";

beforeEach(async () => {
  await resetDatabase(system);
});

afterAll(async () => {
  await system.$disconnect();
});

type SendFault = "network" | "server_error" | { code: number; status?: number };

function cloudApi(options: { scopes?: string[] } = {}) {
  const sends: { path: string; body: Record<string, unknown> }[] = [];
  const faults: SendFault[] = [];
  const hooks: { beforeAnswer?: (wamid: string) => Promise<void> } = {};
  let sequence = 0;
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace(/^\/v\d+\.0/, "");
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (path === "/oauth/access_token") return json({ access_token: "wa-secret-token" });
    if (path === "/debug_token") {
      return json({
        data: {
          is_valid: true,
          expires_at: 0,
          user_id: "777",
          scopes: options.scopes ?? ["whatsapp_business_management", "whatsapp_business_messaging"],
          granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA] }],
        },
      });
    }
    if (path === `/${WABA}`) {
      return json({ id: WABA, name: "Acme WhatsApp", account_review_status: "APPROVED" });
    }
    if (path === `/${WABA}/phone_numbers`) {
      return json({
        data: [
          { id: NUMBER_ID, display_phone_number: "+999 50 123 4567", quality_rating: "GREEN" },
        ],
      });
    }
    if (path === `/${WABA}/message_templates`) {
      return json({
        data: [
          { name: "order_update", language: "ar", category: "UTILITY", status: "APPROVED" },
          { name: "promo", language: "ar", category: "MARKETING", status: "PAUSED" },
          { name: "offer", language: "ar", category: "MARKETING", status: "APPROVED" },
        ],
      });
    }
    if (path === `/${NUMBER_ID}/messages` && init?.method === "POST") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer wa-secret-token");
      sends.push({
        path,
        body: JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >,
      });
      const fault = faults.shift();
      if (fault === "network") throw new TypeError("fetch failed");
      if (fault === "server_error") return json({ error: { code: 1 } }, 500);
      if (fault !== undefined) return json({ error: { code: fault.code } }, fault.status ?? 400);
      sequence += 1;
      const wamid = `wamid.TEST${String(sequence)}`;
      await hooks.beforeAnswer?.(wamid);
      return json({ messaging_product: "whatsapp", messages: [{ id: wamid }] });
    }
    return json({ error: { code: 100 } }, 400);
  };
  const whatsapp = createWhatsAppAdapter({
    appId: "1234567890",
    appSecret: "w".repeat(32),
    configId: "987654321",
    version: "v26.0",
    fetch: fetchImpl,
  });
  return { whatsapp, sends, faults, hooks };
}

type Api = ReturnType<typeof cloudApi>;

function adaptersFor(api: Api): AdAdapters {
  return {
    META: { platform: "META", available: false, reason: "not_configured" },
    SNAPCHAT: { platform: "SNAPCHAT", available: false, reason: "not_configured" },
    TIKTOK: { platform: "TIKTOK", available: false, reason: "not_configured" },
    WHATSAPP: { platform: "WHATSAPP", available: true, adapter: api.whatsapp },
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

/** A workspace with a connected, selected and synced WhatsApp account and one contact. */
async function ready(options: { scopes?: string[] } = {}) {
  const owner = await createTenant(system, { role: WorkspaceRole.OWNER });
  const api = cloudApi(options);
  const all = adaptersFor(api);
  const connectDeps = { db, system, adapters: all, tokenKey: KEY };
  const { url } = await startConnection(connectDeps, owner, {
    platform: "WHATSAPP",
    locale: "en",
    redirectUri: REDIRECT,
  });
  const result = await completeConnection(connectDeps, {
    sessionUserId: owner.userId,
    state: new URL(url).searchParams.get("state") ?? "",
    code: "code",
    error: null,
    platform: "WHATSAPP",
    redirectUri: REDIRECT,
  });
  expect(result.outcome).toBe("connected");
  const account = await system.adAccount.findFirstOrThrow({
    where: { workspaceId: owner.workspaceId, platform: "WHATSAPP" },
  });
  await selectAccount(db, owner, { accountId: account.id, selected: true });
  await syncWhatsAppAccount({ ...connectDeps, whatsapp: api.whatsapp }, owner, account.id);
  const { contactId } = await addWhatsAppContact({ db, tokenKey: KEY }, owner, {
    accountId: account.id,
    phone: CUSTOMER,
    consentSource: "website_form",
    consentConfirmed: true,
  });
  const switches = { enabled: true };
  const deps: OrchestrationDeps<WhatsAppSendServices> & {
    sendingEnabled: boolean;
    configured: boolean;
  } = {
    db,
    get sendingEnabled() {
      return switches.enabled;
    },
    configured: true,
    services: {
      ads: () => all,
      tokenKey: () => KEY,
      whatsapp: () => api.whatsapp,
      whatsappSendingEnabled: () => switches.enabled,
    },
    workflows: { whatsapp_send: whatsappSendWorkflow },
  };
  return { owner, api, deps, switches, accountId: account.id, contactId };
}

type Ready = Awaited<ReturnType<typeof ready>>;

const template = (setup: Ready, extra: Record<string, unknown> = {}) => ({
  accountId: setup.accountId,
  phoneNumberId: NUMBER_ID,
  contactId: setup.contactId,
  requestKey: crypto.randomUUID(),
  kind: "TEMPLATE",
  templateName: "order_update",
  templateLanguage: "ar",
  parameters: ["A-1001"],
  ...extra,
});

const taskOf = (runId: string, key: string) =>
  system.agentTask.findFirstOrThrow({ where: { runId, key } });

async function requestAndApprove(setup: Ready, input: Record<string, unknown> = template(setup)) {
  const { runId, messageId } = await requestWhatsAppSend(setup.deps, setup.owner, input);
  expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
    state: "NEEDS_ATTENTION",
  });
  const task = await taskOf(runId, "send");
  expect(task).toMatchObject({ state: "NEEDS_APPROVAL", risk: "EXTERNAL" });
  await decideApproval(db, setup.owner, {
    taskId: task.id,
    decision: "APPROVED",
    snapshotHash: task.approvalHash,
  });
  return { runId, messageId, task };
}

const messageRow = (id: string) => system.whatsAppMessage.findUniqueOrThrow({ where: { id } });

/** A signed-and-verified notification, as the webhook handler would record it. */
async function webhook(
  value: Record<string, unknown>,
  at = new Date(),
): Promise<Awaited<ReturnType<typeof recordWebhookEvents>>> {
  const events = parseWebhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "messages",
            value: { metadata: { phone_number_id: NUMBER_ID }, ...value },
          },
        ],
      },
    ],
  });
  return recordWebhookEvents(system, events ?? [], at, KEY);
}

const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000));
const statusReport = (id: string, status: string, at = new Date()) =>
  webhook(
    { statuses: [{ id, status, timestamp: seconds(at), recipient_id: CUSTOMER_DIGITS }] },
    at,
  );
const inbound = (body: string, at = new Date(), from = CUSTOMER_DIGITS) =>
  webhook(
    {
      messages: [
        {
          id: `in-${crypto.randomUUID()}`,
          from,
          timestamp: seconds(at),
          type: "text",
          text: { body },
        },
      ],
    },
    at,
  );

// ── consent and contacts ─────────────────────────────────────────────────────

describe("WhatsApp contacts and consent", () => {
  it("adds only opted-in contacts, stores the number encrypted and shows it masked", async () => {
    const setup = await ready();
    await expect(
      addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
        accountId: setup.accountId,
        phone: OTHER,
        consentSource: "in_store",
        consentConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    for (const phone of ["0550000002", "+12", "not a number"]) {
      await expect(
        addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
          accountId: setup.accountId,
          phone,
          consentSource: "in_store",
          consentConfirmed: true,
        }),
      ).rejects.toMatchObject({ fields: [{ code: "whatsapp_invalid_number" }] });
    }
    // The same number again: the same contact.
    expect(
      await addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
        accountId: setup.accountId,
        phone: "00999550000001",
        consentSource: "in_store",
        consentConfirmed: true,
      }),
    ).toEqual({ contactId: setup.contactId, created: false });
    const [view] = await listWhatsAppContacts(db, setup.owner);
    expect(view).toMatchObject({ maskedNumber: "•••• 0001", consentStatus: "OPTED_IN" });
    const dump = JSON.stringify([
      await system.whatsAppContact.findMany(),
      await system.auditLog.findMany(),
    ]);
    expect(dump).not.toContain(CUSTOMER_DIGITS);
  });

  it("honours opt-out: by staff, by the customer writing STOP, and only the customer opts back in", async () => {
    const setup = await ready();
    expect(await inbound("STOP")).toMatchObject({ contactsUpdated: 1 });
    expect((await listWhatsAppContacts(db, setup.owner))[0]?.consentStatus).toBe("OPTED_OUT");
    await expect(
      requestWhatsAppSend(setup.deps, setup.owner, template(setup)),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_no_consent" }] });
    // Staff cannot re-add someone who opted out.
    await expect(
      addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
        accountId: setup.accountId,
        phone: CUSTOMER,
        consentSource: "in_store",
        consentConfirmed: true,
      }),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_no_consent" }] });
    // The customer writes START: opted in again. A late copy of the older STOP changes nothing.
    const later = new Date(Date.now() + 1000);
    await inbound("ابدأ", later);
    expect((await listWhatsAppContacts(db, setup.owner))[0]?.consentStatus).toBe("OPTED_IN");
    await inbound("STOP", new Date(Date.now() - 60_000));
    expect((await listWhatsAppContacts(db, setup.owner))[0]?.consentStatus).toBe("OPTED_IN");
    // A sentence that merely contains the word is not an opt-out.
    await inbound("please don't stop the offers", new Date(Date.now() + 2000));
    expect((await listWhatsAppContacts(db, setup.owner))[0]?.consentStatus).toBe("OPTED_IN");
    await optOutWhatsAppContact(db, setup.owner, setup.contactId);
    expect((await listWhatsAppContacts(db, setup.owner))[0]?.consentStatus).toBe("OPTED_OUT");
    expect(await system.auditLog.count({ where: { action: "whatsapp.contact_opted_out" } })).toBe(
      2,
    );
  });

  it("stops an approved message when the contact opts out before it is sent", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestAndApprove(setup);
    await inbound("إيقاف", new Date(Date.now() + 1000));
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.api.sends).toHaveLength(0);
    // The opt-out cancelled the message itself; the approved run cannot send it.
    expect(await messageRow(messageId)).toMatchObject({ status: "CANCELLED" });
    expect(await taskOf(runId, "send")).toMatchObject({ failureCode: "message_not_pending" });
    expect(await system.auditLog.count({ where: { action: "whatsapp.send_cancelled" } })).toBe(1);
  });
});

// ── approval and exactly-once sending ───────────────────────────────────────

describe("sending a WhatsApp message", () => {
  it("sends one approved template message once, after an owner or admin approves it", async () => {
    const setup = await ready();
    const manager = await member(setup.owner, WorkspaceRole.MANAGER);
    const viewer = await member(setup.owner, WorkspaceRole.VIEWER);
    await expect(requestWhatsAppSend(setup.deps, viewer, template(setup))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    setup.switches.enabled = false;
    await expect(
      requestWhatsAppSend(setup.deps, setup.owner, template(setup)),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_sending_disabled" }] });
    setup.switches.enabled = true;

    const input = template(setup);
    // Managers plan; asking to send needs automation access (owners and admins).
    await expect(requestWhatsAppSend(setup.deps, manager, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const admin = await member(setup.owner, WorkspaceRole.ADMIN);
    const { runId, messageId } = await requestWhatsAppSend(setup.deps, admin, input);
    // Submitted twice (same form): one message, one run.
    expect(await requestWhatsAppSend(setup.deps, admin, input)).toEqual({
      runId,
      messageId,
      created: false,
    });
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    expect(setup.api.sends).toHaveLength(0);
    const task = await taskOf(runId, "send");
    expect(task.approvalRequest).toMatchObject({
      action: "send_whatsapp_message",
      details: {
        to: "•••• 0001",
        template: "order_update",
        language: "ar",
        consent: { source: "website_form" },
        body: {
          to: "•••• 0001",
          type: "template",
          template: {
            name: "order_update",
            language: { code: "ar" },
            components: [{ type: "body", parameters: [{ type: "text", text: "A-1001" }] }],
          },
        },
      },
    });
    expect(JSON.stringify(task.approvalRequest)).not.toContain(CUSTOMER_DIGITS);
    await expect(
      decideApproval(db, manager, {
        taskId: task.id,
        decision: "APPROVED",
        snapshotHash: task.approvalHash,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decideApproval(db, setup.owner, {
      taskId: task.id,
      decision: "APPROVED",
      snapshotHash: task.approvalHash,
    });
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(setup.api.sends).toHaveLength(1);
    expect(setup.api.sends[0]?.body).toMatchObject({
      messaging_product: "whatsapp",
      to: CUSTOMER_DIGITS,
      type: "template",
    });
    expect(await messageRow(messageId)).toMatchObject({
      status: "ACCEPTED",
      externalMessageId: "wamid.TEST1",
    });
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    expect(setup.api.sends).toHaveLength(1);
    expect(
      (await system.auditLog.findMany({ select: { action: true } })).map((row) => row.action),
    ).toEqual(expect.arrayContaining(["whatsapp.send_requested", "whatsapp.send_succeeded"]));
    const dump = JSON.stringify([
      await system.whatsAppMessage.findMany(),
      await system.auditLog.findMany(),
      await system.agentTask.findMany(),
    ]);
    expect(dump).not.toContain(CUSTOMER_DIGITS);
    expect(dump).not.toContain("wa-secret-token");
  });

  it("allows only approved templates in their exact language, and the account's own numbers", async () => {
    const setup = await ready();
    for (const [extra, code] of [
      [{ templateName: "promo" }, "whatsapp_template_unavailable"],
      [{ templateLanguage: "en" }, "whatsapp_template_unavailable"],
      [{ templateName: "nonexistent" }, "whatsapp_template_unavailable"],
      [{ phoneNumberId: "2000000099" }, "whatsapp_number_unavailable"],
    ] as const) {
      await expect(
        requestWhatsAppSend(setup.deps, setup.owner, template(setup, extra)),
      ).rejects.toMatchObject({ fields: [{ code }] });
    }
    const narrow = await ready({ scopes: ["whatsapp_business_management"] });
    await expect(
      requestWhatsAppSend(narrow.deps, narrow.owner, template(narrow)),
    ).rejects.toMatchObject({ fields: [{ code: "ads_permission_missing" }] });
    expect(setup.api.sends).toHaveLength(0);
  });

  it("relies only on recently synced numbers and template statuses", async () => {
    const setup = await ready();
    const stale = () =>
      system.whatsAppSnapshot.updateMany({
        where: { accountId: setup.accountId },
        data: { fetchedAt: new Date(Date.now() - 25 * 3_600_000) },
      });
    await stale();
    await expect(
      requestWhatsAppSend(setup.deps, setup.owner, template(setup)),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_sync_required" }] });
    // Fresh again: requested and approved; then the sync ages before sending.
    await system.whatsAppSnapshot.updateMany({
      where: { accountId: setup.accountId },
      data: { fetchedAt: new Date() },
    });
    const { runId } = await requestAndApprove(setup);
    await stale();
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.api.sends).toHaveLength(0);
    expect(await taskOf(runId, "send")).toMatchObject({ failureCode: "whatsapp_sync_required" });
  });

  it("sends free text only inside the 24-hour window, checked again before sending", async () => {
    const setup = await ready();
    const text = (extra: Record<string, unknown> = {}) => ({
      ...template(setup),
      kind: "TEXT",
      text: "Your order is ready",
      ...extra,
    });
    await expect(requestWhatsAppSend(setup.deps, setup.owner, text())).rejects.toMatchObject({
      fields: [{ code: "whatsapp_window_closed" }],
    });
    await inbound("Is my order ready?");
    const { runId } = await requestAndApprove(setup, text());
    // The window closes before the approved message is sent: it is not sent.
    await system.whatsAppContact.updateMany({
      where: { id: setup.contactId },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.api.sends).toHaveLength(0);
    expect(await taskOf(runId, "send")).toMatchObject({ failureCode: "whatsapp_window_closed" });
  });

  it("asks again when the message changes after approval, and sends nothing under the emergency stop", async () => {
    const setup = await ready();
    const { runId, messageId, task } = await requestAndApprove(setup);
    await system.whatsAppMessage.update({
      where: { id: messageId },
      data: { content: { kind: "TEMPLATE", parameters: ["A-9999"] } },
    });
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const again = await taskOf(runId, "send");
    expect(again).toMatchObject({ state: "NEEDS_APPROVAL", approvalRound: 2 });
    expect(again.approvalHash).not.toBe(task.approvalHash);
    await decideApproval(db, setup.owner, {
      taskId: again.id,
      decision: "APPROVED",
      snapshotHash: again.approvalHash,
    });
    await setAutomationPaused(db, setup.owner, true);
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toEqual({
      status: "paused",
    });
    expect(setup.api.sends).toHaveLength(0);
  });

  it("never resends a message whose outcome is unknown", async () => {
    for (const fault of ["network", "server_error"] as const) {
      const setup = await ready();
      setup.api.faults.push(fault);
      const { runId, messageId } = await requestAndApprove(setup);
      expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
        state: "FAILED",
      });
      expect(await messageRow(messageId)).toMatchObject({ status: "UNCERTAIN" });
      expect(await taskOf(runId, "send")).toMatchObject({
        failureCode: "whatsapp_outcome_unknown",
      });
      await executeRun(setup.deps, setup.owner.workspaceId, runId);
      expect(setup.api.sends).toHaveLength(1);
      // A new request to the same contact is refused until a person resolves it.
      await expect(
        requestWhatsAppSend(setup.deps, setup.owner, template(setup)),
      ).rejects.toMatchObject({ fields: [{ code: "whatsapp_send_pending" }] });
      expect(
        await system.auditLog.count({
          where: { workspaceId: setup.owner.workspaceId, action: "whatsapp.send_uncertain" },
        }),
      ).toBe(1);
    }
  });

  it("records refusals without retrying: window, rate limit, marketing opt-out", async () => {
    for (const [code, expected] of [
      [131_047, "whatsapp_window_closed"],
      [130_429, "ads_rate_limited"],
      [131_050, "ads_provider_error"],
    ] as const) {
      const setup = await ready();
      setup.api.faults.push({ code });
      const { runId, messageId } = await requestAndApprove(setup);
      expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
        state: "FAILED",
      });
      expect(setup.api.sends).toHaveLength(1);
      expect(await messageRow(messageId)).toMatchObject({ status: "FAILED", errorCode: code });
      expect((await taskOf(runId, "send")).failureCode).toBe(expected);
      if (code === 131_050) {
        // A marketing opt-out (Meta), not a full one: utility messages remain possible.
        const [contact] = await listWhatsAppContacts(db, setup.owner);
        expect(contact?.consentStatus).toBe("OPTED_IN");
        expect(contact?.marketingOptedOutAt).not.toBeNull();
        expect(contact?.history[0]).toMatchObject({
          kind: "MARKETING_OPTED_OUT",
          source: "error_131050",
        });
      }
    }
  });

  it("caps messages per contact and per workspace", async () => {
    const setup = await ready();
    const sent = (contactId: string) => ({
      workspaceId: setup.owner.workspaceId,
      accountId: setup.accountId,
      contactId,
      phoneNumberId: NUMBER_ID,
      kind: "TEMPLATE",
      templateName: "order_update",
      templateLanguage: "ar",
      content: { kind: "TEMPLATE", parameters: [] },
      status: "DELIVERED",
      idempotencyKey: randomBytes(32).toString("hex"),
    });
    await system.whatsAppMessage.createMany({
      data: Array.from({ length: CONTACT_DAILY_CAP }, () => sent(setup.contactId)),
    });
    await expect(
      requestWhatsAppSend(setup.deps, setup.owner, template(setup)),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", fields: [{ code: "whatsapp_rate_limited" }] });

    const { contactId } = await addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
      accountId: setup.accountId,
      phone: OTHER,
      consentSource: "in_store",
      consentConfirmed: true,
    });
    expect(
      (await requestWhatsAppSend(setup.deps, setup.owner, template(setup, { contactId }))).created,
    ).toBe(true);
    await system.whatsAppMessage.createMany({
      data: Array.from({ length: WORKSPACE_DAILY_CAP }, () => sent(setup.contactId)),
    });
    await system.whatsAppMessage.updateMany({
      where: { contactId },
      data: { status: "DELIVERED" },
    });
    await expect(
      requestWhatsAppSend(setup.deps, setup.owner, template(setup, { contactId })),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_rate_limited" }] });
  });

  it("cancels a rejected message: nothing is sent", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestWhatsAppSend(
      setup.deps,
      setup.owner,
      template(setup),
    );
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const task = await taskOf(runId, "send");
    await decideApproval(db, setup.owner, {
      taskId: task.id,
      decision: "REJECTED",
      snapshotHash: task.approvalHash,
    });
    expect(await executeRun(setup.deps, setup.owner.workspaceId, runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.api.sends).toHaveLength(0);
    // The next request sweeps it to CANCELLED (and is not blocked by it).
    await requestWhatsAppSend(setup.deps, setup.owner, template(setup));
    expect(await messageRow(messageId)).toMatchObject({ status: "CANCELLED" });
  });
});

// ── delivery reports ────────────────────────────────────────────────────────

describe("WhatsApp delivery reports", () => {
  it("moves statuses forward only, whatever the order, duplicates included", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const wamid = (await messageRow(messageId)).externalMessageId ?? "";
    await statusReport(wamid, "read");
    await statusReport(wamid, "delivered");
    await statusReport(wamid, "sent");
    await statusReport(wamid, "read");
    expect(await messageRow(messageId)).toMatchObject({ status: "READ" });
    // A failure after delivery does not undo it.
    await statusReport(wamid, "failed");
    expect(await messageRow(messageId)).toMatchObject({ status: "READ" });
    const [view] = await listWhatsAppMessages(db, setup.owner);
    expect(view).toMatchObject({ status: "READ", to: "•••• 0001" });
  });

  it("applies a report that arrived before the send's own answer", async () => {
    const setup = await ready();
    setup.api.hooks.beforeAnswer = async (wamid) => {
      await statusReport(wamid, "delivered");
    };
    const { runId, messageId } = await requestAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    expect(await messageRow(messageId)).toMatchObject({ status: "DELIVERED" });
  });

  it("records a failure reported before delivery", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestAndApprove(setup);
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const wamid = (await messageRow(messageId)).externalMessageId ?? "";
    await webhook({
      statuses: [
        {
          id: wamid,
          status: "failed",
          timestamp: seconds(new Date()),
          errors: [{ code: 131_026 }],
        },
      ],
    });
    expect(await messageRow(messageId)).toMatchObject({ status: "FAILED", errorCode: 131_026 });
  });
});

// ── workspace isolation ─────────────────────────────────────────────────────

describe("WhatsApp messaging isolation", () => {
  it("keeps contacts, messages and reports inside their workspace", async () => {
    const a = await ready();
    const b = await ready();
    await expect(
      requestWhatsAppSend(b.deps, b.owner, template(b, { contactId: a.contactId })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      requestWhatsAppSend(b.deps, b.owner, template(b, { accountId: a.accountId })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(optOutWhatsAppContact(db, b.owner, a.contactId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // The same customer in both workspaces is two contacts with different keyed hashes.
    const hashes = await system.whatsAppContact.findMany({ select: { phoneHash: true } });
    expect(new Set(hashes.map((row) => row.phoneHash)).size).toBe(2);
    // A STOP sent to the shared business account opts the customer out in both workspaces
    // that connected it (each recorded separately).
    await inbound("STOP");
    expect((await listWhatsAppContacts(db, a.owner))[0]?.consentStatus).toBe("OPTED_OUT");
    expect((await listWhatsAppContacts(db, b.owner))[0]?.consentStatus).toBe("OPTED_OUT");
    // A message cannot point at another workspace's contact.
    await expect(
      system.whatsAppMessage.create({
        data: {
          workspaceId: b.owner.workspaceId,
          accountId: b.accountId,
          contactId: a.contactId,
          phoneNumberId: NUMBER_ID,
          kind: "TEXT",
          content: { kind: "TEXT", text: "x" },
          status: "PENDING",
          idempotencyKey: randomBytes(32).toString("hex"),
        },
      }),
    ).rejects.toThrow();
  });
});

// ── marketing preferences, consent history, interrupted sends ───────────────

/** A signed-and-verified `user_preferences` notification. */
async function preference(
  value: string,
  at = new Date(),
  extra: Record<string, unknown> = { wa_id: CUSTOMER_DIGITS },
) {
  const events = parseWebhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "user_preferences",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: NUMBER_ID },
              user_preferences: [
                {
                  ...extra,
                  detail: "User requested to stop marketing messages",
                  category: "marketing_messages",
                  value,
                  timestamp: Math.floor(at.getTime() / 1000),
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return recordWebhookEvents(system, events ?? [], at, KEY);
}

const offer = (setup: Ready, extra: Record<string, unknown> = {}) =>
  template(setup, { templateName: "offer", parameters: [], ...extra });
const contactOf = async (setup: Ready) =>
  (await listWhatsAppContacts(db, setup.owner)).find((c) => c.id === setup.contactId);

describe("marketing opt-outs", () => {
  it("suppresses marketing (not utility) messages when the customer stops them, until they resume", async () => {
    const setup = await ready();
    const t0 = Date.now();
    expect(await preference("stop", new Date(t0))).toMatchObject({ contactsUpdated: 1 });
    expect((await contactOf(setup))?.marketingOptedOutAt).not.toBeNull();
    await expect(requestWhatsAppSend(setup.deps, setup.owner, offer(setup))).rejects.toMatchObject({
      fields: [{ code: "whatsapp_marketing_opted_out" }],
    });
    // A utility template still goes (consent itself was not withdrawn).
    expect((await requestWhatsAppSend(setup.deps, setup.owner, template(setup))).created).toBe(
      true,
    );
    // Meta retries the same notification: recorded once.
    await preference("stop", new Date(t0));
    // The customer resumes; a late copy of an older "stop" changes nothing.
    await preference("resume", new Date(t0 + 2000));
    await preference("stop", new Date(t0 - 60_000));
    expect((await contactOf(setup))?.marketingOptedOutAt).toBeNull();
    const kinds = (await contactOf(setup))?.history.map((event) => event.kind) ?? [];
    expect(kinds[0]).toBe("MARKETING_RESUMED");
    expect([...kinds].sort()).toEqual(["MARKETING_OPTED_OUT", "MARKETING_RESUMED", "OPTED_IN"]);
    // Any value other than an explicit "resume" is read as "stop" (the safe reading).
    await preference("paused_by_user", new Date(t0 + 4000));
    expect((await contactOf(setup))?.marketingOptedOutAt).not.toBeNull();
    // Without a wa_id (a username-only customer) nothing can be matched.
    expect(await preference("resume", new Date(t0 + 6000), {})).toMatchObject({
      contactsUpdated: 0,
    });
    expect((await contactOf(setup))?.marketingOptedOutAt).not.toBeNull();
    // The customer's number is never stored with the event.
    const dump = JSON.stringify(await system.whatsAppWebhookEvent.findMany());
    expect(dump).not.toContain(CUSTOMER_DIGITS);
  });

  it("cancels marketing messages already waiting for approval and blocks approved ones", async () => {
    const setup = await ready();
    // An approved marketing message, and a pending utility one to another contact.
    const { contactId: other } = await addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
      accountId: setup.accountId,
      phone: OTHER,
      consentSource: "in_store",
      consentConfirmed: true,
    });
    const marketing = await requestAndApprove(setup, offer(setup));
    const utility = await requestWhatsAppSend(
      setup.deps,
      setup.owner,
      template(setup, { contactId: other }),
    );
    await preference("stop", new Date(Date.now() + 1000));
    expect(await messageRow(marketing.messageId)).toMatchObject({ status: "CANCELLED" });
    expect(await messageRow(utility.messageId)).toMatchObject({ status: "PENDING" });
    expect(await executeRun(setup.deps, setup.owner.workspaceId, marketing.runId)).toMatchObject({
      state: "FAILED",
    });
    expect(setup.api.sends).toHaveLength(0);
  });

  it("treats a marketing opt-out reported in a delivery failure the same way", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestAndApprove(setup, offer(setup));
    await executeRun(setup.deps, setup.owner.workspaceId, runId);
    const wamid = (await messageRow(messageId)).externalMessageId ?? "";
    await webhook({
      statuses: [
        {
          id: wamid,
          status: "failed",
          timestamp: seconds(new Date()),
          errors: [{ code: 131_050 }],
        },
      ],
    });
    expect(await messageRow(messageId)).toMatchObject({ status: "FAILED", errorCode: 131_050 });
    expect((await contactOf(setup))?.marketingOptedOutAt).not.toBeNull();
    expect((await contactOf(setup))?.consentStatus).toBe("OPTED_IN");
  });
});

describe("consent history and interrupted sends", () => {
  it("keeps an append-only consent history that staff cannot rewrite", async () => {
    const setup = await ready();
    await optOutWhatsAppContact(db, setup.owner, setup.contactId);
    const events = await system.whatsAppConsentEvent.findMany({
      where: { contactId: setup.contactId },
    });
    expect(events.map((event) => [event.kind, event.source, event.actorUserId])).toEqual(
      expect.arrayContaining([
        ["OPTED_IN", "website_form", setup.owner.userId],
        ["OPTED_OUT", "staff", setup.owner.userId],
      ]),
    );
    await expect(
      system.whatsAppConsentEvent.update({
        where: { id: events[0]?.id ?? "" },
        data: { kind: "OPTED_IN" },
      }),
    ).rejects.toThrow();
    // Through the application client, history cannot be updated or deleted at all.
    await expect(
      db.whatsAppConsentEvent.deleteMany({ where: { workspaceId: setup.owner.workspaceId } }),
    ).rejects.toThrow();
    // Re-adding the contact is refused; only the customer's START re-consents.
    await expect(
      addWhatsAppContact({ db, tokenKey: KEY }, setup.owner, {
        accountId: setup.accountId,
        phone: CUSTOMER,
        consentSource: "in_store",
        consentConfirmed: true,
      }),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_no_consent" }] });
  });

  it("marks a send interrupted by a worker crash as unknown, and only an owner or admin can release it", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestAndApprove(setup);
    // The worker claimed the message and died before Meta answered.
    await system.whatsAppMessage.update({ where: { id: messageId }, data: { status: "SENDING" } });
    await system.agentRun.update({
      where: { id: runId },
      data: { state: "FAILED", finishedAt: new Date(), failureCode: "outcome_unknown" },
    });
    await expect(
      requestWhatsAppSend(setup.deps, setup.owner, template(setup)),
    ).rejects.toMatchObject({ fields: [{ code: "whatsapp_send_pending" }] });
    expect(await messageRow(messageId)).toMatchObject({ status: "UNCERTAIN" });
    const manager = await member(setup.owner, WorkspaceRole.MANAGER);
    await expect(resolveUncertainMessage(db, manager, messageId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await resolveUncertainMessage(db, setup.owner, messageId);
    expect(await messageRow(messageId)).toMatchObject({ status: "UNCERTAIN" });
    expect((await messageRow(messageId)).resolvedAt).not.toBeNull();
    // Released: a new, separately approved message is possible; nothing was resent.
    expect((await requestWhatsAppSend(setup.deps, setup.owner, template(setup))).created).toBe(
      true,
    );
    expect(setup.api.sends).toHaveLength(0);
    await expect(resolveUncertainMessage(db, setup.owner, messageId)).rejects.toMatchObject({
      fields: [{ code: "whatsapp_send_pending" }],
    });
    expect(await system.auditLog.count({ where: { action: "whatsapp.message_resolved" } })).toBe(1);
  });

  it("sends nothing when the emergency stop is pressed between approval and send", async () => {
    const setup = await ready();
    const { runId, messageId } = await requestAndApprove(setup);
    // Pressed after the engine claimed the task (which checks it under a lock): the task
    // itself re-checks right before the message can leave. Run as the engine would.
    await setAutomationPaused(db, setup.owner, true);
    const send = whatsappSendWorkflow.tasks.find((task) => task.key === "send");
    await expect(
      send?.run({
        db,
        runId,
        taskKey: "send",
        actor: setup.owner,
        policy: { enabled: true, paused: false, allowDrafts: false, maxDraftsPerRun: 3 },
        inputs: {},
        signal: new AbortController().signal,
        services: setup.deps.services,
      }),
    ).rejects.toMatchObject({ code: "automation_paused" });
    expect(setup.api.sends).toHaveLength(0);
    expect(await messageRow(messageId)).toMatchObject({ status: "PENDING" });
  });
});

// ── views ────────────────────────────────────────────────────────────────────

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

describe("the messaging and recommendation views", () => {
  const page = (sendingEnabled: boolean) =>
    ({
      sendingEnabled,
      canSend: true,
      canResolve: true,
      canPlan: true,
      whatsapp: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Acme WhatsApp",
          usable: true,
          snapshot: {
            phoneNumbers: [{ id: NUMBER_ID, maskedNumber: "•••• 4567" }],
            templates: [{ name: "order_update", language: "ar", status: "APPROVED" }],
          },
        },
      ],
      contacts: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "11111111-1111-4111-8111-111111111111",
          maskedNumber: "•••• 0001",
          consentStatus: "OPTED_IN",
          consentSource: "website_form",
          consentAt: new Date(),
          optedOutAt: null,
          lastInboundAt: new Date(),
          windowOpen: true,
          marketingOptedOutAt: new Date(),
          history: [
            {
              kind: "MARKETING_OPTED_OUT",
              source: "user_preferences",
              occurredAt: new Date(),
              actorName: null,
            },
            {
              kind: "OPTED_IN",
              source: "website_form",
              occurredAt: new Date(),
              actorName: "Owner",
            },
          ],
        },
      ],
      messages: (["PENDING", "UNCERTAIN", "READ", "FAILED"] as const).map((status, index) => ({
        id: `m${String(index)}`,
        kind: "TEMPLATE",
        templateName: "order_update",
        templateLanguage: "ar",
        to: "•••• 0001",
        status,
        errorCode: null,
        runState: null,
        createdAt: new Date(),
        statusAt: null,
        resolvedAt: null,
      })),
    }) as unknown as IntegrationsPage;

  it("shows consent, statuses and the send switch honestly, in Arabic and English", () => {
    for (const locale of ["ar", "en"] as const) {
      const off = render(
        locale,
        createElement(WhatsAppMessaging, {
          slug: "acme",
          locale,
          timeZone: "Asia/Riyadh",
          data: page(false),
          requestKey: crypto.randomUUID(),
        }),
      );
      expect(off).toContain('data-enabled="false"');
      expect(off).not.toContain('data-testid="whatsapp-send-form"');
      expect(off).toContain("•••• 0001");
      expect(off).not.toContain(CUSTOMER_DIGITS);
      for (const status of ["PENDING", "UNCERTAIN", "READ", "FAILED"]) {
        expect(off).toContain(`data-status="${status}"`);
      }
      const on = render(
        locale,
        createElement(WhatsAppMessaging, {
          slug: "acme",
          locale,
          timeZone: "Asia/Riyadh",
          data: page(true),
          requestKey: crypto.randomUUID(),
        }),
      );
      expect(on).toContain('data-testid="whatsapp-send-form"');
      expect(on).toContain('data-testid="whatsapp-marketing-opted-out"');
      expect(on).toContain('data-testid="whatsapp-consent-history"');
      // An unknown outcome can be released by an owner or admin; nothing is resent.
      expect(on).toContain('data-testid="whatsapp-resolve"');
    }
    const en = render(
      "en",
      createElement(WhatsAppMessaging, {
        slug: "acme",
        locale: "en",
        timeZone: "Asia/Riyadh",
        data: page(false),
        requestKey: crypto.randomUUID(),
      }),
    );
    expect(en).toContain("Outcome unknown (not resent)");
  });

  it("labels recommendations as historical, never as forecasts", () => {
    const optimization = {
      basis: { kind: "historical", days: 30, fetchedAt: "2026-10-10T00:00:00Z" },
      results: [],
      insufficient: ["Small one"],
      recommendations: [
        {
          kind: "pause",
          reason: "low_ctr",
          medianCtr: 0.02,
          campaign: { name: "Weak", ctr: 0.005 },
        },
      ],
    };
    const accounts = [{ id: "a", name: "Main SAR", optimization }] as unknown as Parameters<
      typeof OptimizationList
    >[0]["accounts"];
    const en = render("en", createElement(OptimizationList, { accounts }));
    expect(en).toContain('data-basis="historical"');
    expect(en).toContain("Based on historical results of the last 30 days (not a forecast).");
    expect(en).toContain("Consider pausing “Weak”");
    const arabic = render("ar", createElement(OptimizationList, { accounts }));
    expect(arabic).toContain("ليست توقعاً");
  });
});

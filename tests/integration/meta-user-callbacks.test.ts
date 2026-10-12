// Meta's deauthorize and data deletion callbacks: verified signed_request only, every
// connection the person granted (Meta ads and WhatsApp, every workspace) revoked with its
// token erased, other people's connections untouched, and a confirmation for deletion.
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformCards } from "@/app/[locale]/w/[workspaceSlug]/ads/ads-views";
import { forgetMetaUser } from "@/server/ads/meta-deauthorization";
import { signMetaRequest } from "@/server/ads/meta-signed-request";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

import { createTenant, createTestDb, resetDatabase } from "./helpers";

const SECRET = "callbacks-meta-app-secret-0123456789";
const env = vi.hoisted(() => ({ secret: undefined as string | undefined }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual: Record<string, unknown> & { getAdsEnv: () => Record<string, unknown> } =
    await importOriginal();
  return { ...actual, getAdsEnv: () => ({ ...actual.getAdsEnv(), META_APP_SECRET: env.secret }) };
});

const { system, db } = createTestDb();

beforeEach(async () => {
  await resetDatabase(system);
  env.secret = SECRET;
});

afterAll(async () => {
  await system.$disconnect();
});

async function connect(workspaceId: string, platform: "META" | "WHATSAPP", userId: string) {
  const connection = await system.adConnection.create({
    data: {
      workspaceId,
      platform,
      externalUserId: userId,
      externalUserName: "Amin Example",
      status: "ACTIVE",
      tokenCiphertext: "v1.a.b.c",
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      scopes: ["ads_read"],
    },
  });
  await system.adAccount.create({
    data: {
      workspaceId,
      connectionId: connection.id,
      platform,
      externalId: `${platform}-${workspaceId.slice(0, 8)}`,
      name: "Account",
      currency: "USD",
      externalStatus: "ACTIVE",
      selected: true,
    },
  });
  return connection.id;
}

async function call(kind: "deauthorize" | "data-deletion", signedRequest: string) {
  const route =
    kind === "deauthorize"
      ? await import("@/app/api/integrations/meta/deauthorize/route")
      : await import("@/app/api/integrations/meta/data-deletion/route");
  return route.POST(
    new Request(`http://localhost:3000/api/integrations/meta/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: signedRequest }).toString(),
    }),
  );
}

const signed = (userId: string, secret = SECRET) =>
  signMetaRequest({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: 1_790_000_000 }, secret);

async function setup() {
  const first = await createTenant(system);
  const second = await createTenant(system);
  return {
    mine: [
      await connect(first.workspaceId, "META", "111"),
      await connect(second.workspaceId, "META", "111"),
      await connect(second.workspaceId, "WHATSAPP", "111"),
    ],
    other: await connect(first.workspaceId, "WHATSAPP", "222"),
  };
}

describe("Meta user callbacks", () => {
  it("deauthorize revokes every connection of that person, in every workspace, and nothing else", async () => {
    const { mine, other } = await setup();
    const response = await call("deauthorize", signed("111"));
    expect(response.status).toBe(200);
    for (const id of mine) {
      expect(await system.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "REVOKED",
        tokenCiphertext: null,
        tokenExpiresAt: null,
        lastErrorCode: "platform_deauthorized",
        externalUserId: "111",
      });
      expect(await system.adAccount.count({ where: { connectionId: id, selected: true } })).toBe(0);
    }
    expect(await system.adConnection.findUniqueOrThrow({ where: { id: other } })).toMatchObject({
      status: "ACTIVE",
      tokenCiphertext: "v1.a.b.c",
    });
    expect(
      await system.auditLog.count({
        where: { action: "ads.platform_deauthorized", actorUserId: null },
      }),
    ).toBe(3);
  });

  it("data deletion also erases the stored Facebook identity and answers with a confirmation", async () => {
    const { mine } = await setup();
    const response = await call("data-deletion", signed("111"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[0-9a-f]{20}$/);
    expect(body.url).toMatch(/\/meta-data-deletion\?code=[0-9a-f]{20}$/);
    expect(JSON.stringify(body)).not.toContain("111");
    for (const id of mine) {
      expect(await system.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "REVOKED",
        tokenCiphertext: null,
        externalUserId: "deleted",
        externalUserName: null,
      });
    }
    expect(await system.adConnection.count({ where: { externalUserId: "111" } })).toBe(0);
  });

  it("refuses an unsigned or forged request and changes nothing", async () => {
    const { mine } = await setup();
    expect(
      (await call("deauthorize", signed("111", "forged-secret-0123456789abcdef"))).status,
    ).toBe(400);
    expect((await call("data-deletion", "not-a-signed-request")).status).toBe(400);
    expect(await system.adConnection.count({ where: { id: { in: mine }, status: "ACTIVE" } })).toBe(
      3,
    );
  });

  it("is unavailable without the Meta app secret", async () => {
    await setup();
    env.secret = undefined;
    expect((await call("deauthorize", signed("111"))).status).toBe(503);
    expect(await system.adConnection.count({ where: { status: "ACTIVE" } })).toBe(4);
  });
});

describe("Meta user callbacks never touch a grant that is not the one removed", () => {
  const issuedAt = 1_790_000_000;
  const request = { userId: "111", issuedAt };

  it("leaves a connection that another person reconnected while the request ran", async () => {
    const tenant = await createTenant(system);
    const id = await connect(tenant.workspaceId, "META", "111");
    // Another person reconnects the same workspace between the lookup and the update
    // (the reconnect reuses the workspace's row).
    const racing = {
      adConnection: {
        findMany: async (args: Parameters<typeof system.adConnection.findMany>[0]) => {
          const rows = await system.adConnection.findMany(args);
          await system.adConnection.update({
            where: { id },
            data: { externalUserId: "333", externalUserName: "Someone else" },
          });
          return rows;
        },
      },
    } as unknown as typeof system;
    expect(await forgetMetaUser({ system: racing, db }, request, "data_deletion")).toEqual({
      connections: 0,
    });
    expect(await system.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "ACTIVE",
      externalUserId: "333",
      externalUserName: "Someone else",
      tokenCiphertext: "v1.a.b.c",
    });
    expect(await system.auditLog.count({ where: { entityId: id } })).toBe(0);
  });

  it("ignores a late redelivery once the same person has connected again", async () => {
    const tenant = await createTenant(system);
    const id = await connect(tenant.workspaceId, "META", "111");
    await system.adConnection.update({
      where: { id },
      data: { lastCheckedAt: new Date((issuedAt + 3600) * 1000) },
    });
    expect(await forgetMetaUser({ system, db }, request, "deauthorize")).toEqual({
      connections: 0,
    });
    expect(await system.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "ACTIVE",
      tokenCiphertext: "v1.a.b.c",
    });
    // A grant from before the request is revoked.
    await system.adConnection.update({
      where: { id },
      data: { lastCheckedAt: new Date((issuedAt - 3600) * 1000) },
    });
    expect(await forgetMetaUser({ system, db }, request, "deauthorize")).toEqual({
      connections: 1,
    });
  });

  it("keeps a workspace's own earlier disconnect as it was, and still erases the identity on deletion", async () => {
    const tenant = await createTenant(system);
    const id = await connect(tenant.workspaceId, "META", "111");
    await system.adConnection.update({
      where: { id },
      data: { status: "REVOKED", tokenCiphertext: null, lastErrorCode: null },
    });
    expect(await forgetMetaUser({ system, db }, request, "deauthorize")).toEqual({
      connections: 0,
    });
    expect(await system.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lastErrorCode: null,
      externalUserId: "111",
    });
    expect(await forgetMetaUser({ system, db }, request, "data_deletion")).toEqual({
      connections: 1,
    });
    expect(await system.adConnection.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "REVOKED",
      lastErrorCode: null,
      externalUserId: "deleted",
      externalUserName: null,
    });
  });
});

describe("the Integrations card: revocation and token expiry", () => {
  const card = (
    locale: "ar" | "en",
    lastErrorCode: string | null,
    connection: { status: "ACTIVE" | "REVOKED"; tokenExpiresAt: Date | null } = {
      status: "REVOKED",
      tokenExpiresAt: null,
    },
  ) =>
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "ar" ? ar : en,
        timeZone: "Asia/Riyadh",
        children: createElement(PlatformCards, {
          slug: "acme",
          locale,
          timeZone: "Asia/Riyadh",
          canManage: true,
          platforms: [
            {
              platform: "META" as const,
              available: true,
              reason: null,
              capabilities: {
                connect: true,
                listAccounts: true,
                readCampaigns: true,
                readInsights: true,
                launchCampaign: true,
              },
              connection: {
                ...connection,
                externalUserName: null,
                scopes: [],
                lastErrorCode,
                connectedByName: null,
              },
            },
          ],
        }),
      }),
    );

  it("says why the connection ended, in Arabic and English, and only then", () => {
    for (const locale of ["ar", "en"] as const) {
      const messages = locale === "ar" ? ar : en;
      expect(card(locale, "platform_deauthorized")).toContain(
        messages.ads.connectionRevokedOnPlatform,
      );
      // A Disconnect from Flexibx clears the code: no such notice.
      expect(card(locale, null)).not.toContain('data-testid="ads-connection-revoked"');
    }
  });

  it("warns a week before the token expires and shows it expired from the date", () => {
    const day = 24 * 60 * 60 * 1000;
    const active = (offset: number) =>
      card("ar", null, { status: "ACTIVE", tokenExpiresAt: new Date(Date.now() + offset) });
    expect(active(3 * day)).toContain(ar.ads.connectionExpiringSoon);
    expect(active(3 * day)).toContain('data-status="connected"');
    expect(active(30 * day)).not.toContain('data-testid="ads-token-expiring"');
    expect(active(-day)).toContain('data-status="expired"');
    expect(active(-day)).not.toContain('data-testid="ads-token-expiring"');
  });
});

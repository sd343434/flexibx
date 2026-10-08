// Phase 3 — Marketing Core through the real entry points: form server actions, page
// queries and the media route, with real Better Auth sessions on the real database. The
// request double is the one from members-flow.test.ts (`next/headers` carries cookies).
import type * as NextNavigation from "next/navigation";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignUp } from "@/app/[locale]/(auth)/actions";
import {
  submitBrand,
  submitCampaign,
  submitCampaignStatus,
  submitContent,
  submitContentTransition,
  submitDeleteContent,
  submitDeleteMedia,
  submitMediaAltText,
  submitMovePillar,
  submitPillar,
  submitReschedule,
  submitUpload,
} from "@/app/[locale]/w/[workspaceSlug]/marketing-actions";
import { GET as getMedia } from "@/app/api/w/[workspaceSlug]/media/[assetId]/route";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { getSystemDb } from "@/server/db/client";
import {
  createContentAction,
  saveBrandAction,
  transitionContentAction,
} from "@/server/marketing/marketing-actions";
import {
  getActivityPage,
  getBrandPage,
  getCalendarPage,
  getContentListPage,
  getContentPage,
  getDashboardPage,
  getNewContentPage,
} from "@/server/marketing/marketing-queries";
import { getWorkspaceShell } from "@/server/workspaces/workspace-queries";

import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = [
    "marketing",
    "flow",
    "test",
    "only",
    "secret",
    "0123456789abcdef",
  ].join("-");
  process.env.STORAGE_DRIVER = "test-memory";
  const jar = new Map<string, string>();

  function requestHeaders(): Headers {
    const cookie = [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
    return new Headers({
      origin: "http://localhost:3000",
      "next-action": "test-action",
      ...(cookie.length === 0 ? {} : { cookie: cookie.join("; ") }),
    });
  }

  const nextHeaders = () => ({
    headers: () => Promise.resolve(requestHeaders()),
    cookies: () =>
      Promise.resolve({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        set: (name: string, value: string, options: Record<string, unknown>) => {
          if (options.maxAge === 0 || value === "") jar.delete(name);
          else jar.set(name, value);
        },
      }),
  });
  return { jar, requestHeaders, nextHeaders };
});
vi.mock("next/headers", () => browser.nextHeaders());
vi.mock("next/headers.js", () => browser.nextHeaders());
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/",
}));
const cache = vi.hoisted(() => ({ revalidated: [] as string[] }));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => {
    cache.revalidated.push(`${path}${type === undefined ? "" : `#${type}`}`);
  },
}));

const { system } = createTestDb();
const PASSWORD = "correct horse battery";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
  cache.revalidated.length = 0;
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) data.append(key, item);
    else data.append(key, value);
  }
  return data;
}

async function controlFlow(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    (value) => {
      throw new Error(`expected a redirect or notFound, got ${JSON.stringify(value)}`);
    },
    (caught: unknown) => caught,
  );
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string") throw error;
  return digest;
}
const redirectTarget = async (promise: Promise<unknown>) => {
  const digest = await controlFlow(promise);
  expect(digest.startsWith("NEXT_REDIRECT")).toBe(true);
  return digest.split(";")[2] ?? "";
};

let counter = 0;
async function signedInUser(name = "Reem") {
  counter += 1;
  const email = `mkt-${String(counter)}-${Date.now().toString(36)}@example.com`;
  browser.jar.clear();
  await controlFlow(submitSignUp("en", null, form({ name, email, password: PASSWORD })));
  await controlFlow(submitSignIn("en", null, form({ email, password: PASSWORD })));
  const user = await system.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, email, cookies: new Map(browser.jar) };
}
type Session = Awaited<ReturnType<typeof signedInUser>>;
const actAs = (user: Session | null) => {
  browser.jar.clear();
  if (user !== null) for (const [name, value] of user.cookies) browser.jar.set(name, value);
};

async function team(slug: string, roles: WorkspaceRole[]) {
  const ws = await system.workspace.create({ data: { name: slug.toUpperCase(), slug } });
  const members: Session[] = [];
  for (const role of roles) {
    const user = await signedInUser(role);
    await system.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role } });
    members.push(user);
  }
  return { ws, members };
}

const BRAND = {
  name: "Qahwa",
  description: "",
  website: "https://qahwa.example",
  industry: "",
  market: "",
  language: "AR",
  mission: "",
  positioning: "",
  valueProposition: "",
  toneOfVoice: "Warm",
  personality: "",
  keywords: "coffee، Riyadh",
  forbiddenWords: "",
  ctaStyle: "",
};
const CONTENT = {
  title: "Teaser",
  body: "",
  type: "POST",
  campaignId: "",
  pillarId: "",
  audienceId: "",
  goalId: "",
  plannedAt: "",
  notes: "",
  hashtags: "",
  callToAction: "",
  link: "",
};

function png(): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 4);
  new DataView(bytes.buffer).setUint32(20, 3);
  return bytes;
}

function mediaRequest(slug: string, assetId: string) {
  return getMedia(
    new Request(`http://localhost:3000/api/w/${slug}/media/${assetId}`, {
      headers: browser.requestHeaders(),
    }),
    { params: Promise.resolve({ workspaceSlug: slug, assetId }) },
  );
}

// ── form actions ─────────────────────────────────────────────────────────────

describe("marketing form actions", () => {
  it("save the brand for editors, refuse viewers and keep foreign workspaces hidden", async () => {
    const { members } = await team("acme-team", [WorkspaceRole.EDITOR, WorkspaceRole.VIEWER]);
    const [editor, viewer] = members as [Session, Session];

    actAs(editor);
    expect(await submitBrand("acme-team", "ar", null, form(BRAND))).toMatchObject({ done: true });
    expect(cache.revalidated).toEqual(["/ar/w/acme-team#layout"]);
    const page = await getBrandPage("acme-team");
    expect(page.brand?.keywords).toEqual(["coffee", "Riyadh"]);
    expect(page.can.brandEdit).toBe(true);

    actAs(viewer);
    const refused = await submitBrand("acme-team", "en", null, form({ ...BRAND, name: "Hacked" }));
    expect(refused).toMatchObject({ error: { code: "FORBIDDEN" }, values: { name: "Hacked" } });
    expect((await getBrandPage("acme-team")).can.brandEdit).toBe(false);
    expect((await getBrandPage("acme-team")).brand?.name).toBe("Qahwa");

    // A workspace the user is not a member of: NOT_FOUND, not FORBIDDEN.
    await system.workspace.create({ data: { name: "Other", slug: "other-team" } });
    actAs(editor);
    expect(await submitBrand("other-team", "en", null, form(BRAND))).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    actAs(null);
    expect(await submitBrand("acme-team", "en", null, form(BRAND))).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("never forward fields the form does not name, and actions reject them outright", async () => {
    const { ws, members } = await team("acme-team", [WorkspaceRole.OWNER]);
    const other = await system.workspace.create({ data: { name: "Other", slug: "other-team" } });
    actAs(members[0] ?? null);
    // Extra form fields (e.g. a workspace id) are simply not read.
    expect(
      await submitBrand("acme-team", "en", null, form({ ...BRAND, workspaceId: other.id })),
    ).toMatchObject({ done: true });
    expect(await system.brand.count({ where: { workspaceId: other.id } })).toBe(0);
    expect(await system.brand.count({ where: { workspaceId: ws.id } })).toBe(1);
    // Calling the action directly with an injected key is a validation error.
    const direct = await saveBrandAction({ slug: "acme-team", ...BRAND, workspaceId: other.id });
    expect(direct).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED", fields: [{ code: "unrecognized_keys" }] },
    });
    const status = await createContentAction({
      slug: "acme-team",
      ...CONTENT,
      status: "PUBLISHED",
    });
    expect(status).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("create content, run the workflow and delete it, redirecting within the locale", async () => {
    const { members } = await team("acme-team", [WorkspaceRole.MANAGER, WorkspaceRole.EDITOR]);
    const [manager, editor] = members as [Session, Session];
    actAs(editor);
    const target = await redirectTarget(
      submitContent(
        "acme-team",
        "ar",
        null,
        null,
        form({ ...CONTENT, plannedAt: "2099-03-01T09:00" }),
      ),
    );
    expect(target).toMatch(/^\/ar\/w\/acme-team\/content\/[0-9a-f-]{36}$/);
    const contentId = target.split("/").pop() ?? "";

    // An editor may submit but not approve.
    expect(
      await submitContentTransition("acme-team", "ar", contentId, "submit", null, form({})),
    ).toMatchObject({ done: true });
    expect(
      await submitContentTransition("acme-team", "ar", contentId, "approve", null, form({})),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    // An unknown transition name is a validation error, not a status write.
    expect(
      await submitContentTransition("acme-team", "ar", contentId, "PUBLISHED", null, form({})),
    ).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    actAs(manager);
    await submitContentTransition("acme-team", "ar", contentId, "approve", null, form({}));
    expect(
      await submitContentTransition(
        "acme-team",
        "ar",
        contentId,
        "schedule",
        null,
        form({ scheduledAt: "2000-01-01T00:00" }),
      ),
    ).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fields: [{ path: "scheduledAt", code: "schedule_in_past" }],
      },
    });
    await submitContentTransition(
      "acme-team",
      "ar",
      contentId,
      "schedule",
      null,
      form({ scheduledAt: "2099-03-02T10:00" }),
    );
    expect(
      await submitReschedule(
        "acme-team",
        "ar",
        contentId,
        null,
        form({ scheduledAt: "2099-03-03T10:00" }),
      ),
    ).toMatchObject({ done: true });
    const detail = await getContentPage("acme-team", contentId);
    expect(detail.content.status).toBe("SCHEDULED");
    expect(detail.content.scheduledAt?.toISOString()).toBe("2099-03-03T07:00:00.000Z");
    expect(detail.timeZone).toBe("Asia/Riyadh");
    expect(detail.content.transitions).toEqual(["unschedule", "publish"]);

    // The editor sees the item but no workflow step for its status and cannot delete it.
    actAs(editor);
    const asEditor = await getContentPage("acme-team", contentId);
    expect(asEditor.content.transitions).toEqual([]);
    expect(asEditor.content.canDelete).toBe(false);
    expect(await submitDeleteContent("acme-team", "ar", contentId, null)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    actAs(manager);
    expect(await redirectTarget(submitDeleteContent("acme-team", "ar", contentId, null))).toBe(
      "/ar/w/acme-team/content",
    );
  });

  it("create pillars and campaigns from forms with linked records and lifecycle changes", async () => {
    const { members } = await team("acme-team", [WorkspaceRole.OWNER]);
    actAs(members[0] ?? null);
    const pillarForm = (name: string) =>
      form({ name, description: "", objective: "", audienceId: "" });
    expect(await redirectTarget(submitPillar("acme-team", "en", null, null, pillarForm("A")))).toBe(
      "/en/w/acme-team/brand/pillars",
    );
    await controlFlow(submitPillar("acme-team", "en", null, null, pillarForm("B")));
    const pillars = await system.contentPillar.findMany({ orderBy: { position: "asc" } });
    const second = pillars[1]?.id ?? "";
    expect(await submitMovePillar("acme-team", "en", second, "up", null)).toMatchObject({
      done: true,
    });
    expect(await submitMovePillar("acme-team", "en", second, "sideways", null)).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const target = await redirectTarget(
      submitCampaign(
        "acme-team",
        "en",
        null,
        null,
        form({
          name: "Launch",
          description: "",
          objective: "",
          startDate: "2030-01-01",
          endDate: "2030-01-31",
          audienceId: "",
          budgetAmount: "250",
          budgetCurrency: "usd",
          pillarIds: pillars.map((pillar) => pillar.id),
        }),
      ),
    );
    const campaignId = target.split("/").pop() ?? "";
    const campaign = await system.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: { pillars: true },
    });
    expect(campaign.budgetAmountMinor).toBe(25000n);
    expect(campaign.pillars).toHaveLength(2);
    expect(
      await submitCampaignStatus("acme-team", "en", campaignId, "COMPLETED", null),
    ).toMatchObject({
      error: { code: "CONFLICT", fields: [{ code: "invalid_transition" }] },
    });
    expect(await submitCampaignStatus("acme-team", "en", campaignId, "ACTIVE", null)).toMatchObject(
      {
        done: true,
      },
    );
  });
});

// ── media through the action and the route ───────────────────────────────────

describe("media upload and the access-checked media route", () => {
  it("serves an uploaded image to members only, with safe headers", async () => {
    const { members } = await team("acme-team", [WorkspaceRole.EDITOR, WorkspaceRole.VIEWER]);
    const [editor, viewer] = members as [Session, Session];
    const outsiderTeam = await team("other-team", [WorkspaceRole.OWNER]);
    const outsider = outsiderTeam.members[0] ?? null;

    actAs(editor);
    const file = new File([Buffer.from(png())], "../cup.png", { type: "image/png" });
    expect(
      await submitUpload("acme-team", "en", null, form({ file, altText: "Cup" })),
    ).toMatchObject({
      done: true,
    });
    const asset = await system.mediaAsset.findFirstOrThrow();
    expect(asset).toMatchObject({ filename: "cup.png", width: 4, height: 3, altText: "Cup" });

    // A browser-declared image type does not make text an image.
    const fake = new File(["<svg onload=alert(1)>"], "x.png", { type: "image/png" });
    expect(
      await submitUpload("acme-team", "en", null, form({ file: fake, altText: "" })),
    ).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE", fields: [{ code: "image_invalid" }] },
    });
    expect(await submitUpload("acme-team", "en", null, form({ altText: "" }))).toMatchObject({
      error: { code: "VALIDATION_FAILED", fields: [{ path: "file", code: "file_required" }] },
    });

    // Members with content.view get the bytes.
    actAs(viewer);
    const response = await mediaRequest("acme-team", asset.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png());
    // Viewers cannot change or delete media.
    expect(
      await submitMediaAltText("acme-team", "en", asset.id, null, form({ altText: "x" })),
    ).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(await submitDeleteMedia("acme-team", "en", asset.id, null)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    // Outsiders: through their own workspace or the owner's slug, the same 404.
    actAs(outsider);
    expect((await mediaRequest("other-team", asset.id)).status).toBe(404);
    expect((await mediaRequest("acme-team", asset.id)).status).toBe(404);
    // Anonymous: 401. Malformed ids: 400.
    actAs(null);
    expect((await mediaRequest("acme-team", asset.id)).status).toBe(401);
    actAs(viewer);
    expect((await mediaRequest("acme-team", "not-a-uuid")).status).toBe(400);

    actAs(editor);
    expect(await submitDeleteMedia("acme-team", "en", asset.id, null)).toMatchObject({
      done: true,
    });
    actAs(viewer);
    expect((await mediaRequest("acme-team", asset.id)).status).toBe(404);
  });
});

// ── page queries ─────────────────────────────────────────────────────────────

describe("page queries", () => {
  it("decide sections and abilities by role, and hide other workspaces' records", async () => {
    const { members } = await team("acme-team", [
      WorkspaceRole.OWNER,
      WorkspaceRole.EDITOR,
      WorkspaceRole.CLIENT,
    ]);
    const [owner, editor, client] = members as [Session, Session, Session];
    actAs(owner);
    const created = await createContentAction({ slug: "acme-team", ...CONTENT });
    if (!created.ok) throw new Error("content not created");
    const { contentId } = created.data;
    await transitionContentAction({
      slug: "acme-team",
      contentId,
      transition: "submit",
      scheduledAt: "",
    });

    expect((await getDashboardPage("acme-team")).activity).not.toBeNull();
    expect((await getActivityPage("acme-team", undefined)).entries.length).toBeGreaterThan(0);
    expect((await getContentListPage("acme-team", { page: 1 })).total).toBe(1);
    expect(
      (await getCalendarPage("acme-team", { view: "week" })).calendar.period.days,
    ).toHaveLength(7);

    actAs(editor);
    await expect(getActivityPage("acme-team", undefined)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await getNewContentPage("acme-team")).timeZone).toBe("Asia/Riyadh");

    actAs(client);
    await expect(getNewContentPage("acme-team")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const asClient = await getContentPage("acme-team", contentId);
    expect(asClient.content.transitions).toEqual(["approve", "request_changes"]);
    expect(asClient.options).toBeNull();
    expect((await getDashboardPage("acme-team")).activity).toBeNull();
    expect((await getWorkspaceShell("acme-team")).nav).toEqual({
      content: true,
      calendar: true,
      campaigns: true,
      brand: true,
      media: true,
      activity: false,
      members: false,
    });

    // Another workspace's member: the record does not exist for them; malformed ids neither.
    const { members: outsiders } = await team("other-team", [WorkspaceRole.OWNER]);
    actAs(outsiders[0] ?? null);
    await expect(getContentPage("other-team", contentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getContentPage("acme-team", contentId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getContentPage("other-team", "../../etc")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

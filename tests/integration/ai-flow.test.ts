// Phase 4 — AI Marketing Engine through the real entry points: form server actions, the
// server actions with the real Better Auth limiter checkpoint, page queries, and real
// sessions on the real database. The AI provider setting is switched per test.
import type * as NextNavigation from "next/navigation";

import type * as Env from "@/server/env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignUp } from "@/app/[locale]/(auth)/actions";
import {
  submitApply,
  submitAssist,
  submitGenerate,
} from "@/app/[locale]/w/[workspaceSlug]/ai/ai-actions";
import { WorkspaceRole } from "@/generated/prisma/enums";
import {
  applyGenerationAction,
  assistContentAction,
  generateIdeasAction,
} from "@/server/ai/ai-actions";
import { getAiStudioPage, getAiUsagePage, getContentAssist } from "@/server/ai/ai-queries";
import { getSystemDb } from "@/server/db/client";
import { AppError } from "@/server/errors/app-error";
import { createContentAction, transitionContentAction } from "@/server/marketing/marketing-actions";

import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["ai", "flow", "test", "only", "secret", "0123456789abcdef"].join("-");
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
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// The AI provider setting, switched per test (the real getAiEnv caches process.env).
const ai = vi.hoisted((): { provider: "fake" | "disabled" } => ({ provider: "fake" }));
vi.mock("@/server/env", async (importOriginal) => ({
  ...(await importOriginal<typeof Env>()),
  getAiEnv: () => ({ AI_PROVIDER: ai.provider, AI_TIMEOUT_MS: 5000 }),
}));

const { system } = createTestDb();
const PASSWORD = "correct horse battery";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
  ai.provider = "fake";
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
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
  const email = `ai-${String(counter)}-${Date.now().toString(36)}@example.com`;
  browser.jar.clear();
  await controlFlow(submitSignUp("en", null, form({ name, email, password: PASSWORD })));
  await controlFlow(submitSignIn("en", null, form({ email, password: PASSWORD })));
  const user = await system.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, email, cookies: new Map(browser.jar) };
}
type Session = Awaited<ReturnType<typeof signedInUser>>;
const actAs = (user: Session) => {
  browser.jar.clear();
  for (const [name, value] of user.cookies) browser.jar.set(name, value);
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

/** The team member at `index`; fails the test if the team is smaller than expected. */
function nth(members: readonly Session[], index: number): Session {
  const member = members[index];
  if (member === undefined) throw new Error(`team has no member ${String(index)}`);
  return member;
}

const ideas = (slug: string) => generateIdeasAction({ slug, uiLocale: "en", topic: "Winter" });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw error;
  return error;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("AI actions", () => {
  it("fails clearly when AI is not configured, before any limit or record", async () => {
    ai.provider = "disabled";
    const { members } = await team("ai-off", [WorkspaceRole.OWNER]);
    actAs(nth(members, 0));
    const result = await ideas("ai-off");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", fields: [{ path: "ai", code: "ai_not_configured" }] },
    });
    expect(await system.aiGeneration.count()).toBe(0);
    expect(await system.rateLimit.count({ where: { key: { contains: "ai-generate" } } })).toBe(0);

    const state = await submitGenerate("ai-off", "en", "ideas", null, form({ topic: "x" }));
    expect(state).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" }, values: { topic: "x" } });
    expect((await getAiStudioPage("ai-off", undefined)).configured).toBe(false);
  });

  it("limits each person to 20 generations per 10 minutes", async () => {
    const { members } = await team("ai-limit", [WorkspaceRole.EDITOR, WorkspaceRole.EDITOR]);
    actAs(nth(members, 0));
    for (let index = 0; index < 20; index += 1) {
      expect((await ideas("ai-limit")).ok).toBe(true);
    }
    expect(await ideas("ai-limit")).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await system.aiGeneration.count()).toBe(20);
    // Another member of the same workspace has their own allowance.
    actAs(nth(members, 1));
    expect((await ideas("ai-limit")).ok).toBe(true);
  });

  it("limits a workspace to 100 generations per hour across its members", async () => {
    const roles = Array.from({ length: 6 }, () => WorkspaceRole.EDITOR);
    const { members } = await team("ai-ws", roles);
    for (const member of members.slice(0, 5)) {
      actAs(member);
      for (let index = 0; index < 20; index += 1) {
        expect((await ideas("ai-ws")).ok).toBe(true);
      }
    }
    actAs(nth(members, 5));
    expect(await ideas("ai-ws")).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(await system.aiGeneration.count()).toBe(100);
    // Another workspace is unaffected.
    const { members: others } = await team("ai-ws-2", [WorkspaceRole.OWNER]);
    actAs(nth(others, 0));
    expect((await ideas("ai-ws-2")).ok).toBe(true);
  }, 120_000);

  it("refuses roles without content.create and non-members", async () => {
    const { members } = await team("ai-roles", [
      WorkspaceRole.VIEWER,
      WorkspaceRole.CLIENT,
      WorkspaceRole.OWNER,
    ]);
    for (const member of members.slice(0, 2)) {
      actAs(member);
      expect(await ideas("ai-roles")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      await expect(getAiStudioPage("ai-roles", undefined)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    const outsider = await signedInUser("Outsider");
    actAs(outsider);
    expect(await ideas("ai-roles")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await system.aiGeneration.count()).toBe(0);
  });

  it("generates, shows and uses a suggestion through the forms", async () => {
    const { members } = await team("ai-forms", [WorkspaceRole.OWNER, WorkspaceRole.EDITOR]);
    const [owner, editor] = members as [Session, Session];
    actAs(owner);
    const target = await redirectTarget(
      submitGenerate(
        "ai-forms",
        "en",
        "copy",
        null,
        form({ topic: "Friday offer", variants: "1" }),
      ),
    );
    expect(target).toMatch(/^\/en\/w\/ai-forms\/ai\?tool=copy&g=[0-9a-f-]{36}$/);
    const generationId = new URL(target, "http://x").searchParams.get("g") ?? "";
    const page = await getAiStudioPage("ai-forms", generationId);
    expect(page.selected?.choices).toBe(2);
    expect(page.history).toHaveLength(1);

    // Another member cannot see or use it.
    actAs(editor);
    await expect(getAiStudioPage("ai-forms", generationId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await applyGenerationAction({ slug: "ai-forms", generationId, choice: 0 }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    actAs(owner);
    const contentUrl = await redirectTarget(
      submitApply("ai-forms", "en", generationId, 1, null, form({})),
    );
    expect(contentUrl).toMatch(/^\/en\/w\/ai-forms\/content\/[0-9a-f-]{36}$/);
    const second = await submitApply("ai-forms", "en", generationId, 0, null, form({}));
    expect(second).toMatchObject({
      error: { code: "CONFLICT", fields: [{ code: "ai_already_used" }] },
    });
    const content = await system.contentItem.findFirstOrThrow({
      where: { workspace: { slug: "ai-forms" } },
    });
    expect(content.status).toBe("DRAFT");
    expect(content.body).toContain("(1)");

    // The browser cannot submit text or ids of its own choosing.
    expect(
      await applyGenerationAction({
        slug: "ai-forms",
        generationId,
        choice: 0,
        output: { caption: "<script>" },
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("assists drafts through the panel and hides it afterwards", async () => {
    const { members } = await team("ai-assist", [WorkspaceRole.OWNER]);
    actAs(nth(members, 0));
    const created = await createContentAction({ slug: "ai-assist", title: "Teaser", type: "POST" });
    if (!created.ok) throw new Error("content not created");
    const contentId = created.data.contentId;

    const target = await redirectTarget(
      submitAssist("ai-assist", "en", contentId, null, form({ operation: "CONTENT_HOOK" })),
    );
    expect(target).toMatch(new RegExp(`/content/${contentId}\\?ai=[0-9a-f-]{36}#ai-assist$`));
    const generationId = /ai=([0-9a-f-]{36})/.exec(target)?.[1] ?? "";
    const panel = await getContentAssist("ai-assist", contentId, generationId);
    expect(panel?.selected?.operation).toBe("CONTENT_HOOK");
    // A generation id cannot be shown on another draft's panel.
    const other = await createContentAction({ slug: "ai-assist", title: "Other", type: "POST" });
    if (!other.ok) throw new Error("content not created");
    expect(
      (await getContentAssist("ai-assist", other.data.contentId, generationId))?.selected,
    ).toBeNull();

    await transitionContentAction({ slug: "ai-assist", contentId, transition: "submit" });
    expect(await getContentAssist("ai-assist", contentId, generationId)).toBeNull();
    expect(
      await assistContentAction({
        slug: "ai-assist",
        uiLocale: "en",
        contentId,
        operation: "CONTENT_CTA",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", fields: [{ code: "ai_draft_only" }] },
    });
  });

  it("shows usage to owners and admins only", async () => {
    const { members } = await team("ai-usage", [
      WorkspaceRole.OWNER,
      WorkspaceRole.ADMIN,
      WorkspaceRole.MANAGER,
      WorkspaceRole.EDITOR,
    ]);
    actAs(nth(members, 0));
    expect((await ideas("ai-usage")).ok).toBe(true);
    expect((await getAiUsagePage("ai-usage")).usage.attempts).toBe(1);
    actAs(nth(members, 1));
    expect((await getAiUsagePage("ai-usage")).usage.attempts).toBe(1);
    for (const member of members.slice(2)) {
      actAs(member);
      const error = await rejection(getAiUsagePage("ai-usage"));
      expect(error.code).toBe("FORBIDDEN");
    }
  });
});

// Video generation through the real entry points: form server actions, the page query,
// the rendered status view (Arabic and English) and real sessions on the real database.
// The provider setting is switched per test; `after()` is captured so a test decides
// when the post-response run happens. Only the deterministic fake provider exists.
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import type * as NextServer from "next/server";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type * as Env from "@/server/env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignUp } from "@/app/[locale]/(auth)/actions";
import {
  submitVideoRefresh,
  submitVideoRegenerate,
  submitVideoRequest,
  submitVideoReview,
} from "@/app/[locale]/w/[workspaceSlug]/ai/videos/generate/actions";
import {
  Gallery,
  JobStatus,
  WorkflowRail,
} from "@/app/[locale]/w/[workspaceSlug]/ai/videos/generate/job-status";
import { WorkspaceRole } from "@/generated/prisma/enums";
import { FakeVideoProvider } from "@/server/ai/providers/video/fake";
import { getDb, getSystemDb } from "@/server/db/client";
import { createTenantContext } from "@/server/tenancy/context";
import { validateClip } from "@/server/videos/generation/mp4";
import { requestVideoAction } from "@/server/videos/generation/video-generation-actions";
import {
  getVideoGeneratePage,
  type VideoGeneratePage,
} from "@/server/videos/generation/video-generation-queries";
import { PLATFORM_ASPECT } from "@/server/videos/generation/video-brief";
import {
  requestVideoGeneration,
  runVideoJob,
} from "@/server/videos/generation/video-generation-service";
import { getVideoFile } from "@/server/videos/video-queries";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTestDb, resetDatabase } from "./helpers";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["video", "flow", "test", "only", "secret", "0123456789abcdef"].join(
    "-",
  );
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
  return { jar, nextHeaders };
});
vi.mock("next/headers", () => browser.nextHeaders());
vi.mock("next/headers.js", () => browser.nextHeaders());
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/",
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// Work scheduled with after() runs only when a test says so (the response has been sent).
const scheduled = vi.hoisted(() => ({ callbacks: [] as (() => Promise<void> | void)[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof NextServer>()),
  after: (callback: () => Promise<void> | void) => {
    scheduled.callbacks.push(callback);
  },
}));
async function runScheduled() {
  const callbacks = scheduled.callbacks.splice(0);
  for (const callback of callbacks) await callback();
  return callbacks.length;
}

// The provider setting, switched per test (the real getVideoEnv caches process.env).
const video = vi.hoisted((): { provider: "disabled" | "fake" } => ({ provider: "disabled" }));
vi.mock("@/server/env", async (importOriginal) => ({
  ...(await importOriginal<typeof Env>()),
  getVideoEnv: () => ({ NODE_ENV: "test", VIDEO_PROVIDER: video.provider }),
}));

const { system } = createTestDb();
const PASSWORD = "correct horse battery";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
  scheduled.callbacks.length = 0;
  video.provider = "fake";
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const VALID = {
  title: "Spring launch",
  objective: "Launch the spring menu",
  audience: "Coffee lovers in Riyadh",
  description: "A slow pan over a coffee cup on a sunny table",
  platform: "youtube",
  style: "cinematic",
  language: "en",
  durationSeconds: "8",
  aspectRatio: "16:9",
  resolution: "720p",
  tier: "DRAFT",
} as const;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function controlFlow(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    (value) => {
      throw new Error(`expected a redirect, got ${JSON.stringify(value)}`);
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
  const email = `video-${String(counter)}-${Date.now().toString(36)}@example.com`;
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

async function member(slug: string, role: WorkspaceRole) {
  const ws =
    (await system.workspace.findUnique({ where: { slug } })) ??
    (await system.workspace.create({ data: { name: slug.toUpperCase(), slug } }));
  const user = await signedInUser(role);
  await system.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role } });
  return { ws, user };
}

const request = (slug: string, fields: Record<string, string> = VALID, locale = "en") =>
  submitVideoRequest(slug, locale, null, form(fields));

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

function statusHtml(locale: "ar" | "en", slug: string, page: VideoGeneratePage) {
  return render(
    locale,
    createElement(JobStatus, {
      slug,
      locale,
      timeZone: page.timeZone,
      configured: page.configured,
      job: page.selected,
      result: page.result,
    }),
  );
}

const jobIdOf = (target: string) =>
  new URL(target, "http://localhost").searchParams.get("job") ?? "";

// ── tests ────────────────────────────────────────────────────────────────────

describe("provider disabled", () => {
  it("shows the page read-only and refuses every request without storing anything", async () => {
    video.provider = "disabled";
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const page = await getVideoGeneratePage("acme-team", undefined);
    expect(page).toMatchObject({ configured: false, jobs: [], selected: null });
    expect(page.options.durations).toEqual([]);
    const state = await request("acme-team");
    expect(state).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE", fields: [{ code: "video_not_configured" }] },
      values: { title: VALID.title },
    });
    expect(await system.videoGenerationJob.count()).toBe(0);
    expect(scheduled.callbacks).toHaveLength(0);
  });
});

describe("authorization", () => {
  it("refuses signed-out visitors, roles without content.create and other workspaces", async () => {
    const { user: editor } = await member("acme-team", WorkspaceRole.EDITOR);
    const { user: client } = await member("acme-team", WorkspaceRole.CLIENT);
    const { user: viewer } = await member("acme-team", WorkspaceRole.VIEWER);
    const { user: outsider } = await member("other-team", WorkspaceRole.OWNER);

    actAs(null);
    expect(await request("acme-team")).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    for (const user of [client, viewer]) {
      actAs(user);
      expect(await request("acme-team")).toMatchObject({ error: { code: "FORBIDDEN" } });
      await expect(getVideoGeneratePage("acme-team", undefined)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    // A workspace the user does not belong to looks like one that does not exist.
    actAs(outsider);
    expect(await request("acme-team")).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await system.videoGenerationJob.count()).toBe(0);

    // The editor's job is invisible and untouchable from another workspace.
    actAs(editor);
    const jobId = jobIdOf(await redirectTarget(request("acme-team")));
    actAs(outsider);
    await expect(getVideoGeneratePage("other-team", jobId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await submitVideoRefresh("other-team", "en", jobId, null, form({}))).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      await submitVideoReview("other-team", "en", jobId, "accept", null, form({})),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(
      (await system.videoGenerationJob.findUniqueOrThrow({ where: { id: jobId } })).state,
    ).toBe("RESERVED");
  });
});

describe("validation", () => {
  it("returns field errors with the submitted values and stores nothing", async () => {
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const fieldCodes = async (fields: Record<string, string>) => {
      const state = await request("acme-team", fields);
      if (state === null || !("error" in state)) throw new Error("expected an error state");
      return state.error.fields?.map((field) => `${field.path}:${field.code}`);
    };
    // Every problem is reported at once: settings and brief together.
    expect(
      await fieldCodes({
        ...VALID,
        title: " ",
        objective: "",
        description: "",
        durationSeconds: "",
      }),
    ).toEqual([
      "title:too_small",
      "durationSeconds:required",
      "objective:too_small",
      "description:too_small",
    ]);
    expect(await fieldCodes({ ...VALID, durationSeconds: "5" })).toEqual([
      "durationSeconds:video_unsupported",
    ]);
    expect(await fieldCodes({ ...VALID, durationSeconds: "eight" })).toEqual([
      "durationSeconds:invalid_type",
    ]);
    expect(await fieldCodes({ ...VALID, platform: "myspace", style: "", language: "fr" })).toEqual([
      "platform:invalid_value",
      "style:invalid_value",
      "language:invalid_value",
    ]);
    expect(await fieldCodes({ ...VALID, audience: "x".repeat(251) })).toEqual(["audience:too_big"]);
    expect(await fieldCodes({ ...VALID, tier: "PREMIUM" })).toEqual(["tier:invalid_value"]);
    expect(await fieldCodes({ ...VALID, aspectRatio: "4:3" })).toEqual([
      "aspectRatio:invalid_value",
    ]);
    expect(await fieldCodes({ ...VALID, description: "x".repeat(1001) })).toEqual([
      "description:too_big",
    ]);
    expect(await system.videoGenerationJob.count()).toBe(0);
  });

  it("never accepts a workspace, budget, limit or provider from the client", async () => {
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    const { ws: other } = await member("other-team", WorkspaceRole.OWNER);
    actAs(user);
    for (const injected of [
      { workspaceId: other.id },
      { reservedMicros: "1" },
      { maxAttempts: 99 },
      { provider: "veo" },
      { role: "OWNER" },
    ]) {
      const result = await requestVideoAction({
        slug: "acme-team",
        ...VALID,
        audio: false,
        ...injected,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED", fields: [{ code: "unrecognized_keys" }] },
      });
    }
    // The form action forwards only its own fields: extra form data is ignored.
    const target = await redirectTarget(
      request("acme-team", { ...VALID, workspaceId: other.id, reservedMicros: "1" }),
    );
    const job = await system.videoGenerationJob.findUniqueOrThrow({
      where: { id: jobIdOf(target) },
    });
    expect(job.workspaceId).not.toBe(other.id);
    expect(job.reservedMicros).toBeGreaterThan(1n);
    expect(job.maxAttempts).toBe(2);
  });
});

describe("request, status and review", () => {
  it("submits, shows the queued job, completes after the response and is reviewed once", async () => {
    const { ws, user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const target = await redirectTarget(request("acme-team", { ...VALID, audio: "on" }));
    expect(target).toMatch(/^\/en\/w\/acme-team\/ai\/videos\/generate\?job=[0-9a-f-]{36}$/);
    const jobId = jobIdOf(target);

    // Before the post-response run: queued, with a "check status" button.
    let page = await getVideoGeneratePage("acme-team", jobId);
    expect(page.selected).toMatchObject({ id: jobId, state: "RESERVED", audio: true });
    expect(page.jobs.map((job) => job.id)).toEqual([jobId]);
    expect(page.result).toBeNull();
    const queued = statusHtml("en", "acme-team", page);
    expect(queued).toContain('data-state="RESERVED"');
    expect(queued).toContain("Queued");
    expect(queued).toContain('data-testid="video-job-refresh"');
    expect(queued).not.toContain("video-job-download");
    expect(statusHtml("ar", "acme-team", page)).toContain("في الانتظار");

    // The run scheduled with after(): generated, validated, stored, recorded.
    expect(await runScheduled()).toBe(1);
    page = await getVideoGeneratePage("acme-team", jobId);
    expect(page.selected).toMatchObject({ state: "READY_FOR_REVIEW", failureCode: null });
    expect(page.result).toMatchObject({ downloadable: true });
    const ready = statusHtml("en", "acme-team", page);
    expect(ready).toContain("Ready for review");
    expect(ready).toContain('data-testid="video-job-accept"');
    expect(ready).toContain('data-testid="video-job-reject"');
    expect(ready).toContain(`href="/api/w/acme-team/videos/${page.result?.videoId ?? ""}"`);
    expect(ready).not.toContain("video-job-refresh");
    // No money on the page: the budget policy is undecided.
    expect(ready).not.toMatch(/\$\s?\d|USD|SAR|micros|0\.40|2\.40/);
    expect(statusHtml("ar", "acme-team", page)).toContain("جاهز للمراجعة");

    // The download route serves the stored, validated clip.
    const file = await getVideoFile("acme-team", page.result?.videoId ?? "", "VIDEO");
    expect(
      validateClip(file.body, {
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        audio: true,
      }),
    ).toBeNull();

    // Review: accepted once; a second decision is refused.
    expect(
      await redirectTarget(submitVideoReview("acme-team", "en", jobId, "accept", null, form({}))),
    ).toBe(`/en/w/acme-team/ai/videos/generate?job=${jobId}`);
    expect(
      await submitVideoReview("acme-team", "en", jobId, "reject", null, form({})),
    ).toMatchObject({ error: { code: "CONFLICT" } });
    page = await getVideoGeneratePage("acme-team", jobId);
    expect(page.selected?.state).toBe("ACCEPTED");
    expect(statusHtml("en", "acme-team", page)).not.toContain("video-job-accept");

    const audit = await system.auditLog.findMany({
      where: { workspaceId: ws.id, action: { startsWith: "video." } },
      select: { action: true, actorUserId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((entry) => entry.action)).toEqual([
      "video.job_requested",
      "video.generated",
      "video.job_finished",
      "video.job_reviewed",
    ]);
    expect(audit[0]?.actorUserId).toBe(user.id);
  });

  it("'Check status' resumes a job whose post-response run never happened", async () => {
    const { user } = await member("acme-team", WorkspaceRole.OWNER);
    actAs(user);
    const jobId = jobIdOf(await redirectTarget(request("acme-team")));
    scheduled.callbacks.length = 0; // the process "restarted" before the run
    expect(await redirectTarget(submitVideoRefresh("acme-team", "ar", jobId, null, form({})))).toBe(
      `/ar/w/acme-team/ai/videos/generate?job=${jobId}`,
    );
    expect((await getVideoGeneratePage("acme-team", jobId)).selected?.state).toBe(
      "READY_FOR_REVIEW",
    );
    // A finished job is not run again; reviewing still needs content.create.
    await redirectTarget(submitVideoRefresh("acme-team", "en", jobId, null, form({})));
    const { user: client } = await member("acme-team", WorkspaceRole.CLIENT);
    actAs(client);
    expect(
      await submitVideoReview("acme-team", "en", jobId, "accept", null, form({})),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("refuses a request over the daily budget with a field error", async () => {
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    // STANDARD 8 s reserves 2.40 (placeholder card); the provisional daily limit is 20.
    const standard = { ...VALID, tier: "STANDARD" };
    for (let index = 0; index < 8; index += 1) await redirectTarget(request("acme-team", standard));
    expect(await request("acme-team", standard)).toMatchObject({
      error: { code: "RATE_LIMITED", fields: [{ code: "video_daily_budget" }] },
    });
    expect(await system.videoGenerationJob.count()).toBe(8);
  });
});

describe("failure display", () => {
  it("shows a provider refusal, a stop and a lost answer without retry buttons", async () => {
    const { ws, user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const ctx = createTenantContext({ userId: user.id, workspaceId: ws.id, role: "EDITOR" });
    const failing = async (scenarios: ConstructorParameters<typeof FakeVideoProvider>[0]) => {
      const provider = new FakeVideoProvider(scenarios);
      const deps = {
        db: getDb(),
        provider,
        writeTarget: () => Promise.reject(new Error("not reached")),
        sleep: () => Promise.resolve(),
      };
      const { jobId } = await requestVideoGeneration(deps, ctx, {
        title: VALID.title,
        prompt: VALID.description,
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        tier: "DRAFT",
        audio: false,
      });
      await runVideoJob(deps, ws.id, jobId);
      return getVideoGeneratePage("acme-team", jobId);
    };

    const refused = await failing({ scenarios: ["refused"], pollsBeforeDone: 0 });
    expect(refused.selected).toMatchObject({ state: "FAILED", failureCode: "refused" });
    const refusedHtml = statusHtml("en", "acme-team", refused);
    expect(refusedHtml).toContain('role="alert"');
    expect(refusedHtml).toContain("The provider declined this content.");
    expect(refusedHtml).not.toContain("video-job-refresh");
    expect(refusedHtml).not.toContain("video-job-accept");
    expect(statusHtml("ar", "acme-team", refused)).toContain("رفض المزوّد هذا المحتوى");

    const stopped = await failing({
      scenarios: ["invalid_output", "corrupt_output"],
      pollsBeforeDone: 0,
    });
    expect(stopped.selected).toMatchObject({ state: "LIMIT_REACHED", failureCode: "max_attempts" });
    expect(statusHtml("en", "acme-team", stopped)).toContain(
      "Every attempt produced an unusable video.",
    );

    const lost = await failing({ scenarios: ["submit_timeout_lost"], pollsBeforeDone: 0 });
    // The lost submission is reconciled ("never received") and retried; the clip is then
    // ready but storage is unavailable here, so the job keeps waiting (no failure shown).
    expect(lost.selected?.state).toBe("IN_PROGRESS");
    expect(statusHtml("en", "acme-team", lost)).toContain("video-job-progress");
  });

  it("explains a request waiting for an operator and an expired result", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000001",
      title: "Launch",
      provider: "fake",
      prompt: "Scene: a cup",
      placeholder: true,
      tier: "DRAFT",
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "1080p",
      audio: false,
      attemptCount: 1,
      maxAttempts: 2,
      reservedMicros: 1n,
      capturedMicros: 0n,
      releasedMicros: 0n,
      generatedVideoId: null,
      createdAt: new Date("2026-10-09T09:00:00Z"),
      finishedAt: null,
    } as const;
    const page = (
      job: Partial<NonNullable<VideoGeneratePage["selected"]>>,
      result: VideoGeneratePage["result"] = null,
    ) =>
      statusHtml("en", "acme-team", {
        configured: true,
        jobs: [],
        selected: { ...base, attempts: [], state: "IN_PROGRESS", failureCode: null, ...job },
        result,
        options: {
          durations: [],
          aspectRatios: [],
          resolutions: [],
          tiers: [],
          platforms: [],
          styles: [],
          languages: [],
          platformAspect: PLATFORM_ASPECT,
        },
        timeZone: "Asia/Riyadh",
        now: new Date(),
      });

    const reconciling = page({ state: "NEEDS_RECONCILIATION", failureCode: "outcome_unknown" });
    expect(reconciling).toContain("an operator must check this request");
    expect(reconciling).not.toContain('role="alert"');
    expect(reconciling).not.toContain("video-job-refresh");
    expect(reconciling).toContain("Portrait 9:16");

    const expired = page(
      { state: "ACCEPTED" },
      {
        videoId: "00000000-0000-4000-8000-000000000002",
        expiresAt: new Date("2026-10-01T00:00:00Z"),
        downloadable: false,
      },
    );
    expect(expired).toContain("video-job-expired");
    expect(expired).not.toContain("video-job-download");

    expect(page({ state: "FAILED", failureCode: "something_new" })).toContain(
      "The request could not be completed.",
    );
  });
});

describe("video studio", () => {
  it("compiles the brief into the stored prompt and shows it back", async () => {
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const jobId = jobIdOf(
      await redirectTarget(request("acme-team", { ...VALID, platform: "tiktok", language: "ar" })),
    );
    const job = await system.videoGenerationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.prompt).toBe(
      [
        "Scene: A slow pan over a coffee cup on a sunny table",
        "Marketing objective: Launch the spring menu",
        "Audience: Coffee lovers in Riyadh",
        "Platform: TikTok",
        "Visual style: cinematic",
        "Language for any on-screen text or speech: Arabic",
      ].join("\n"),
    );
    // The optional audience is left out when empty.
    const second = jobIdOf(await redirectTarget(request("acme-team", { ...VALID, audience: " " })));
    expect(
      (await system.videoGenerationJob.findUniqueOrThrow({ where: { id: second } })).prompt,
    ).not.toContain("Audience:");
    const html = statusHtml("en", "acme-team", await getVideoGeneratePage("acme-team", jobId));
    expect(html).toContain('data-testid="video-job-brief"');
    expect(html).toContain("Marketing objective: Launch the spring menu");
  });

  it("labels test-provider output as a placeholder and never shows a progress estimate", async () => {
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const jobId = jobIdOf(await redirectTarget(request("acme-team")));
    const queued = statusHtml("en", "acme-team", await getVideoGeneratePage("acme-team", jobId));
    expect(queued).not.toMatch(/\d+\s?%|\bETA\b|time remaining|minutes left/);
    expect(queued).toContain("No progress estimate is available");
    await runScheduled();
    const page = await getVideoGeneratePage("acme-team", jobId);
    expect(page.selected?.placeholder).toBe(true);
    const ready = statusHtml("en", "acme-team", page);
    expect(ready).toContain('data-testid="video-placeholder"');
    expect(ready).toContain("It is not an AI-generated video");
    expect(ready).toContain('data-testid="video-job-placeholder"');
    expect(ready).not.toContain("video-player");
    expect(statusHtml("ar", "acme-team", page)).toContain("مقطع اختبار تجريبي");
    // A real provider's clip is played from the retention-aware route instead.
    const real = statusHtml("en", "acme-team", {
      ...page,
      selected: page.selected === null ? null : { ...page.selected, placeholder: false },
    });
    expect(real).toContain('data-testid="video-player"');
    expect(real).toContain(`src="/api/w/acme-team/videos/${page.result?.videoId ?? ""}"`);
    expect(real).not.toContain("video-placeholder");
  });

  it("generates again as a new job with its own reservation, only when allowed", async () => {
    const { ws, user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const first = jobIdOf(await redirectTarget(request("acme-team")));
    // Not while the original is still running.
    expect(await submitVideoRegenerate("acme-team", "en", first, null, form({}))).toMatchObject({
      error: { code: "CONFLICT" },
    });
    await runScheduled();
    const target = await redirectTarget(
      submitVideoRegenerate("acme-team", "en", first, null, form({})),
    );
    const second = jobIdOf(target);
    expect(second).not.toBe(first);
    const [a, b] = await Promise.all([
      system.videoGenerationJob.findUniqueOrThrow({ where: { id: first } }),
      system.videoGenerationJob.findUniqueOrThrow({ where: { id: second } }),
    ]);
    expect(b).toMatchObject({
      state: "RESERVED",
      prompt: a.prompt,
      title: a.title,
      durationSeconds: a.durationSeconds,
      aspectRatio: a.aspectRatio,
      tier: a.tier,
      userId: user.id,
    });
    expect(await system.usageLedgerEntry.count({ where: { jobId: second, kind: "RESERVE" } })).toBe(
      1,
    );
    expect(scheduled.callbacks).toHaveLength(1);
    // Other workspaces and roles without content.create cannot regenerate.
    const { user: outsider } = await member("other-team", WorkspaceRole.OWNER);
    actAs(outsider);
    expect(await submitVideoRegenerate("other-team", "en", first, null, form({}))).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    const { user: client } = await member("acme-team", WorkspaceRole.CLIENT);
    actAs(client);
    expect(await submitVideoRegenerate("acme-team", "en", first, null, form({}))).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(await system.videoGenerationJob.count({ where: { workspaceId: ws.id } })).toBe(2);
  });

  it("previews the newest request by default and lists every request in the gallery", async () => {
    const { user } = await member("acme-team", WorkspaceRole.EDITOR);
    actAs(user);
    const older = jobIdOf(await redirectTarget(request("acme-team", { ...VALID, title: "Older" })));
    await runScheduled();
    const newer = jobIdOf(await redirectTarget(request("acme-team", { ...VALID, title: "Newer" })));
    const page = await getVideoGeneratePage("acme-team", undefined);
    expect(page.selected?.id).toBe(newer);
    expect(page.jobs.map((job) => job.id)).toEqual([newer, older]);
    const html = render(
      "en",
      createElement(Gallery, {
        slug: "acme-team",
        locale: "en",
        jobs: page.jobs,
        selectedId: page.selected?.id ?? null,
      }),
    );
    expect(html.match(/data-testid="video-jobs-item"/g)).toHaveLength(2);
    expect(html).toContain("Ready for review");
    expect(html).toContain("Queued");
    expect(html).toContain("8 s · 720p · 16:9");
    // Review actions only on the clip waiting for review.
    expect(html.match(/data-testid="gallery-accept"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toMatch(/\$\s?\d|USD|micros/);
  });

  it("marks steps that do not exist yet as planned", () => {
    const html = render("ar", createElement(WorkflowRail));
    for (const step of ["brief", "generate", "review"]) {
      expect(html).toContain(`data-step="${step}" data-available="true"`);
    }
    for (const step of ["script", "edit", "versions"]) {
      expect(html).toContain(`data-step="${step}" data-available="false"`);
    }
    expect(html).toContain("مخطط له");
  });
});

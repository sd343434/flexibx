import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, newClientPage, signUpVerifiedAndSignIn, test, uniqueEmail } from "./fixtures";

// Pass 8–9 end to end, through the real pages, server actions, upload routes and database:
// a project is created, a file is uploaded with progress through the short-lived upload
// URL and handed to analysis; the simulator is announced as such; another workspace sees
// none of it (page, export and subtitle routes). The media pipeline itself (FFmpeg cut,
// reframe, subtitles, credits) runs in a separate worker process and is covered by the
// integration suite with real FFmpeg: the in-memory store of this run is not shared.

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A few bytes that start like an MP4 (an `ftyp` box); only the transport is exercised here. */
const fakeMp4 = () =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypisom", "latin1"),
    Buffer.alloc(4096, 1),
  ]);

async function workspace(page: Page, locale: "ar" | "en", slug: string) {
  await signUpVerifiedAndSignIn(page, locale, uniqueEmail(`studio-${locale}`));
  await page.goto(`/${locale}/workspaces/new`);
  await page.fill("#workspace-name", `Studio ${slug}`);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
  return `/${locale}/w/${slug}`;
}

test("create a project and upload a file in Arabic (RTL), isolated from another workspace", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const slug = `studio-ar-${tag()}`;
  const base = await workspace(page, "ar", slug);

  // The section is in the navigation; an empty list at first.
  await page.getByTestId("nav-studio").first().click();
  await expect(page).toHaveURL(`${base}/studio`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("page-title")).toHaveText("استوديو المحتوى");
  await expect(page.getByTestId("studio-empty")).toBeVisible();

  // A name is required (localized field error, nothing created).
  await page.getByTestId("studio-create-form-submit").click();
  await expect(page.getByTestId("studio-project")).toHaveCount(0);

  await page.fill("#studio-create-form-name", "حلقة البودكاست");
  await page.getByTestId("studio-create-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/studio/[0-9a-f-]{36}$`));
  const projectUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId("studio-status-DRAFT")).toBeVisible();
  // The simulator is never presented as real transcription.
  await expect(page.getByTestId("studio-provider-simulated")).toContainText("محاكاة");
  await expect(page.getByTestId("studio-transcript-empty")).toBeVisible();
  await expect(page.getByTestId("studio-jobs-empty")).toBeVisible();

  // An unsupported file type is refused before anything is sent.
  await page.getByTestId("studio-upload-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not media"),
  });
  await expect(page.getByTestId("studio-upload-error")).toBeVisible();

  // Upload → completion → the analysis job is queued and the page says the file is checked.
  await page.getByTestId("studio-upload-input").setInputFiles({
    name: "episode.mp4",
    mimeType: "video/mp4",
    buffer: fakeMp4(),
  });
  await expect(page.getByTestId("studio-source-checking")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("studio-source-status-UPLOADED")).toBeVisible();
  await expect(page.getByTestId("studio-job-state-QUEUED")).toBeVisible();
  await expect(page.getByTestId("studio-upload")).toHaveCount(0);

  // The queued job can be cancelled from the page; it can then be resumed.
  await page.getByTestId("studio-job-cancel").getByRole("button").click();
  await page.getByTestId("studio-job-cancel-submit").click();
  await expect(page.getByTestId("studio-job-state-CANCELLED")).toBeVisible();
  await page.getByTestId("studio-job-retry-submit").click();
  await expect(page.getByTestId("studio-job-state-QUEUED")).toBeVisible();

  // The list shows the project.
  await page.goto(`${base}/studio`);
  await expect(page.getByTestId("studio-project")).toHaveCount(1);

  // Another workspace's member: the project page is a 404, and so are the file routes.
  const other = await newClientPage(browser);
  const otherBase = await workspace(other, "en", `studio-x-${tag()}`);
  const projectId = projectUrl.split("/").at(-1) ?? "";
  // Through its own workspace (pages stream, so Next's not-found page under a 200)…
  await other.goto(`${otherBase}/studio/${projectId}`);
  await expect(other.locator("main")).toContainText("404");
  await expect(other.locator("body")).not.toContainText("حلقة البودكاست");
  // …and through the first workspace's slug: not a member → a 404, no data.
  const foreign = await other.goto(`/ar/w/${slug}/studio/${projectId}`);
  expect(foreign?.status()).toBe(404);
  await expect(other.locator("body")).not.toContainText("حلقة البودكاست");
  const ownSlugExport = await other.request.get(`/api/w/${slug}/studio/exports/${projectId}`);
  expect(ownSlugExport.status()).toBe(404);
  const subtitles = await other.request.get(
    `/api/w/${otherBase.split("/").at(-1) ?? ""}/studio/transcripts/${projectId}?format=srt`,
  );
  expect(subtitles.status()).toBe(404);
  const upload = await other.request.put(`/api/w/${slug}/studio/uploads/${projectId}`, {
    data: fakeMp4(),
    headers: { "content-type": "video/mp4", origin: new URL(other.url()).origin },
  });
  expect(upload.status()).toBe(404);
  await other.close();
});

test("the studio in English is left-to-right and signed-out visitors are sent to sign in", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const base = await workspace(page, "en", `studio-en-${tag()}`);
  await page.goto(`${base}/studio`);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByTestId("page-title")).toHaveText("Creator Studio");

  const visitor = await browser.newPage();
  await visitor.goto(`${base}/studio`);
  await expect(visitor).toHaveURL(/\/en\/sign-in/);
  await visitor.close();
});

test("a large file is uploaded in parts, paused, resumed after a reload; data export and deletion", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const slug = `studio-mp-${tag()}`;
  const base = await workspace(page, "en", slug);
  await page.goto(`${base}/studio`);
  await page.fill("#studio-create-form-name", "Webinar");
  await page.getByTestId("studio-create-form-submit").click();
  await expect(page).toHaveURL(new RegExp(`${base}/studio/[0-9a-f-]{36}$`));
  const projectId = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // 70 MiB (above the single-upload size): sent as five 16 MiB parts, each hashed first.
  const dir = mkdtempSync(join(tmpdir(), "studio-e2e-"));
  const path = join(dir, "webinar.mp4");
  writeFileSync(path, Buffer.concat([fakeMp4(), Buffer.alloc(70 * 1024 * 1024, 7)]));
  try {
    // Slow the part transfers down so the person can pause in the middle.
    let parts = 0;
    await page.route("**/studio/uploads/*/parts/*", async (route) => {
      parts += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.getByTestId("studio-upload-input").setInputFiles(path);
    await expect(page.getByTestId("studio-upload-uploading")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => parts, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    await page.getByTestId("studio-upload-pause").click();
    await expect(page.getByTestId("studio-upload-paused")).toBeVisible();

    // The tab is reloaded: the unfinished upload is remembered; choosing the same file again
    // resumes with only the parts storage does not hold yet.
    await page.reload();
    await expect(page.getByTestId("studio-source-pending")).toBeVisible();
    const before = parts;
    await page.getByTestId("studio-upload-input").setInputFiles(path);
    await expect(page.getByTestId("studio-source-checking")).toBeVisible({ timeout: 90_000 });
    expect(parts - before).toBeLessThan(5);
    await expect(page.getByTestId("studio-source-status-UPLOADED")).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The project's data as JSON, for its editors only.
  const data = await page.request.get(`/api/w/${slug}/studio/projects/${projectId}/data`);
  expect(data.status()).toBe(200);
  expect(await data.json()).toMatchObject({
    format: "flexibx.creator-project.v1",
    project: { id: projectId, name: "Webinar" },
  });
  const other = await newClientPage(browser);
  const otherBase = await workspace(other, "en", `studio-mpx-${tag()}`);
  const otherSlug = otherBase.split("/").at(-1) ?? "";
  expect(
    (await other.request.get(`/api/w/${otherSlug}/studio/projects/${projectId}/data`)).status(),
  ).toBe(404);
  expect(
    (await other.request.get(`/api/w/${slug}/studio/projects/${projectId}/data`)).status(),
  ).toBe(404);
  await other.close();

  // Deleting needs the project's name; then the project shows its deletion in progress
  // (the files are removed by the worker's storage sweep, which this run does not start).
  await page.fill("#studio-delete-form-confirmName", "Wrong name");
  await page.getByTestId("studio-delete-form-submit").click();
  await expect(page.getByTestId("form-error")).toBeVisible();
  await page.fill("#studio-delete-form-confirmName", "Webinar");
  await page.getByTestId("studio-delete-form-submit").click();
  await expect(page).toHaveURL(`${base}/studio`);
  await expect(page.getByTestId("studio-project-status-DELETING")).toBeVisible();
  await page.goto(`${base}/studio/${projectId}`);
  await expect(page.getByTestId("studio-deletion")).toBeVisible();
  await expect(page.getByTestId("studio-deletion-pending")).toContainText("1 file still to delete");
  await expect(page.getByTestId("studio-upload")).toHaveCount(0);
});

// Platform admin → Storage settings through the real entry points (pages, server actions,
// Better Auth sessions) on the real database. Platform administrators exist only when an
// operator sets users.is_platform_admin in the database; everyone else gets a 404.
// Storage runs in test-memory mode: no network, no paid storage operation.
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { submitSignIn, submitSignUp } from "@/app/[locale]/(auth)/actions";
import AdminLayout from "@/app/[locale]/admin/layout";
import AdminPage from "@/app/[locale]/admin/page";
import {
  submitConnectionCheck,
  submitWasabiSettings,
  submitWriteProvider,
} from "@/app/[locale]/admin/storage/actions";
import AdminStoragePage from "@/app/[locale]/admin/storage/page";
import {
  ChangeWriteProviderForm,
  WasabiSettingsForm,
} from "@/app/[locale]/admin/storage/storage-forms";
import {
  changeWriteProviderAction,
  checkStorageConnectionAction,
  getStorageAdminPageView,
  saveWasabiSettingsAction,
} from "@/server/admin/storage-admin-actions";
import { getSystemDb } from "@/server/db/client";
import { AppError } from "@/server/errors/app-error";

import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { createTestDb, resetDatabase } from "./helpers";

const KEY_ID = "TESTKEYID0123456789AB";
const SECRET = ["test", "secret", "0123456789abcdefghijklmnopqrstuv"].join("-");

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["admin", "storage", "test", "only", "secret", "0123456789abcdef"].join(
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
// Server components translate with getTranslations, which needs a Next.js request; here
// it is the same translator over the real message files, so pages render completely.
vi.mock("next-intl/server", async (importOriginal) => {
  const { createTranslator } = await import("next-intl");
  const messages = {
    ar: (await import("../../messages/ar.json")).default,
    en: (await import("../../messages/en.json")).default,
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getTranslations: (options: string | { locale?: string; namespace?: string }) => {
      const { locale = "en", namespace } =
        typeof options === "string" ? { namespace: options } : options;
      const lang = locale === "ar" ? "ar" : "en";
      return Promise.resolve(
        createTranslator({ locale: lang, messages: messages[lang], namespace: namespace as never }),
      );
    },
  };
});
const cache = vi.hoisted(() => ({ revalidated: [] as string[] }));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    cache.revalidated.push(path);
  },
}));

const { system } = createTestDb();
const PASSWORD = "correct horse battery";
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const SETTINGS = {
  region: "xx-test-1",
  endpoint: "https://s3.xx-test-1.wasabisys.com",
  bucket: "flexibx-test",
};

beforeEach(async () => {
  await resetDatabase(system);
  await system.$executeRaw`DELETE FROM platform_storage_settings`;
  browser.jar.clear();
  cache.revalidated.length = 0;
  vi.stubEnv("WASABI_ACCESS_KEY_ID", KEY_ID);
  vi.stubEnv("WASABI_SECRET_ACCESS_KEY", SECRET);
});

afterAll(async () => {
  await system.$executeRaw`DELETE FROM platform_storage_settings`;
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function controlFlow(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => "rendered",
    (caught: unknown) => caught,
  );
  if (error === "rendered") return "rendered";
  const digest = (error as { digest?: unknown }).digest;
  // Rendering past the guard stops at getTranslations, which needs a real Next request.
  return typeof digest === "string" ? digest : "rendered";
}

let counter = 0;
async function signedInUser(options: { admin?: boolean; verified?: boolean } = {}) {
  counter += 1;
  const email = `admin-flow-${String(counter)}-${Date.now().toString(36)}@example.com`;
  browser.jar.clear();
  await controlFlow(submitSignUp("en", null, form({ name: "Staff", email, password: PASSWORD })));
  await controlFlow(submitSignIn("en", null, form({ email, password: PASSWORD })));
  // The operator step (runbook): the flag is only ever set directly in the database.
  const user = await system.user.update({
    where: { email },
    data: {
      isPlatformAdmin: options.admin ?? false,
      emailVerified: options.verified ?? true,
    },
  });
  return { id: user.id, cookies: new Map(browser.jar) };
}
const actAs = (user: { cookies: Map<string, string> } | null) => {
  browser.jar.clear();
  if (user !== null) for (const [name, value] of user.cookies) browser.jar.set(name, value);
};

const params = Promise.resolve({ locale: "en" });
const children = createElement("p", null, "child");

async function pagesOutcome() {
  return [
    await controlFlow(AdminLayout({ children, params })),
    await controlFlow(AdminPage({ params })),
    await controlFlow(AdminStoragePage({ params })),
  ];
}

async function actionCodes() {
  const codes = [];
  for (const result of [
    await saveWasabiSettingsAction(SETTINGS),
    await checkStorageConnectionAction({ provider: "WASABI" }),
    await changeWriteProviderAction({ target: "WASABI", confirmation: "WASABI" }),
  ]) {
    codes.push(result.ok ? "ok" : result.error.code);
  }
  const view = await getStorageAdminPageView().then(
    () => "ok",
    (error: unknown) => (error instanceof AppError ? error.code : "other"),
  );
  return [...codes, view];
}

function render(node: ReactNode, locale: "ar" | "en" = "en"): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "ar" ? ar : en,
      timeZone: "Asia/Riyadh",
      children: node,
    }),
  );
}

/** The fully rendered storage page (server component + client forms). */
async function renderStoragePage(locale: "ar" | "en" = "en"): Promise<string> {
  const page = await AdminStoragePage({ params: Promise.resolve({ locale }) });
  return render(page, locale);
}

/** HTML text with entities decoded enough to compare with message strings. */
const text = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

describe("platform admin authorization", () => {
  it("hides the area (404) and refuses every action for signed-out visitors", async () => {
    actAs(null);
    expect(await pagesOutcome()).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    expect(await actionCodes()).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
  });

  it("hides it from ordinary users, and from an admin flag without a verified email", async () => {
    actAs(await signedInUser());
    expect(await pagesOutcome()).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    expect(await actionCodes()).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    actAs(await signedInUser({ admin: true, verified: false }));
    expect(await pagesOutcome()).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    expect(await actionCodes()).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    expect(await system.platformStorageSettings.count()).toBe(0);
  });

  it("refuses before validating input: no field details leak to non-admins", async () => {
    actAs(await signedInUser());
    const result = await saveWasabiSettingsAction({ region: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(result)).not.toContain("region");
  });

  it("opens for a verified platform admin, and closes again when the flag is revoked", async () => {
    const admin = await signedInUser({ admin: true });
    actAs(admin);
    const [layout, index, storage] = await pagesOutcome();
    expect(layout).toBe("rendered");
    expect(index).toBe("NEXT_REDIRECT;replace;/en/admin/storage;307;");
    expect(storage).toBe("rendered");
    await system.user.update({ where: { id: admin.id }, data: { isPlatformAdmin: false } });
    expect(await pagesOutcome()).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
  });
});

describe("storage settings as a platform admin", () => {
  it("configures Wasabi, checks it and switches new writes, without exposing keys", async () => {
    actAs(await signedInUser({ admin: true }));
    expect(await submitWasabiSettings("en", null, form(SETTINGS))).toEqual({ status: "saved" });
    expect(cache.revalidated).toEqual(["/en/admin/storage"]);

    const view = await getStorageAdminPageView();
    expect(view.wasabi).toMatchObject({ ...SETTINGS, credentialsPresent: true, ready: true });
    expect(JSON.stringify(view)).not.toContain(KEY_ID);
    expect(JSON.stringify(view)).not.toContain(SECRET);

    const check = await submitConnectionCheck(null, form({ provider: "WASABI" }));
    expect(check).toEqual({ provider: "WASABI", check: { ok: true } });

    expect(
      await submitWriteProvider("en", null, form({ target: "WASABI", confirmation: "yes" })),
    ).toEqual({
      status: "error",
      fields: [{ path: "confirmation", code: "confirmation_mismatch" }],
    });
    expect(
      await submitWriteProvider("en", null, form({ target: "WASABI", confirmation: "WASABI" })),
    ).toEqual({ status: "changed", provider: "WASABI", warnings: [] });
    expect((await getStorageAdminPageView()).writeProvider).toBe("WASABI");

    // Writing to Wasabi locks its location.
    expect(
      await submitWasabiSettings("en", null, form({ ...SETTINGS, bucket: "flexibx-other" })),
    ).toEqual({ status: "locked" });
  });

  it("reports missing keys by name only and refuses to switch to an unready provider", async () => {
    vi.stubEnv("WASABI_ACCESS_KEY_ID", "");
    vi.stubEnv("WASABI_SECRET_ACCESS_KEY", "");
    actAs(await signedInUser({ admin: true }));
    await submitWasabiSettings("en", null, form(SETTINGS));
    expect((await getStorageAdminPageView()).wasabi).toMatchObject({
      credentialsPresent: false,
      ready: false,
      missing: ["credentials"],
    });
    expect(
      await submitWriteProvider("en", null, form({ target: "WASABI", confirmation: "WASABI" })),
    ).toEqual({ status: "unavailable", provider: "WASABI", failure: "not_configured" });
  });

  it("returns field codes for invalid settings and the form shows localized messages", async () => {
    actAs(await signedInUser({ admin: true }));
    const state = await submitWasabiSettings(
      "en",
      null,
      form({ region: "x", endpoint: "https://attacker.example", bucket: SETTINGS.bucket }),
    );
    expect(state).toMatchObject({ status: "error" });
    expect(JSON.stringify(state)).not.toContain("attacker");

    const html = render(
      createElement(WasabiSettingsForm, {
        defaults: { region: "", endpoint: "", bucket: "" },
        locked: false,
      }),
    );
    expect(html).toContain('name="region"');
    expect(html).not.toMatch(/access.?key|secret/i);
    const switchForm = render(
      createElement(ChangeWriteProviderForm, {
        current: "LEGACY_S3",
        options: [
          { id: "LEGACY_S3", ready: true },
          { id: "WASABI", ready: false },
        ],
      }),
    );
    expect(switchForm).toContain(en.admin.storage.change.notReady.replace("'", "&#x27;"));
    expect(switchForm).toMatch(
      /data-testid="write-provider-submit"[^>]*disabled|disabled[^>]*data-testid="write-provider-submit"/,
    );
  });

  it("renders the full storage page: values and policy, key presence only, failover explained", async () => {
    actAs(await signedInUser({ admin: true }));
    await submitWasabiSettings("en", null, form(SETTINGS));
    const html = text(await renderStoragePage());
    const t = en.admin.storage;
    expect(html).toContain('data-testid="admin-storage"');
    // Non-secret settings are shown; keys only as present / missing.
    expect(html).toContain(`value="${SETTINGS.region}"`);
    expect(html).toContain(`value="${SETTINGS.endpoint}"`);
    expect(html).toContain(`value="${SETTINGS.bucket}"`);
    expect(html).toContain(t.wasabi.credentialsPresent);
    expect(html).not.toContain(KEY_ID);
    expect(html).not.toContain(SECRET);
    expect(html).not.toMatch(/WASABI_SECRET_ACCESS_KEY=|secretAccessKey/);
    // The switch explains that existing files are not migrated, including on failover.
    expect(html).toContain(t.change.explain);
    expect(html).toContain(t.policy);
    expect(html).toContain('data-testid="write-target"');
    expect(html).toContain('data-testid="provider-LEGACY_S3"');
    expect(html).toContain('data-testid="provider-WASABI"');
  });

  it("renders the page in Arabic, and the missing-keys state without values", async () => {
    vi.stubEnv("WASABI_ACCESS_KEY_ID", "");
    vi.stubEnv("WASABI_SECRET_ACCESS_KEY", "");
    actAs(await signedInUser({ admin: true }));
    const html = text(await renderStoragePage("ar"));
    expect(html).toContain(ar.admin.storage.title);
    expect(html).toContain(ar.admin.storage.change.explain);
    expect(html).toContain(ar.admin.storage.wasabi.credentialsMissing);
  });

  it("failover through the form: the result names the provider whose files stay behind", async () => {
    actAs(await signedInUser({ admin: true }));
    await submitWasabiSettings("en", null, form(SETTINGS));
    await submitWriteProvider("en", null, form({ target: "WASABI", confirmation: "WASABI" }));
    // A media file now lives on Wasabi; then Wasabi's keys are withdrawn (unavailable).
    const owner = await system.user.findFirstOrThrow();
    const workspace = await system.workspace.create({ data: { name: "W", slug: "w-failover" } });
    await system.mediaAsset.create({
      data: {
        workspaceId: workspace.id,
        filename: "x.png",
        contentType: "image/png",
        sizeBytes: 1,
        storageKey: `workspaces/${workspace.id}/content-media/00000000-0000-4000-8000-000000000001.png`,
        storageProvider: "WASABI",
        uploadedByUserId: owner.id,
      },
    });
    vi.stubEnv("WASABI_ACCESS_KEY_ID", "");
    const state = await submitWriteProvider(
      "en",
      null,
      form({ target: "LEGACY_S3", confirmation: "LEGACY_S3" }),
    );
    expect(state).toEqual({
      status: "changed",
      provider: "LEGACY_S3",
      warnings: [{ provider: "WASABI", failure: "not_configured" }],
    });
    expect((await getStorageAdminPageView()).writeProvider).toBe("LEGACY_S3");
  });
});

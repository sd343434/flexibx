// Platform-admin multi-factor authentication through the real entry points (page server
// actions, Better Auth two-factor plugin, admin pages and actions) on the real database.
// TOTP codes are computed here from the setup key exactly as an authenticator app would.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  submitConfirmEnrollment,
  submitDisableTwoFactor,
  submitRegenerateBackupCodes,
  submitSignIn,
  submitSignUp,
  submitStartEnrollment,
  submitTwoFactor,
} from "@/app/[locale]/(auth)/actions";
import AdminLayout from "@/app/[locale]/admin/layout";
import { addCreditsAdminAction } from "@/server/admin/credits-admin-actions";
import {
  changeWriteProviderAction,
  getStorageAdminPageView,
  saveWasabiSettingsAction,
} from "@/server/admin/storage-admin-actions";
import { resetUserMfa } from "@/server/auth/mfa-reset";
import { claimTotpCode, USED_TOTP_CODE_TTL_MS } from "@/server/auth/two-factor";
import { getSystemDb } from "@/server/db/client";
import { AppError } from "@/server/errors/app-error";

import { createTestDb, grantPlatformAdminForTest, resetDatabase } from "./helpers";
import { totp, wrongCode } from "./totp";

const browser = vi.hoisted(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = ["admin", "mfa", "test", "only", "secret", "0123456789abcdef"].join(
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
vi.mock("next-intl/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTranslations: () => Promise.resolve((key: string) => key),
}));

const { system } = createTestDb();
const PASSWORD = "correct horse battery";
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

beforeEach(async () => {
  await resetDatabase(system);
  browser.jar.clear();
});

afterAll(async () => {
  await system.$disconnect();
  await getSystemDb().$disconnect();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** Runs a server action / page; returns its value, or the redirect/404 digest it threw. */
async function outcome<T>(promise: Promise<T>): Promise<T | string> {
  try {
    return await promise;
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw error;
  }
}
const redirectTarget = (digest: unknown) =>
  typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")
    ? digest.split(";")[2]
    : `not a redirect: ${JSON.stringify(digest)}`;

async function adminAccess(): Promise<string> {
  return getStorageAdminPageView().then(
    () => "GRANTED",
    (error: unknown) => (error instanceof AppError ? error.code : "other"),
  );
}
async function adminPage(): Promise<string> {
  const result = await outcome(
    AdminLayout({ children: null, params: Promise.resolve({ locale: "en" }) }),
  );
  return typeof result === "string"
    ? result.startsWith("NEXT_REDIRECT")
      ? (redirectTarget(result) ?? "")
      : result
    : "rendered";
}

let counter = 0;
async function newAccount(options: { admin?: boolean } = {}) {
  counter += 1;
  const email = `mfa-${String(counter)}-${Date.now().toString(36)}@example.com`;
  browser.jar.clear();
  await outcome(submitSignUp("en", null, form({ name: "Staff", email, password: PASSWORD })));
  const user = await system.user.update({ where: { email }, data: { emailVerified: true } });
  // Administrators are granted after they enroll (enroll() below): the database refuses
  // the flag on an account without two-factor.
  return { id: user.id, email, admin: options.admin ?? false };
}

/** Password step only. Returns where the sign-in form sent the browser. */
async function passwordStep(email: string): Promise<string | undefined> {
  browser.jar.clear();
  return redirectTarget(
    await outcome(submitSignIn("en", null, form({ email, password: PASSWORD }))),
  );
}

const snapshot = () => new Map(browser.jar);
const restore = (jar: Map<string, string>) => {
  browser.jar.clear();
  for (const [name, value] of jar) browser.jar.set(name, value);
};

/**
 * Enrolls the signed-in browser's account; returns the setup key and backup codes. For an
 * administrator account, the grant follows (the operator step).
 */
async function enroll(account?: { id: string; admin: boolean }) {
  const started = await submitStartEnrollment(null, form({ password: PASSWORD }));
  if (started === null || !("status" in started)) throw new Error(JSON.stringify(started));
  // The code used to confirm, kept: a test that later replays it must replay this exact
  // code, not recompute "the current code" (after a 30-second boundary that is a different,
  // never-used code that rightly signs in).
  const enrollmentCode = totp(started.manualKey);
  const confirmed = await outcome(
    submitConfirmEnrollment("en", null, form({ code: enrollmentCode })),
  );
  expect(redirectTarget(confirmed)).toBe("/en/account/security?mfa=enabled");
  if (account?.admin === true) await grantPlatformAdminForTest(system, account.id);
  return { ...started, enrollmentCode };
}

describe("platform admin MFA gate", () => {
  it("the flag cannot exist without two-factor; non-administrators get 404", async () => {
    const candidate = await newAccount({ admin: true });
    // Neither a plain update nor a grant marker makes an account without two-factor an
    // administrator (database trigger).
    await expect(
      system.user.update({ where: { id: candidate.id }, data: { isPlatformAdmin: true } }),
    ).rejects.toThrow();
    await expect(grantPlatformAdminForTest(system, candidate.id)).rejects.toThrow();
    expect(await passwordStep(candidate.email)).toBe("/en/workspaces");
    expect(await adminPage()).toBe(NOT_FOUND);
    expect(await adminAccess()).toBe("NOT_FOUND");

    // A customer with two-factor on is still not an administrator.
    const customer = await newAccount();
    await passwordStep(customer.email);
    await enroll();
    expect(await adminPage()).toBe(NOT_FOUND);
    expect(await adminAccess()).toBe("NOT_FOUND");

    // A granted administrator whose email becomes unverified loses access.
    await passwordStep(candidate.email);
    await enroll(candidate);
    expect(await adminAccess()).toBe("GRANTED");
    await system.user.update({ where: { id: candidate.id }, data: { emailVerified: false } });
    expect(await adminAccess()).toBe("NOT_FOUND");

    // Signed out.
    browser.jar.clear();
    expect(await adminPage()).toBe(NOT_FOUND);
    expect(await adminAccess()).toBe("NOT_FOUND");
  });

  it("enrolls with password + first code; only the new session gets admin access", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    const otherDevice = snapshot();
    await passwordStep(admin.email);

    const wrongPassword = await submitStartEnrollment(null, form({ password: "not the password" }));
    expect(wrongPassword).toEqual({ messageKey: "auth.twoFactor.errors.wrongPassword" });

    const started = await submitStartEnrollment(null, form({ password: PASSWORD }));
    if (started === null || !("status" in started)) throw new Error("not started");
    expect(started.manualKey).toMatch(/^[A-Z2-7]+=*$/);
    expect(started.totpUri).toContain("otpauth://totp/Flexibx");
    expect(started.backupCodes).toHaveLength(10);
    // Stored encrypted: neither the key nor any backup code is in the database as text.
    const row = await system.twoFactor.findUniqueOrThrow({ where: { userId: admin.id } });
    expect(row.verified).toBe(false);
    for (const secret of [started.manualKey, ...started.backupCodes]) {
      expect(row.secret).not.toContain(secret);
      expect(row.backupCodes).not.toContain(secret);
    }
    // Pending enrollment: not an administrator (yet).
    expect(await adminAccess()).toBe("NOT_FOUND");

    const wrong = await submitConfirmEnrollment(
      "en",
      null,
      form({ code: wrongCode(started.manualKey) }),
    );
    expect(wrong).toEqual({ messageKey: "auth.twoFactor.errors.invalidCode" });
    expect(await adminAccess()).toBe("NOT_FOUND");

    const confirmed = await outcome(
      submitConfirmEnrollment("en", null, form({ code: totp(started.manualKey) })),
    );
    expect(redirectTarget(confirmed)).toBe("/en/account/security?mfa=enabled");
    expect(await adminAccess()).toBe("NOT_FOUND"); // enrolled, not granted
    await grantPlatformAdminForTest(system, admin.id); // the operator step
    expect(await adminAccess()).toBe("GRANTED");
    expect(await adminPage()).toBe("rendered");

    // A session that existed before enrollment never passed the second factor.
    restore(otherDevice);
    expect(await adminAccess()).toBe("FORBIDDEN");
    expect(await adminPage()).toBe("/en/account/security?admin=verify");

    // A second start is refused; the audit trail records the enrollment without secrets.
    await passwordStep(admin.email); // password alone is no longer a full sign-in
    const audit = await system.auditLog.findMany({
      where: { entityId: admin.id, action: { startsWith: "user.mfa" } },
    });
    expect(audit.map((entry) => entry.action)).toEqual(["user.mfa_enabled"]);
    expect(JSON.stringify(audit)).not.toContain(started.manualKey);
  });

  it("password alone creates no session; TOTP or a single-use backup code completes sign-in", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    const { manualKey, backupCodes, enrollmentCode } = await enroll(admin);
    await system.session.deleteMany({ where: { userId: admin.id } });

    expect(await passwordStep(admin.email)).toBe("/en/sign-in/two-factor");
    expect(await system.session.count({ where: { userId: admin.id } })).toBe(0);
    expect(await adminAccess()).toBe("NOT_FOUND"); // no session at all yet

    const bad = await submitTwoFactor(
      "en",
      null,
      form({ method: "totp", code: wrongCode(manualKey) }),
    );
    expect(bad).toEqual({ messageKey: "auth.twoFactor.errors.invalidCode" });
    // (The enrollment used the current code; this sign-in uses the next step's code.)
    const signInCode = totp(manualKey, 1);
    const good = await outcome(
      submitTwoFactor("en", null, form({ method: "totp", code: signInCode })),
    );
    expect(redirectTarget(good)).toBe("/en/workspaces");
    expect(await adminAccess()).toBe("GRANTED");

    // Replay: the same code, still inside its validity window, signs nobody in again —
    // not even with the right password (no session is created at all).
    const sessionsBefore = await system.session.count({ where: { userId: admin.id } });
    expect(await passwordStep(admin.email)).toBe("/en/sign-in/two-factor");
    expect(await submitTwoFactor("en", null, form({ method: "totp", code: signInCode }))).toEqual({
      messageKey: "auth.twoFactor.errors.invalidCode",
    });
    expect(await system.session.count({ where: { userId: admin.id } })).toBe(sessionsBefore);
    expect(await adminAccess()).toBe("NOT_FOUND");
    // Nor does the code used for enrollment.
    await passwordStep(admin.email);
    expect(
      await submitTwoFactor("en", null, form({ method: "totp", code: enrollmentCode })),
    ).toEqual({ messageKey: "auth.twoFactor.errors.invalidCode" });
    expect(await system.session.count({ where: { userId: admin.id } })).toBe(sessionsBefore);

    // Backup code: works once, in any spelling the user types.
    const code = backupCodes[0] ?? "";
    await passwordStep(admin.email);
    const viaBackup = await outcome(
      submitTwoFactor("en", null, form({ method: "backup", code: code.replace("-", "") })),
    );
    expect(redirectTarget(viaBackup)).toBe("/en/workspaces");
    expect(await adminAccess()).toBe("GRANTED");
    await passwordStep(admin.email);
    expect(await submitTwoFactor("en", null, form({ method: "backup", code }))).toEqual({
      messageKey: "auth.twoFactor.errors.invalidCode",
    });

    // No challenge cookie (direct visit, other browser): nothing to verify against.
    browser.jar.clear();
    expect(
      await submitTwoFactor("en", null, form({ method: "totp", code: totp(manualKey) })),
    ).toEqual({ messageKey: "auth.twoFactor.errors.expired" });

    const actions = (
      await system.auditLog.findMany({
        where: { entityId: admin.id, action: "user.mfa_sign_in" },
        orderBy: { createdAt: "asc" },
      })
    ).map((entry) => (entry.metadata as { method?: string }).method);
    expect(actions).toEqual(["totp", "backup_code"]);
  });

  it("limits second-step attempts per client and management attempts per account", async () => {
    const admin = await newAccount({ admin: true });
    browser.jar.clear();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await submitTwoFactor("en", null, form({ method: "totp", code: "123456" }))).toEqual({
        messageKey: "auth.twoFactor.errors.expired",
      });
    }
    expect(await submitTwoFactor("en", null, form({ method: "totp", code: "123456" }))).toEqual({
      messageKey: "auth.errors.rateLimited",
    });

    await passwordStep(admin.email);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await submitStartEnrollment(null, form({ password: "wrong password" }))).toEqual({
        messageKey: "auth.twoFactor.errors.wrongPassword",
      });
    }
    // Even the right password is not checked any more in this window.
    expect(await submitStartEnrollment(null, form({ password: PASSWORD }))).toEqual({
      messageKey: "auth.errors.rateLimited",
    });
    expect(await system.twoFactor.count({ where: { userId: admin.id } })).toBe(0);
  });

  it("ends a challenge after 5 wrong codes", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    const { manualKey } = await enroll(admin);

    await passwordStep(admin.email);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await submitTwoFactor("en", null, form({ method: "totp", code: wrongCode(manualKey) })),
      ).toEqual({ messageKey: "auth.twoFactor.errors.invalidCode" });
    }
    // Even the right code is refused now: the challenge is gone; sign in again.
    expect(
      await submitTwoFactor("en", null, form({ method: "totp", code: totp(manualKey) })),
    ).toEqual({ messageKey: "auth.twoFactor.errors.expired" });
    expect(await adminAccess()).toBe("NOT_FOUND");
  });

  it("requires a fresh verification after 12 hours, and after a password-only session", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    await enroll(admin);
    expect(await adminAccess()).toBe("GRANTED");

    await system.session.updateMany({
      where: { userId: admin.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 12 * 60 * 60 * 1000 - 60_000) },
    });
    expect(await adminAccess()).toBe("FORBIDDEN");
    expect(await adminPage()).toBe("/en/account/security?admin=verify");

    // A marker in the future (tampered or skewed) does not count either.
    await system.session.updateMany({
      where: { userId: admin.id },
      data: { mfaVerifiedAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    expect(await adminAccess()).toBe("FORBIDDEN");
  });

  it("changes need a second factor from the last hour; reading needs one from the last 12", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    await enroll(admin);
    await system.session.updateMany({
      where: { userId: admin.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    expect(await adminAccess()).toBe("GRANTED");
    expect(await adminPage()).toBe("rendered");
    const codes = [
      await saveWasabiSettingsAction({}),
      await changeWriteProviderAction({ target: "WASABI", confirmation: "WASABI" }),
      await addCreditsAdminAction({}),
    ].map((result) => (result.ok ? "ok" : result.error.code));
    expect(codes).toEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);

    // Within the hour, the same actions reach their own input validation.
    await system.session.updateMany({
      where: { userId: admin.id },
      data: { mfaVerifiedAt: new Date(Date.now() - 50 * 60 * 1000) },
    });
    const fresh = await addCreditsAdminAction({});
    expect(fresh.ok ? "ok" : fresh.error.code).toBe("VALIDATION_FAILED");
  });

  it("disabling clears every session's marker; backup codes can be replaced", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    const { backupCodes, manualKey } = await enroll(admin);
    const enrollingBrowser = snapshot();
    // A second device that passed the second factor.
    await passwordStep(admin.email);
    await outcome(submitTwoFactor("en", null, form({ method: "totp", code: totp(manualKey, 1) })));
    const secondDevice = snapshot();
    expect(await adminAccess()).toBe("GRANTED");
    restore(enrollingBrowser);

    const regenerated = await submitRegenerateBackupCodes(null, form({ password: PASSWORD }));
    if (regenerated === null || !("status" in regenerated)) throw new Error("not regenerated");
    expect(regenerated.backupCodes).toHaveLength(10);
    expect(regenerated.backupCodes).not.toContain(backupCodes[0]);
    expect(await submitRegenerateBackupCodes(null, form({ password: "not the password" }))).toEqual(
      { messageKey: "auth.twoFactor.errors.wrongPassword" },
    );

    expect(
      await submitDisableTwoFactor("en", null, form({ password: "not the password" })),
    ).toEqual({ messageKey: "auth.twoFactor.errors.wrongPassword" });
    expect(await adminAccess()).toBe("GRANTED");

    const disabled = await outcome(
      submitDisableTwoFactor("en", null, form({ password: PASSWORD })),
    );
    expect(redirectTarget(disabled)).toBe("/en/account/security?mfa=disabled");
    expect(
      await system.session.count({ where: { userId: admin.id, mfaVerifiedAt: { not: null } } }),
    ).toBe(0);
    expect(await system.twoFactor.count({ where: { userId: admin.id } })).toBe(0);
    // Turning two-factor off removed the administrator flag in the same statement.
    expect((await system.user.findUniqueOrThrow({ where: { id: admin.id } })).isPlatformAdmin).toBe(
      false,
    );
    expect(await adminPage()).toBe(NOT_FOUND);
    restore(secondDevice);
    expect(await adminAccess()).toBe("NOT_FOUND");

    // Enrolling again does NOT restore admin access (someone holding only the password could
    // have done it); a new grant does — and sessions from before still do not qualify.
    await passwordStep(admin.email);
    const before = snapshot();
    await passwordStep(admin.email);
    await enroll();
    expect(await adminAccess()).toBe("NOT_FOUND");
    await grantPlatformAdminForTest(system, admin.id);
    expect(await adminAccess()).toBe("GRANTED");
    restore(before);
    expect(await adminAccess()).toBe("FORBIDDEN");
    expect(
      await system.auditLog.count({
        where: { entityId: admin.id, action: "platform_admin.revoked" },
      }),
    ).toBe(1);

    const actions = (
      await system.auditLog.findMany({
        where: { entityId: admin.id, action: { startsWith: "user.mfa" } },
        orderBy: { createdAt: "asc" },
      })
    ).map((entry) => entry.action);
    expect(actions).toEqual([
      "user.mfa_enabled",
      "user.mfa_sign_in",
      "user.mfa_backup_codes_regenerated",
      "user.mfa_disabled",
      "user.mfa_enabled",
    ]);
  });

  it("operator reset (lost device and codes) ends all sessions and requires a new enrollment", async () => {
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    await enroll(admin);
    const enrolled = snapshot();

    await expect(
      resetUserMfa(system, { email: admin.email, operator: "x", reason: "too short" }),
    ).rejects.toThrow();
    expect(
      await resetUserMfa(system, {
        email: "nobody@example.com",
        operator: "ops on call",
        reason: "TICKET-1 identity verified",
      }),
    ).toEqual({ status: "NOT_FOUND" });

    const result = await resetUserMfa(system, {
      email: admin.email.toUpperCase(),
      operator: "ops on call",
      reason: "TICKET-1 identity verified; pasted postgresql://ops:hunter2@db/x by mistake",
    });
    expect(result).toMatchObject({ status: "RESET", userId: admin.id });
    expect(await system.session.count({ where: { userId: admin.id } })).toBe(0);
    restore(enrolled);
    expect(await adminAccess()).toBe("NOT_FOUND"); // the old session is gone

    expect(await passwordStep(admin.email)).toBe("/en/workspaces");
    // The reset removed the administrator flag: enrolling again is not enough.
    expect(await adminPage()).toBe(NOT_FOUND);
    await enroll();
    expect(await adminAccess()).toBe("NOT_FOUND");
    expect(
      await system.auditLog.findFirstOrThrow({
        where: { entityId: admin.id, action: "platform_admin.revoked" },
      }),
    ).toMatchObject({ metadata: { cause: "mfa_reset", operator: "ops on call" } });
    const audit = await system.auditLog.findFirstOrThrow({
      where: { entityId: admin.id, action: "user.mfa_reset_by_operator" },
    });
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata).toMatchObject({ operator: "ops on call" });
    expect(JSON.stringify(audit.metadata)).not.toContain("hunter2");
  });

  it("auth HTTP endpoints cannot set the second-factor marker or the two-factor flag", async () => {
    const route = await import("@/app/api/auth/[...all]/route");
    const admin = await newAccount({ admin: true });
    await passwordStep(admin.email);
    const passwordOnly = snapshot();
    await passwordStep(admin.email);
    await enroll(admin);
    restore(passwordOnly);
    expect(await adminAccess()).toBe("FORBIDDEN");

    const cookie = [...browser.jar]
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
    const post = (path: string, body: unknown) =>
      route.POST(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        }),
      );
    const now = new Date().toISOString();
    const responses = [
      await post("/update-session", { mfaVerifiedAt: now }),
      await post("/update-user", { twoFactorEnabled: true, isPlatformAdmin: true }),
      await post("/two-factor/verify-totp", { code: "123456" }),
      await post("/two-factor/disable", { password: PASSWORD }),
    ];
    for (const response of responses) expect(response.ok).toBe(false);
    expect(
      await system.session.count({ where: { userId: admin.id, mfaVerifiedAt: { not: null } } }),
    ).toBe(1); // only the enrollment session; the password-only one stays unmarked
    expect(await system.twoFactor.count({ where: { userId: admin.id } })).toBe(1);
    expect(await adminAccess()).toBe("FORBIDDEN");
  });

  it("accepts each TOTP code once, also under concurrency, and forgets it after the window", async () => {
    const admin = await newAccount({ admin: true });
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => claimTotpCode(system, admin.id, "123456")),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimTotpCode(system, admin.id, "654321")).toBe(true);
    // Codes are per user, and stored hashed.
    const other = await newAccount();
    expect(await claimTotpCode(system, other.id, "123456")).toBe(true);
    const rows = await system.twoFactorUsedCode.findMany({ where: { userId: admin.id } });
    expect(JSON.stringify(rows)).not.toContain("123456");
    // Lifetime set by the database clock (USED_TOTP_CODE_TTL_MS documents it).
    const [lifetime] = await system.$queryRaw<{ seconds: number }[]>`
      SELECT round(extract(epoch FROM max(expires_at) - now()))::int AS seconds
      FROM two_factor_used_codes WHERE user_id = ${admin.id}::uuid`;
    expect(lifetime?.seconds).toBeGreaterThan(USED_TOTP_CODE_TTL_MS / 1000 - 10);
    expect(lifetime?.seconds).toBeLessThanOrEqual(USED_TOTP_CODE_TTL_MS / 1000);
    // After the window (database clock), the code can be used again; expired claims of
    // OTHER accounts are left alone by this account's claim.
    await system.$executeRaw`
      UPDATE two_factor_used_codes SET expires_at = now() - interval '1 second'
      WHERE user_id IN (${admin.id}::uuid, ${other.id}::uuid)`;
    expect(await claimTotpCode(system, admin.id, "123456")).toBe(true);
    expect(await system.twoFactorUsedCode.count({ where: { userId: admin.id } })).toBe(1);
    expect(await system.twoFactorUsedCode.count({ where: { userId: other.id } })).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  ADMIN_CHANGE_MFA_MAX_AGE_MS,
  ADMIN_MFA_MAX_AGE_MS,
  platformAdminAccess,
} from "@/server/admin/platform-admin-access";
import {
  BACKUP_CODE_COUNT,
  createAuth,
  SECOND_FACTOR_PATHS,
  sessionMfaMarker,
  signInTotpCode,
} from "@/server/auth/auth-config";
import { manualEntryKey, normalizeBackupCode, normalizeTotpCode } from "@/server/auth/two-factor";
import { MemoryMailer } from "@/server/mail/mailer";

// Platform-admin MFA: the pure gate decision, the session marker rule and the plugin
// configuration. End-to-end behaviour: tests/integration/admin-mfa.test.ts.

const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const admin = { isPlatformAdmin: true, emailVerified: true, twoFactorEnabled: true };

describe("platform admin access decision", () => {
  it("hides the area from everyone who is not a verified administrator", () => {
    expect(platformAdminAccess(null, NOW, NOW)).toBe("NOT_ADMIN");
    expect(platformAdminAccess({ ...admin, isPlatformAdmin: false }, NOW, NOW)).toBe("NOT_ADMIN");
    expect(platformAdminAccess({ ...admin, emailVerified: false }, NOW, NOW)).toBe("NOT_ADMIN");
  });

  it("requires enrollment, then a second-factor session", () => {
    expect(platformAdminAccess({ ...admin, twoFactorEnabled: false }, NOW, NOW)).toBe(
      "MFA_ENROLLMENT_REQUIRED",
    );
    expect(platformAdminAccess(admin, null, NOW)).toBe("MFA_VERIFICATION_REQUIRED");
    expect(platformAdminAccess(admin, ago(1000), NOW)).toBe("GRANTED");
  });

  it("expires the verification after 12 hours (1 hour for changes) and rejects the future", () => {
    expect(platformAdminAccess(admin, ago(ADMIN_MFA_MAX_AGE_MS), NOW)).toBe("GRANTED");
    expect(platformAdminAccess(admin, ago(ADMIN_MFA_MAX_AGE_MS + 1), NOW)).toBe(
      "MFA_VERIFICATION_REQUIRED",
    );
    expect(ADMIN_MFA_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
    expect(ADMIN_CHANGE_MFA_MAX_AGE_MS).toBe(60 * 60 * 1000);
    const twoHours = ago(2 * 60 * 60 * 1000);
    expect(platformAdminAccess(admin, twoHours, NOW)).toBe("GRANTED");
    expect(platformAdminAccess(admin, twoHours, NOW, ADMIN_CHANGE_MFA_MAX_AGE_MS)).toBe(
      "MFA_VERIFICATION_REQUIRED",
    );
    // Small clock skew is tolerated; a marker far in the future is not.
    expect(platformAdminAccess(admin, ago(-60_000), NOW)).toBe("GRANTED");
    expect(platformAdminAccess(admin, ago(-10 * 60_000), NOW)).toBe("MFA_VERIFICATION_REQUIRED");
    expect(platformAdminAccess(admin, new Date(Number.NaN), NOW)).toBe("MFA_VERIFICATION_REQUIRED");
  });
});

describe("session second-factor marker", () => {
  it("is set only for sessions created by a successful second-factor verification", () => {
    expect([...SECOND_FACTOR_PATHS].sort()).toEqual([
      "/two-factor/verify-backup-code",
      "/two-factor/verify-totp",
    ]);
    expect(sessionMfaMarker("/two-factor/verify-totp", NOW)).toBe(NOW);
    expect(sessionMfaMarker("/two-factor/verify-backup-code", NOW)).toBe(NOW);
    for (const path of [
      undefined,
      "/sign-in/email",
      "/two-factor/enable",
      "/two-factor/disable",
      "/change-password",
      "/reset-password",
      "/two-factor/verify-otp",
    ]) {
      expect(sessionMfaMarker(path, NOW), String(path)).toBeNull();
    }
  });
});

describe("TOTP sign-in claim (session.create.before)", () => {
  const path = "/two-factor/verify-totp";
  it("claims the code of a sign-in challenge (no session yet)", () => {
    expect(signInTotpCode({ path, body: { code: "123456" }, context: { session: null } })).toEqual({
      code: "123456",
    });
  });
  it("fails closed when the context is unknown or the code unreadable", () => {
    expect(signInTotpCode({ path, body: { code: "123456" } })).toEqual({ code: "123456" });
    expect(signInTotpCode({ path, body: {}, context: { session: null } })).toEqual({ code: null });
    expect(signInTotpCode({ path, body: { code: 123456 }, context: {} })).toEqual({ code: null });
  });
  it("leaves enrollment (a session exists) and every other path alone", () => {
    expect(
      signInTotpCode({ path, body: { code: "123456" }, context: { session: { id: "s" } } }),
    ).toBeNull();
    for (const other of ["/sign-in/email", "/two-factor/verify-backup-code", "/change-password"]) {
      expect(signInTotpCode({ path: other, body: { code: "123456" } }), other).toBeNull();
    }
    expect(signInTotpCode(null)).toBeNull();
  });
});

describe("two-factor configuration", () => {
  const auth = createAuth({
    db: { $extends: () => ({}) } as unknown as PrismaClient, // never queried here
    secret: "s".repeat(40),
    baseURL: "https://app.flexibx.test",
    appUrl: "https://app.flexibx.test",
    isProduction: true,
    mailer: new MemoryMailer(),
    onSecurityEvent: () => Promise.resolve(),
    log: () => undefined,
  });
  const plugin = auth.options.plugins.find((entry) => entry.id === "two-factor") as
    { options?: unknown } | undefined;

  it("uses encrypted backup codes, account lockout and no message-based OTP", () => {
    const options = plugin?.options as Record<string, unknown> | undefined;
    expect(options).toMatchObject({
      issuer: "Flexibx",
      backupCodeOptions: { amount: BACKUP_CODE_COUNT, storeBackupCodes: "encrypted" },
      accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
    });
    expect(options?.otpOptions).toBeUndefined();
    expect(options?.skipVerificationOnEnable).toBeUndefined();
    expect(options?.allowPasswordless).toBeUndefined();
  });

  it("never accepts the session marker from input", () => {
    expect(auth.options.session.additionalFields.mfaVerifiedAt.input).toBe(false);
  });
});

describe("code input normalization", () => {
  it("accepts 6-digit codes with spaces only", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode(" 012345 ")).toBe("012345");
    for (const bad of ["12345", "1234567", "12a456", "", "١٢٣٤٥٦"]) {
      expect(normalizeTotpCode(bad), bad).toBeNull();
    }
  });

  it("accepts backup codes with or without the hyphen", () => {
    expect(normalizeBackupCode("abcDE12345")).toBe("abcDE-12345");
    expect(normalizeBackupCode("abcDE-12345")).toBe("abcDE-12345");
    expect(normalizeBackupCode(" abcDE 12345 ")).toBe("abcDE-12345");
    for (const bad of ["abcd-12345", "abcDE_12345", "abcDE-123456", ""]) {
      expect(normalizeBackupCode(bad), bad).toBeNull();
    }
  });

  it("reads the manual-entry key from an otpauth URI", () => {
    expect(manualEntryKey("otpauth://totp/Flexibx:a%40b.c?secret=JBSWY3DP&issuer=Flexibx")).toBe(
      "JBSWY3DP",
    );
    expect(manualEntryKey("not a uri")).toBe("");
  });
});

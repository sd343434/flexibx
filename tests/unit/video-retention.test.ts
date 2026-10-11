// Generated video retention policy (pure rules) and the expiry reminder email.
import { describe, expect, it } from "vitest";

import { parseVideoRetentionEnv } from "@/server/env-schema";
import { renderMail } from "@/server/mail/templates";
import { retentionRunSeverity, STALE_OVERDUE_MS } from "@/server/videos/retention-observability";
import { isAuthorizedRetentionTrigger } from "@/server/videos/retention-trigger-auth";
import {
  DELETION_LEASE_MS,
  deletionRetryDelayMs,
  LOCK_STATEMENTS_BEFORE_BUDGET,
  expiresAtFor,
  expiryStage,
  formatDeletionTime,
  hoursRemaining,
  isExpired,
  isReminderDue,
  METADATA_RETENTION_DAYS,
  MAX_CONNECTIONS_AFTER_DEADLINE,
  MAX_STATEMENTS_AFTER_DEADLINE,
  METADATA_RETENTION_MS,
  RETENTION_CONNECT_TIMEOUT_MS,
  RETENTION_STATEMENT_TIMEOUT_MS,
  RUN_LOCK_TIMEOUT_MS,
  RUN_TIME_BUDGET_MS,
  STORAGE_DELETE_TIMEOUT_MS,
  VIDEO_RETENTION_HOURS,
  VIDEO_RETENTION_MS,
  worstCaseRunMs,
} from "@/server/videos/retention-policy";

const HOUR = 60 * 60 * 1000;
const succeeded = new Date("2026-10-09T09:30:00.000Z");
const expires = expiresAtFor(succeeded);

describe("retention period", () => {
  it("is exactly 168 hours from the success timestamp", () => {
    expect(VIDEO_RETENTION_HOURS).toBe(168);
    expect(expires.getTime() - succeeded.getTime()).toBe(168 * HOUR);
    expect(expires.toISOString()).toBe("2026-10-16T09:30:00.000Z");
  });

  it("stays 168 hours across a daylight-saving change; only the displayed wall time moves", () => {
    // New York switches to daylight time on 2026-03-08.
    const start = new Date("2026-03-05T12:00:00.000Z");
    const end = expiresAtFor(start);
    expect(end.getTime() - start.getTime()).toBe(VIDEO_RETENTION_MS);
    const opts = {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "America/New_York",
    } as const;
    expect(new Intl.DateTimeFormat("en-US", opts).format(start)).toBe("07:00");
    expect(new Intl.DateTimeFormat("en-US", opts).format(end)).toBe("08:00");
  });

  it("is expired from the exact expiry instant, not a millisecond earlier", () => {
    expect(isExpired(expires, new Date(expires.getTime() - 1))).toBe(false);
    expect(isExpired(expires, expires)).toBe(true);
    expect(isExpired(expires, new Date(expires.getTime() + 1))).toBe(true);
  });

  it("reports the stage at the 48 h and 24 h boundaries", () => {
    const at = (msBefore: number) => new Date(expires.getTime() - msBefore);
    expect(expiryStage(expires, at(48 * HOUR + 1))).toBe("available");
    expect(expiryStage(expires, at(48 * HOUR))).toBe("within48h");
    expect(expiryStage(expires, at(24 * HOUR + 1))).toBe("within48h");
    expect(expiryStage(expires, at(24 * HOUR))).toBe("within24h");
    expect(expiryStage(expires, at(1))).toBe("within24h");
    expect(expiryStage(expires, at(0))).toBe("expired");
  });

  it("counts whole hours remaining, rounded up and never negative", () => {
    expect(hoursRemaining(expires, succeeded)).toBe(168);
    expect(hoursRemaining(expires, new Date(expires.getTime() - 90 * 60 * 1000))).toBe(2);
    expect(hoursRemaining(expires, new Date(expires.getTime() + HOUR))).toBe(0);
  });

  it("keeps metadata much longer than files", () => {
    expect(METADATA_RETENTION_DAYS * 24).toBeGreaterThan(VIDEO_RETENTION_HOURS);
  });
});

describe("reminder windows", () => {
  const at = (msBefore: number) => new Date(expires.getTime() - msBefore);
  it("opens 48 h and 24 h before deletion and closes at deletion", () => {
    expect(isReminderDue(48, expires, at(48 * HOUR + 1))).toBe(false);
    expect(isReminderDue(48, expires, at(48 * HOUR))).toBe(true);
    expect(isReminderDue(24, expires, at(24 * HOUR + 1))).toBe(false);
    expect(isReminderDue(24, expires, at(24 * HOUR))).toBe(true);
    expect(isReminderDue(24, expires, at(1))).toBe(true);
    expect(isReminderDue(24, expires, at(0))).toBe(false);
  });
});

describe("deletion retries", () => {
  it("backs off exponentially from 5 minutes and caps at 6 hours", () => {
    expect(deletionRetryDelayMs(1)).toBe(5 * 60 * 1000);
    expect(deletionRetryDelayMs(2)).toBe(10 * 60 * 1000);
    expect(deletionRetryDelayMs(4)).toBe(40 * 60 * 1000);
    expect(deletionRetryDelayMs(50)).toBe(6 * HOUR);
    expect(deletionRetryDelayMs(0)).toBe(5 * 60 * 1000);
  });
});

describe("deletion time display", () => {
  it("shows the server instant in the workspace time zone", () => {
    expect(formatDeletionTime(expires, "en", "Asia/Riyadh")).toContain("12:30");
    expect(formatDeletionTime(expires, "en", "UTC")).toContain("9:30");
    expect(formatDeletionTime(expires, "en", "Asia/Riyadh")).toContain("October 16, 2026");
    expect(formatDeletionTime(expires, "ar", "Asia/Riyadh")).toMatch(/١٢:٣٠|12:30/);
  });
});

describe("expiry reminder email", () => {
  const base = {
    to: "owner@example.com",
    template: "video_expiry_reminder" as const,
    data: {
      workspaceName: "Acme",
      videoTitle: "Launch <script>alert(1)</script>\r\nBcc: x@y.z",
      hoursLeft: 24,
      deletionTime: "Friday, October 16, 2026 at 12:30 PM",
      url: "https://app.flexibx.example/en/w/acme/ai/videos",
    },
  };

  it("renders in English and Arabic with the deletion time and download link", () => {
    for (const locale of ["en", "ar"] as const) {
      const mail = renderMail({ ...base, locale });
      expect(mail.subject).toContain("24");
      expect(mail.text).toContain(base.data.deletionTime);
      expect(mail.text).toContain(base.data.url);
      expect(mail.html).toContain(`dir="${locale === "ar" ? "rtl" : "ltr"}"`);
    }
  });

  it("escapes the title in HTML and keeps the subject on one line", () => {
    const mail = renderMail({ ...base, locale: "en" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it("refuses non-http links", () => {
    expect(() =>
      renderMail({ ...base, locale: "en", data: { ...base.data, url: "javascript:alert(1)" } }),
    ).toThrow();
  });
});

describe("scheduler endpoint authorization", () => {
  const secret = "s".repeat(40);
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedRetentionTrigger(`Bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorizedRetentionTrigger(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedRetentionTrigger(`bearer ${secret}`, secret)).toBe(false);
    expect(isAuthorizedRetentionTrigger(secret, secret)).toBe(false);
    expect(isAuthorizedRetentionTrigger(null, secret)).toBe(false);
    expect(isAuthorizedRetentionTrigger("Bearer ", secret)).toBe(false);
  });

  it("is disabled without a sufficiently long secret", () => {
    expect(isAuthorizedRetentionTrigger("Bearer short", "short")).toBe(false);
    expect(isAuthorizedRetentionTrigger("Bearer anything", undefined)).toBe(false);
  });
});

describe("video retention environment", () => {
  it("defaults to no endpoint and no reminder emails", () => {
    expect(parseVideoRetentionEnv({})).toEqual({ VIDEO_EXPIRY_EMAILS: "disabled" });
    expect(
      parseVideoRetentionEnv({ VIDEO_RETENTION_CRON_SECRET: "", VIDEO_EXPIRY_EMAILS: "" }),
    ).toEqual({
      VIDEO_EXPIRY_EMAILS: "disabled",
    });
  });

  it("rejects a short secret and unknown email modes without echoing values", () => {
    expect(() => parseVideoRetentionEnv({ VIDEO_RETENTION_CRON_SECRET: "too-short" })).toThrow(
      /VIDEO_RETENTION_CRON_SECRET/,
    );
    expect(() => parseVideoRetentionEnv({ VIDEO_RETENTION_CRON_SECRET: "too-short" })).not.toThrow(
      /too-short/,
    );
    expect(() => parseVideoRetentionEnv({ VIDEO_EXPIRY_EMAILS: "yes" })).toThrow();
  });
});

describe("metadata retention", () => {
  it("is the approved 30 days after file deletion", () => {
    expect(METADATA_RETENTION_DAYS).toBe(30);
    expect(METADATA_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("run severity (alerting)", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const backlog = { overdue: 0, oldestOverdueExpiresAt: null, alerting: 0 };
  it("is info when healthy, warn on transient trouble, error when a human is needed", () => {
    expect(retentionRunSeverity({ deletionFailed: 0, backlog, now })).toBe("info");
    expect(retentionRunSeverity({ deletionFailed: 1, backlog, now })).toBe("warn");
    const fresh = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    expect(
      retentionRunSeverity({
        deletionFailed: 0,
        backlog: { ...backlog, overdue: 3, oldestOverdueExpiresAt: fresh },
        now,
      }),
    ).toBe("warn");
    const stale = new Date(now.getTime() - STALE_OVERDUE_MS);
    expect(
      retentionRunSeverity({
        deletionFailed: 0,
        backlog: { ...backlog, overdue: 1, oldestOverdueExpiresAt: stale },
        now,
      }),
    ).toBe("error");
    expect(
      retentionRunSeverity({ deletionFailed: 0, backlog: { ...backlog, alerting: 1 }, now }),
    ).toBe("error");
  });

  it("never reports a run cut short by its time budget as healthy", () => {
    expect(retentionRunSeverity({ deletionFailed: 0, stoppedAtDeadline: true, backlog, now })).toBe(
      "warn",
    );
    expect(
      retentionRunSeverity({ deletionFailed: 0, stoppedAtDeadline: false, backlog, now }),
    ).toBe("info");
  });

  it("keeps the calculated worst case, from the lock query to the last statement, inside the lock's 10 minutes", () => {
    expect(RUN_LOCK_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(LOCK_STATEMENTS_BEFORE_BUDGET).toBe(1);
    expect(worstCaseRunMs()).toBe(
      LOCK_STATEMENTS_BEFORE_BUDGET * RETENTION_STATEMENT_TIMEOUT_MS +
        RUN_TIME_BUDGET_MS +
        STORAGE_DELETE_TIMEOUT_MS +
        MAX_STATEMENTS_AFTER_DEADLINE * RETENTION_STATEMENT_TIMEOUT_MS +
        MAX_CONNECTIONS_AFTER_DEADLINE * RETENTION_CONNECT_TIMEOUT_MS,
    );
    // 3 s lock query + 8 min + 30 s + 8 × 3 s + 4 × 3 s = 9 min 9 s: over 30 s to spare.
    expect(worstCaseRunMs()).toBe(9 * 60 * 1000 + 9 * 1000);
    expect(worstCaseRunMs()).toBeLessThanOrEqual(RUN_LOCK_TIMEOUT_MS - 30_000);
    // A claim made at the very end of the budget is still leased past the run's end.
    expect(DELETION_LEASE_MS).toBeGreaterThan(worstCaseRunMs() - RUN_TIME_BUDGET_MS);
  });
});

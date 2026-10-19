// Fixed-window counting for the internal scheduler/monitor buckets (Pass 15). Better
// Auth's limiter resets a count only after `window` seconds without an allowed request,
// so a caller steadier than one call per window got `max` calls and was then refused
// until it paused for a whole window — measured on the staging stack: a once-a-minute
// scheduler lost the automation tick for 10 of every 22 minutes. The internal buckets now
// alternate two keys by window parity (fixedWindowSlot). Real limiter, real database;
// only Date is faked, for Better Auth and the slot alike.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/server/errors/app-error";

import { createTestAuth } from "./auth-harness";
import { createTestDb, resetDatabase } from "./helpers";

const { system } = createTestDb();
const test = createTestAuth(system, "s".repeat(48));
const WINDOW_MS = 600_000;
/** 5 s into a 10-minute window, so the scenarios below control every boundary. */
const START = Math.floor(Date.UTC(2026, 9, 19, 12, 0, 0) / WINDOW_MS) * WINDOW_MS + 5_000;

beforeEach(async () => {
  await resetDatabase(system);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await system.$disconnect();
});

const tick = () =>
  test.limit({
    bucket: "automation-tick",
    requestHeaders: new Headers(),
    subject: "internal-automation-tick",
  });

async function refused(call: () => Promise<void>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") return true;
    throw error;
  }
}

describe("internal buckets count in fixed windows", () => {
  it("never refuses a steady once-a-minute scheduler (45 minutes)", async () => {
    const outcomes: boolean[] = [];
    for (let minute = 0; minute < 45; minute += 1) {
      vi.setSystemTime(START + minute * 60_000);
      outcomes.push(await refused(tick));
    }
    expect(outcomes.filter(Boolean)).toHaveLength(0);
    // Two alternating keys, not one row per window.
    expect(
      await system.rateLimit.count({ where: { key: { contains: "/automation-tick/" } } }),
    ).toBe(2);
  });

  it("still allows only 12 per window, and the next window starts from zero", async () => {
    for (let i = 0; i < 12; i += 1) expect(await refused(tick)).toBe(false);
    expect(await refused(tick)).toBe(true);
    vi.setSystemTime(START + WINDOW_MS - 10_000); // same window
    expect(await refused(tick)).toBe(true);
    vi.setSystemTime(START + WINDOW_MS); // next window
    for (let i = 0; i < 12; i += 1) expect(await refused(tick)).toBe(false);
    expect(await refused(tick)).toBe(true);
    // Two windows later the first key is used again — and starts from zero too.
    vi.setSystemTime(START + 2 * WINDOW_MS);
    expect(await refused(tick)).toBe(false);
  });

  it("documents the old behaviour on a bucket without fixedWindow (Better Auth's rule)", async () => {
    // ai-generate: 20 per 10 minutes, subject-scoped, not an internal bucket.
    const generate = () =>
      test.limit({ bucket: "ai-generate", requestHeaders: new Headers(), subject: "user-1" });
    const outcomes: boolean[] = [];
    for (let minute = 0; minute < 25; minute += 1) {
      vi.setSystemTime(START + minute * 60_000);
      outcomes.push(await refused(generate));
    }
    // One call a minute — 10 per 10 minutes — is still refused from the 21st call on.
    expect(outcomes.indexOf(true)).toBe(20);
  });
});

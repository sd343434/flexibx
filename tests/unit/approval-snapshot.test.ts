import { describe, expect, it } from "vitest";

import {
  buildSnapshot,
  canonicalJson,
  MAX_AMOUNT_MINOR,
  readSnapshot,
  snapshotHash,
} from "@/server/orchestration/approval-snapshot";

// The exact action a person approves: canonical, hashed, validated — deterministic code.

const scope = (risk: "INTERNAL" | "EXTERNAL" | "SPEND") => ({
  workflow: "campaign",
  task: "boost",
  risk,
});

describe("canonicalJson and snapshotHash", () => {
  it("does not depend on key order, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    const one = buildSnapshot(scope("EXTERNAL"), {
      action: "publish_post",
      details: { post: "p-1", channel: "x" },
    });
    const two = buildSnapshot(scope("EXTERNAL"), {
      details: { channel: "x", post: "p-1" },
      action: "publish_post",
    });
    if (!one.ok || !two.ok) throw new Error("expected valid snapshots");
    expect(snapshotHash(one.snapshot)).toBe(snapshotHash(two.snapshot));
    expect(snapshotHash(one.snapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with any detail, the amount or the currency", () => {
    const hash = (description: unknown) => {
      const built = buildSnapshot(scope("SPEND"), description);
      if (!built.ok) throw new Error("expected a valid snapshot");
      return snapshotHash(built.snapshot);
    };
    const base = {
      action: "boost_post",
      details: { post: "p-1" },
      amount: { minor: 5_000, currency: "SAR" },
    };
    const hashes = new Set([
      hash(base),
      hash({ ...base, details: { post: "p-2" } }),
      hash({ ...base, amount: { minor: 5_001, currency: "SAR" } }),
      hash({ ...base, amount: { minor: 5_000, currency: "USD" } }),
      hash({ ...base, action: "boost_story" }),
    ]);
    expect(hashes.size).toBe(5);
  });
});

describe("buildSnapshot", () => {
  it("requires a positive integer amount in a currency for spending, and only for spending", () => {
    const spend = (amount: unknown) =>
      buildSnapshot(scope("SPEND"), { action: "boost_post", details: {}, amount }).ok;
    expect(spend({ minor: 5_000, currency: "SAR" })).toBe(true);
    expect(spend(undefined)).toBe(false);
    expect(spend({ minor: 0, currency: "SAR" })).toBe(false);
    expect(spend({ minor: -5, currency: "SAR" })).toBe(false);
    expect(spend({ minor: 10.5, currency: "SAR" })).toBe(false);
    expect(spend({ minor: MAX_AMOUNT_MINOR + 1, currency: "SAR" })).toBe(false);
    expect(spend({ minor: 5_000, currency: "sar" })).toBe(false);
    expect(spend({ minor: "5000", currency: "SAR" })).toBe(false);
    expect(
      buildSnapshot(scope("EXTERNAL"), {
        action: "publish_post",
        details: {},
        amount: { minor: 1, currency: "SAR" },
      }).ok,
    ).toBe(false);
  });

  it("refuses INTERNAL tasks, bad action names and non-JSON or oversized details", () => {
    const external = (description: unknown) => buildSnapshot(scope("EXTERNAL"), description).ok;
    expect(buildSnapshot(scope("INTERNAL"), { action: "publish_post", details: {} }).ok).toBe(
      false,
    );
    expect(external(null)).toBe(false);
    expect(external({ action: "Publish Post", details: {} })).toBe(false);
    expect(external({ action: "publish_post", details: [] })).toBe(false);
    expect(external({ action: "publish_post", details: { at: new Date() } })).toBe(false);
    expect(external({ action: "publish_post", details: { n: Number.NaN } })).toBe(false);
    expect(external({ action: "publish_post", details: { text: "x".repeat(17_000) } })).toBe(false);
    expect(external({ action: "publish_post", details: { text: "نص عربي", tags: ["a"] } })).toBe(
      true,
    );
  });

  it("round-trips through storage", () => {
    const built = buildSnapshot(scope("SPEND"), {
      action: "boost_post",
      details: { post: "p-1" },
      amount: { minor: 5_000, currency: "SAR" },
    });
    if (!built.ok) throw new Error("expected a valid snapshot");
    const stored: unknown = JSON.parse(JSON.stringify(built.snapshot));
    expect(readSnapshot(stored)).toEqual(built.snapshot);
    expect(readSnapshot({ ...(stored as object), risk: "INTERNAL" })).toBeNull();
    expect(readSnapshot({ ...(stored as object), amount: null })).toBeNull();
    expect(readSnapshot("nope")).toBeNull();
  });
});

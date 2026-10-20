import { describe, expect, it } from "vitest";

import { buildIdFromCommit } from "@/server/build-id";

describe("buildIdFromCommit", () => {
  const sha = "9333ffabf7bc5b780009e2a2a95bcb2ede6ad73c";

  it("derives one build ID per commit, the same for every build of it", () => {
    expect(buildIdFromCommit(sha)).toBe("9333llghl7hi5h780009k2g2g95hih2kjk6gj73i");
    expect(buildIdFromCommit(sha)).toBe(buildIdFromCommit(sha));
    expect(buildIdFromCommit("0".repeat(39) + "1")).not.toBe(buildIdFromCommit("0".repeat(40)));
  });

  it("never contains a or d (so never 'ad', which Next.js keeps out of build IDs)", () => {
    const id = buildIdFromCommit("adadadadadadadadadadadadadadadadadadadad");
    expect(id).toBe("gjgjgjgjgjgjgjgjgjgjgjgjgjgjgjgjgjgjgjgj");
    expect(id).not.toMatch(/[ad]/);
  });

  it("keeps Next.js's random ID for anything but a full commit SHA", () => {
    for (const value of [
      undefined,
      "",
      "unknown",
      sha.slice(0, 12),
      sha.toUpperCase(),
      `${sha}0`,
      `${sha}\n`,
    ]) {
      expect(buildIdFromCommit(value)).toBeNull();
    }
  });
});

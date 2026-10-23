// The session-token mapping (src/server/auth/session-token-hash.ts, Pass 39): every shape
// in which Better Auth's Prisma adapter can name a token is hashed, values that already
// look hashed are hashed again (a stolen stored value matches nothing), and other fields
// are left alone.
import { describe, expect, it } from "vitest";

import {
  hashSessionToken,
  mapSessionArgs,
  mapSessionWhere,
  SESSION_TOKEN_HASH_PREFIX,
} from "@/server/auth/session-token-hash";

const RAW = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const H = hashSessionToken(RAW);

describe("session token hashing", () => {
  it("is a prefixed SHA-256 hex, deterministic and never the raw token", () => {
    expect(H).toMatch(/^h1\$[0-9a-f]{64}$/);
    expect(H.startsWith(SESSION_TOKEN_HASH_PREFIX)).toBe(true);
    expect(hashSessionToken(RAW)).toBe(H);
    expect(H).not.toContain(RAW);
    expect(hashSessionToken(H)).not.toBe(H);
  });

  it("hashes every where shape, at any depth, and leaves other fields alone", () => {
    const seen = new Map<string, string>();
    expect(mapSessionWhere({ token: RAW, userId: "u" }, seen)).toEqual({ token: H, userId: "u" });
    expect(mapSessionWhere({ token: { equals: RAW } }, seen)).toEqual({ token: { equals: H } });
    expect(mapSessionWhere({ token: { in: [RAW, "x"] } }, seen)).toEqual({
      token: { in: [H, hashSessionToken("x")] },
    });
    expect(mapSessionWhere({ token: { not: { equals: RAW } } }, seen)).toEqual({
      token: { not: { equals: H } },
    });
    expect(
      mapSessionWhere({ AND: [{ token: { in: [RAW] } }, { expiresAt: { gt: 1 } }] }, seen),
    ).toEqual({ AND: [{ token: { in: [H] } }, { expiresAt: { gt: 1 } }] });
    expect(mapSessionWhere({ OR: [{ token: RAW }], NOT: { token: RAW } }, seen)).toEqual({
      OR: [{ token: H }],
      NOT: { token: H },
    });
    expect(seen.get(H)).toBe(RAW);
  });

  it("hashes again a value that already looks hashed (stolen stored value)", () => {
    const seen = new Map<string, string>();
    expect(mapSessionWhere({ token: H }, seen)).toEqual({ token: hashSessionToken(H) });
  });

  it("hashes written tokens in data, create, update and createMany", () => {
    const seen = new Map<string, string>();
    expect(mapSessionArgs({ data: { token: RAW, userId: "u" } }, seen)).toEqual({
      data: { token: H, userId: "u" },
    });
    expect(mapSessionArgs({ data: [{ token: RAW }] }, seen)).toEqual({ data: [{ token: H }] });
    expect(
      mapSessionArgs(
        { where: { id: "s" }, create: { token: RAW }, update: { token: { set: RAW } } },
        seen,
      ),
    ).toEqual({ where: { id: "s" }, create: { token: H }, update: { token: { set: H } } });
    expect(mapSessionArgs({ data: { expiresAt: 1 } }, seen)).toEqual({ data: { expiresAt: 1 } });
  });
});

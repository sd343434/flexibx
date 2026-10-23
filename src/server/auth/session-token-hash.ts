import { createHash } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";

// Session tokens at rest (Pass 39). Better Auth keeps the session token in `sessions.token`
// and looks sessions up by it; the browser holds the same token in a cookie signed with
// AUTH_SECRET. Stored as is, a database leak plus AUTH_SECRET is enough to sign in as any
// user. Better Auth (1.7.9) has no option to hash it, so the Prisma client given to its
// adapter stores and matches `h1$<sha256 hex>` instead, and hands the caller back the raw
// token it asked for, so the cookie Better Auth writes is still the raw one:
//   - writes (create, update, upsert): `data.token` is hashed;
//   - every condition on `token` (equals, in, not, nested AND/OR/NOT) is hashed — always,
//     also when the value already looks like a hash: a stolen stored value presented as a
//     cookie is hashed again and matches nothing;
//   - results: a token this call was given in raw form is put back; any other (sessions
//     listed by user) stays hashed — so the routes that return or take tokens of OTHER
//     sessions (list-sessions, revoke-session, revoke-sessions, revoke-other-sessions) are
//     disabled (auth-config.ts DISABLED_HTTP_PATHS). Revocation by user (password change or
//     reset, MFA reset) does not use tokens and is unaffected.
// Tokens are 32 random characters (≈190 bits): a plain SHA-256 is enough (no pepper).
// Existing rows are hashed by migration 20261023120000_hash_session_tokens.

export const SESSION_TOKEN_HASH_PREFIX = "h1$";

export function hashSessionToken(token: string): string {
  return SESSION_TOKEN_HASH_PREFIX + createHash("sha256").update(token, "utf8").digest("hex");
}

type Hashes = Map<string, string>; // stored form → raw token

function hashed(value: unknown, seen: Hashes): unknown {
  if (typeof value !== "string") return value;
  const stored = hashSessionToken(value);
  seen.set(stored, value);
  return stored;
}

/** A `token` condition with its values hashed: plain value, or equals / in / notIn / not. */
function mapTokenCondition(condition: unknown, seen: Hashes): unknown {
  if (typeof condition === "string") return hashed(condition, seen);
  if (condition === null || typeof condition !== "object") return condition;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(condition)) {
    if (key === "equals") out[key] = hashed(value, seen);
    else if (key === "in" || key === "notIn") {
      out[key] = Array.isArray(value) ? value.map((entry) => hashed(entry, seen)) : value;
    } else if (key === "not") out[key] = mapTokenCondition(value, seen);
    else out[key] = value;
  }
  return out;
}

/** A where clause with every `token` condition hashed, at any depth of AND / OR / NOT. */
export function mapSessionWhere(where: unknown, seen: Hashes): unknown {
  if (Array.isArray(where)) return where.map((entry) => mapSessionWhere(entry, seen));
  if (where === null || typeof where !== "object") return where;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === "token") out[key] = mapTokenCondition(value, seen);
    else if (key === "AND" || key === "OR" || key === "NOT")
      out[key] = mapSessionWhere(value, seen);
    else out[key] = value;
  }
  return out;
}

function mapData(data: unknown, seen: Hashes): unknown {
  if (Array.isArray(data)) return data.map((entry) => mapData(entry, seen));
  if (data === null || typeof data !== "object" || !("token" in data)) return data;
  const record = data as Record<string, unknown>;
  const token = record.token;
  if (typeof token === "string") return { ...record, token: hashed(token, seen) };
  if (token !== null && typeof token === "object" && "set" in token) {
    return { ...record, token: { set: hashed(token.set, seen) } };
  }
  return data;
}

function restore(result: unknown, seen: Hashes): unknown {
  if (Array.isArray(result)) return result.map((entry) => restore(entry, seen));
  if (result === null || typeof result !== "object" || !("token" in result)) return result;
  const record = result as Record<string, unknown>;
  const raw = typeof record.token === "string" ? seen.get(record.token) : undefined;
  return raw === undefined ? result : { ...record, token: raw };
}

/** Maps one session query's arguments (exported for tests). */
export function mapSessionArgs(args: unknown, seen: Hashes): unknown {
  if (args === null || typeof args !== "object") return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if ("where" in out) out.where = mapSessionWhere(out.where, seen);
  if ("data" in out) out.data = mapData(out.data, seen);
  if ("create" in out) out.create = mapData(out.create, seen);
  if ("update" in out) out.update = mapData(out.update, seen);
  return out;
}

/** The client for Better Auth's adapter: session tokens hashed at rest (see above). */
export function withHashedSessionTokens(db: PrismaClient): PrismaClient {
  return db.$extends({
    query: {
      session: {
        async $allOperations({ args, query }) {
          const seen: Hashes = new Map();
          const result: unknown = await query(mapSessionArgs(args, seen) as typeof args);
          return restore(result, seen);
        },
      },
    },
  }) as unknown as PrismaClient;
}

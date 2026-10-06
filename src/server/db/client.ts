import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";

import { getEnv } from "../env";
import { createGuardedClient, createPrismaClient, type GuardedPrismaClient } from "./prisma";

interface DbSingletons {
  base?: PrismaClient;
  guarded?: GuardedPrismaClient;
}

// Reuse clients across hot reloads in development (one connection pool per process).
const globalForDb = globalThis as typeof globalThis & { __flexibxDb?: DbSingletons };
const singletons: DbSingletons = (globalForDb.__flexibxDb ??= {});

function base(): PrismaClient {
  singletons.base ??= createPrismaClient(getEnv().DATABASE_URL);
  return singletons.base;
}

/**
 * The application database client. Tenant-guarded: queries on workspace-owned models
 * without a workspace scope throw. Use this everywhere by default.
 */
export function getDb(): GuardedPrismaClient {
  singletons.guarded ??= createGuardedClient(base());
  return singletons.guarded;
}

/**
 * UNGUARDED client for explicitly reviewed system paths only (e.g. listing a user's
 * memberships across workspaces, health checks, future purge jobs). Never pass request
 * input to it without an explicit authorization check.
 */
export function getSystemDb(): PrismaClient {
  return base();
}

import type { GuardedPrismaClient } from "./prisma";

/** Interactive-transaction client of the guarded Prisma client (keeps the tenant guard). */
export type GuardedTransactionClient = Parameters<
  Parameters<GuardedPrismaClient["$transaction"]>[0]
>[0];

/** Anything services can run queries on: the guarded client or one of its transactions. */
export type Db = GuardedPrismaClient | GuardedTransactionClient;

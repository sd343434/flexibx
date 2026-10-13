// A disposable database with disposable owner / app / grant roles, set up exactly as
// docs/runbooks/DATABASE_ROLES.md describes (migrations as the owner, then
// scripts/ops/sql/db-roles.sql). Needs a superuser connection: ROLE_TEST_ADMIN_DATABASE_URL,
// or the test database's own user when it is a superuser (CI). Everything is dropped by
// teardown(). Identifiers are fixed prefixes plus random hex; passwords are random hex and
// never printed.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/server/db/prisma";

import { resolveTestDatabaseUrl } from "../test-database";

const run = promisify(execFile);
export const repositoryRoot = join(import.meta.dirname, "../../..");

export type RoleName = "owner" | "app" | "grant";

/**
 * Test-only SQL that cannot use bind parameters (DDL, privileges, statements the boundary
 * must refuse). Callers pass constants or identifiers from this module — never input.
 */
export function ddl(client: PrismaClient, sql: string): Promise<number> {
  // eslint-disable-next-line no-restricted-properties -- constant test SQL only (see above)
  return client.$executeRawUnsafe(sql);
}

export interface RoleDatabase {
  readonly available: boolean;
  readonly skipReason: string;
  readonly roles: Readonly<Record<RoleName, string>>;
  /** Connection URL of a role (contains its password: never print it). */
  urlFor(role: RoleName): string;
  /** A Prisma client connected as the role. */
  db(role: RoleName): PrismaClient;
  /** The superuser client (role and privilege changes in tests). */
  admin(): PrismaClient;
  /** (Re)applies scripts/ops/sql/db-roles.sql; returns psql's exit code and output. */
  applyRoles(): Promise<{ code: number; output: string }>;
  /** A password of a role, to assert it never appears in output. */
  secretOf(role: RoleName): string;
  teardown(): Promise<void>;
}

export async function createRoleDatabase(label: string): Promise<RoleDatabase> {
  const adminUrl = process.env.ROLE_TEST_ADMIN_DATABASE_URL ?? resolveTestDatabaseUrl();
  const suffix = randomBytes(4).toString("hex");
  const roles = {
    owner: `flexibx_${label}${suffix}_owner`,
    app: `flexibx_${label}${suffix}_app`,
    grant: `flexibx_${label}${suffix}_grant`,
  } as const;
  const database = `flexibx_${label}_${suffix}_test`;
  const secrets: Record<RoleName, string> = {
    owner: randomBytes(18).toString("hex"),
    app: randomBytes(18).toString("hex"),
    grant: randomBytes(18).toString("hex"),
  };
  const admin = createPrismaClient(adminUrl);
  const clients: Partial<Record<RoleName, PrismaClient>> = {};
  let created = false;

  const urlFor = (role: RoleName) => {
    const url = new URL(adminUrl);
    url.username = roles[role];
    url.password = secrets[role];
    url.pathname = `/${database}`;
    url.search = "";
    return url.toString();
  };
  const applyRoles = async () => {
    const url = new URL(adminUrl);
    try {
      const result = await run(
        "psql",
        [
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-v",
          `owner_role=${roles.owner}`,
          "-v",
          `app_role=${roles.app}`,
          "-v",
          `grant_role=${roles.grant}`,
          "-f",
          join(repositoryRoot, "scripts/ops/sql/db-roles.sql"),
        ],
        {
          // libpq environment: no URL or password on the command line.
          env: {
            PATH: process.env.PATH,
            PGHOST: url.hostname,
            PGPORT: url.port || "5432",
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            PGDATABASE: database,
            PGCONNECT_TIMEOUT: "10",
          } as unknown as NodeJS.ProcessEnv,
        },
      );
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error: unknown) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, output: (failed.stdout ?? "") + (failed.stderr ?? "") };
    }
  };
  const base = {
    roles,
    urlFor,
    applyRoles,
    secretOf: (role: RoleName) => secrets[role],
    admin: () => admin,
    db: (role: RoleName) => {
      const client = clients[role];
      if (client === undefined) throw new Error("role database not set up");
      return client;
    },
    teardown: async () => {
      for (const client of Object.values(clients)) await client.$disconnect();
      if (created) {
        await ddl(admin, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        for (const role of [roles.app, roles.grant, roles.owner]) {
          await ddl(admin, `DROP ROLE IF EXISTS ${role}`);
        }
        created = false;
      }
      await admin.$disconnect();
    },
  };

  const [me] = await admin.$queryRaw<{ rolsuper: boolean }[]>`
    SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
  if (me?.rolsuper !== true) {
    return {
      ...base,
      available: false,
      skipReason: "needs a superuser connection (ROLE_TEST_ADMIN_DATABASE_URL)",
    };
  }
  created = true;
  try {
    for (const role of ["owner", "app", "grant"] as const) {
      await ddl(admin, `CREATE ROLE ${roles[role]} LOGIN PASSWORD '${secrets[role]}'`);
    }
    await ddl(admin, `CREATE DATABASE ${database} OWNER ${roles.owner}`);
    await run(join(repositoryRoot, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: urlFor("owner") },
    });
    const applied = await applyRoles();
    if (applied.code !== 0) throw new Error(`db-roles.sql failed: ${applied.output}`);
    for (const role of ["owner", "app", "grant"] as const) {
      clients[role] = createPrismaClient(urlFor(role));
    }
  } catch (error) {
    // A failed setup never leaves roles or a database behind (the caller gets no handle).
    await base.teardown();
    throw error;
  }
  return { ...base, available: true, skipReason: "" };
}

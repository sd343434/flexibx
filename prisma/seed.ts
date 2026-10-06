// Development seed — SAFE DEMO DATA ONLY. No passwords, tokens or real personal data.
// Idempotent: re-running it does not duplicate rows. Refuses to run in production.
//
//   pnpm db:seed
import "dotenv/config";

import { WorkspaceRole, WorkspaceType, type PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/server/db/prisma";

const DEMO_USERS = [
  { email: "owner@demo.flexibx.local", name: "سارة المالكة", locale: "ar" },
  { email: "agency@demo.flexibx.local", name: "Omar Agency", locale: "en" },
  { email: "client@demo.flexibx.local", name: "ليلى العميلة", locale: "ar" },
] as const;

interface DemoWorkspace {
  readonly slug: string;
  readonly name: string;
  readonly type: WorkspaceType;
  readonly parentSlug?: string;
  readonly members: readonly { readonly email: string; readonly role: WorkspaceRole }[];
}

const DEMO_WORKSPACES: readonly DemoWorkspace[] = [
  {
    slug: "demo-store",
    name: "متجر تجريبي",
    type: WorkspaceType.BUSINESS,
    members: [{ email: "owner@demo.flexibx.local", role: WorkspaceRole.OWNER }],
  },
  {
    slug: "demo-agency",
    name: "Demo Agency",
    type: WorkspaceType.AGENCY,
    members: [{ email: "agency@demo.flexibx.local", role: WorkspaceRole.OWNER }],
  },
  {
    slug: "demo-agency-client",
    name: "مطعم العميل التجريبي",
    type: WorkspaceType.BUSINESS,
    parentSlug: "demo-agency",
    // Agency staff reach client workspaces only through explicit membership rows.
    members: [
      { email: "agency@demo.flexibx.local", role: WorkspaceRole.ADMIN },
      { email: "client@demo.flexibx.local", role: WorkspaceRole.CLIENT },
    ],
  },
];

async function seed(db: PrismaClient) {
  const userIds = new Map<string, string>();
  for (const user of DEMO_USERS) {
    const row = await db.user.upsert({
      where: { email: user.email },
      update: {},
      create: { email: user.email, name: user.name, locale: user.locale, emailVerified: true },
    });
    userIds.set(user.email, row.id);
  }

  const workspaceIds = new Map<string, string>();
  for (const workspace of DEMO_WORKSPACES) {
    const parentWorkspaceId =
      workspace.parentSlug === undefined ? null : (workspaceIds.get(workspace.parentSlug) ?? null);
    const existing = await db.workspace.findUnique({ where: { slug: workspace.slug } });
    const row =
      existing ??
      (await db.workspace.create({
        data: {
          slug: workspace.slug,
          name: workspace.name,
          type: workspace.type,
          parentWorkspaceId,
        },
      }));
    workspaceIds.set(workspace.slug, row.id);

    for (const member of workspace.members) {
      const userId = userIds.get(member.email);
      if (userId === undefined) throw new Error(`Seed: unknown user ${member.email}`);
      await db.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: row.id, userId } },
        update: { role: member.role },
        create: { workspaceId: row.id, userId, role: member.role },
      });
    }

    if (existing === null) {
      await db.auditLog.create({
        data: {
          workspaceId: row.id,
          actorUserId: userIds.get(workspace.members[0]?.email ?? "") ?? null,
          action: "workspace.created",
          entityType: "workspace",
          entityId: row.id,
          metadata: { source: "seed" },
        },
      });
    }
  }

  return { users: userIds.size, workspaces: workspaceIds.size };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production. The seed is for development only.");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  // The seed is a reviewed system path, so it uses the unguarded client.
  const db = createPrismaClient(databaseUrl);
  try {
    const result = await seed(db);
    process.stdout.write(
      `Seeded ${result.users} demo users and ${result.workspaces} demo workspaces.\n`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import "server-only";

import { getDb } from "../db/client";
import { AppError } from "../errors/app-error";
import { getContent } from "../marketing/content-service";
import { requireWorkspaceAccess } from "../tenancy/access";
import { isUuid } from "../tenancy/context";
import { assertCan, can } from "../tenancy/permissions";

import { getAiRuntime } from "./ai-actions";
import { getMyGeneration, getUsageSummary, listMyGenerations } from "./ai-service";

// Page data for AI Studio, the content assist panel and the usage summary. Every query
// resolves the workspace from the session's membership and reads through services that
// check the permission; FORBIDDEN reaches the page ("not available for your role").

const notFound = () => new AppError("NOT_FOUND", { metadata: { resource: "ai_generation" } });

/** AI Studio (content.create): history, the selected suggestion and the form options. */
export async function getAiStudioPage(slug: string, generationId: string | undefined) {
  const ctx = await requireWorkspaceAccess(slug);
  assertCan(ctx, "content.create");
  const db = getDb();
  const selected =
    generationId === undefined
      ? null
      : isUuid(generationId)
        ? await getMyGeneration(db, ctx, generationId)
        : (() => {
            throw notFound();
          })();
  if (selected !== null && selected.contentItemId !== null) throw notFound();
  const [history, pillars, campaigns] = await Promise.all([
    listMyGenerations(db, ctx, { newContent: true }),
    db.contentPillar.findMany({
      where: { workspaceId: ctx.workspaceId, status: "ACTIVE" },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, name: true },
    }),
    db.campaign.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        status: { in: ["DRAFT", "PLANNED", "ACTIVE", "PAUSED"] },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, name: true },
    }),
  ]);
  return {
    configured: getAiRuntime().provider !== null,
    history,
    selected,
    options: { pillars, campaigns },
    can: { usage: can(ctx.role, "audit.view") },
  };
}

/** The assist panel of a draft (content.edit; the panel is shown for drafts only). */
export async function getContentAssist(
  slug: string,
  contentId: string,
  generationId: string | undefined,
) {
  const ctx = await requireWorkspaceAccess(slug);
  if (!can(ctx.role, "content.edit") || !isUuid(contentId)) return null;
  const db = getDb();
  const content = await getContent(db, ctx, contentId);
  if (content.status !== "DRAFT") return null;
  const selected =
    generationId === undefined || !isUuid(generationId)
      ? null
      : await getMyGeneration(db, ctx, generationId).catch((error: unknown) => {
          if (error instanceof AppError && error.code === "NOT_FOUND") return null;
          throw error;
        });
  return {
    configured: getAiRuntime().provider !== null,
    history: await listMyGenerations(db, ctx, { contentItemId: contentId }),
    selected: selected !== null && selected.contentItemId === contentId ? selected : null,
  };
}

/** Workspace AI usage (audit.view). */
export async function getAiUsagePage(slug: string) {
  const ctx = await requireWorkspaceAccess(slug);
  return {
    configured: getAiRuntime().provider !== null,
    usage: await getUsageSummary(getDb(), ctx),
  };
}

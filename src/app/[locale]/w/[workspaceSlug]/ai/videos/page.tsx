import { Download, Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Badge, EmptyState, ForbiddenNotice, PageHeader } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getVideosPage } from "@/server/videos/video-queries";
import {
  expiryStage,
  formatDeletionTime,
  hoursRemaining,
  type ExpiryStage,
} from "@/server/videos/retention-policy";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";

import { BeforeGenerationNotice, VideoRetentionNotice } from "./retention-notices";

const STAGE_TONES = {
  available: "outline",
  within48h: "accent",
  within24h: "solid",
  expired: "muted",
} as const satisfies Record<ExpiryStage, "outline" | "accent" | "solid" | "muted">;

/**
 * Generated AI videos with the 7-day retention notice: each video shows when it will be
 * deleted (workspace time zone) and can be downloaded until then.
 */
export default async function VideosRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "ai.videos" });
  const data = await guardPage(getVideosPage(workspace.slug));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const { videos, timeZone, now, canGenerate } = data;
  const when = (at: Date) => formatDeletionTime(at, locale, timeZone);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canGenerate ? (
            <Button asChild>
              <Link
                href={`/w/${workspace.slug}/ai/videos/generate`}
                data-testid="video-generate-link"
              >
                <Sparkles aria-hidden="true" />
                {t("generateLink")}
              </Link>
            </Button>
          ) : null
        }
      />

      <VideoRetentionNotice locale={locale} timeZone={timeZone} now={now} />
      <BeforeGenerationNotice locale={locale} timeZone={timeZone} now={now} />

      {videos.length === 0 ? (
        <EmptyState message={t("empty")} testId="videos-empty" />
      ) : (
        <ul className="space-y-3" data-testid="video-list">
          {videos.map((video) => {
            const stage: ExpiryStage =
              video.status === "AVAILABLE" ? expiryStage(video.expiresAt, now) : "expired";
            const downloadable = video.status === "AVAILABLE" && stage !== "expired";
            const base = `/api/w/${workspace.slug}/videos/${video.id}`;
            return (
              <li
                key={video.id}
                className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                data-testid="video-item"
                data-video-id={video.id}
                data-stage={stage}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold">{video.title}</h3>
                    <Badge tone={STAGE_TONES[stage]} testId="video-stage">
                      {video.status === "DELETED"
                        ? t("stage.deleted")
                        : video.status === "DELETING"
                          ? t("stage.deleting")
                          : t(`stage.${stage}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("generatedAt", { date: when(video.succeededAt) })} ·{" "}
                    {t("details", {
                      seconds: video.durationSeconds,
                      width: video.width,
                      height: video.height,
                    })}
                  </p>
                  {video.status === "DELETED" && video.filesDeletedAt !== null ? (
                    <p className="text-sm" data-testid="video-deleted-at">
                      {t("deletedOn", { date: when(video.filesDeletedAt) })}
                    </p>
                  ) : (
                    <p className="text-sm" data-testid="video-deletes-at">
                      {downloadable
                        ? t("deletesOn", {
                            date: when(video.expiresAt),
                            hours: hoursRemaining(video.expiresAt, now),
                          })
                        : t("deletingNow", { date: when(video.expiresAt) })}
                    </p>
                  )}
                </div>
                {downloadable ? (
                  <Button asChild variant={stage === "available" ? "outline" : "default"}>
                    <a href={base} download data-testid="video-download">
                      <Download aria-hidden="true" />
                      {t("download")}
                    </a>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

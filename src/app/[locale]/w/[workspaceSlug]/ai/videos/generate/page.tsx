import { Film } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ForbiddenNotice, Notice } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { getVideoGeneratePage } from "@/server/videos/generation/video-generation-queries";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../../page-data";

import { submitVideoRequest } from "./actions";
import { Gallery, JobStatus, WorkflowRail } from "./job-status";
import { StudioForm } from "./studio-form";

/**
 * Video Studio: the brief and settings beside a large preview of the selected request,
 * the workflow (planned steps marked as planned), and recent generations. Every rule —
 * who may request, what is valid, what it may cost — is decided on the server; the page
 * shows honest states only. No money is shown: the budget policy is undecided.
 */
export default async function VideoStudioRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const raw = await searchParams;
  const t = await getTranslations({ locale, namespace: "ai.videos.generate" });
  const jobId = typeof raw.job === "string" ? raw.job : undefined;
  const data = await guardPage(getVideoGeneratePage(workspace.slug, jobId));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
            {workspace.name}
          </p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
              data.configured ? "bg-card" : "border-dashed text-muted-foreground",
            )}
            data-testid="video-provider-status"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-full",
                data.configured ? "bg-primary" : "bg-muted-foreground",
              )}
            />
            {data.configured ? t("providerStatus.test") : t("providerStatus.off")}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${workspace.slug}/ai/videos`} data-testid="videos-list-link">
              <Film aria-hidden="true" />
              {t("job.openVideos")}
            </Link>
          </Button>
        </div>
      </header>

      <WorkflowRail />

      {data.configured ? null : <Notice testId="video-not-configured">{t("notConfigured")}</Notice>}
      <Notice testId="video-budget-notice">{t("budgetNotice")}</Notice>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <section
          aria-label={t("preview.label")}
          className="order-first min-w-0 lg:sticky lg:top-4 lg:order-last"
          data-testid="video-job"
        >
          <JobStatus
            slug={workspace.slug}
            locale={locale}
            timeZone={data.timeZone}
            configured={data.configured}
            job={data.selected}
            result={data.result}
          />
        </section>
        <div className="min-w-0" data-testid="video-request">
          <StudioForm
            action={submitVideoRequest.bind(null, workspace.slug, locale)}
            configured={data.configured}
            options={data.options}
            defaultLanguage={locale}
          />
        </div>
      </div>

      <section aria-labelledby="video-jobs" className="space-y-3">
        <h2 id="video-jobs" className="text-lg font-bold">
          {t("gallery.title")}
        </h2>
        <Gallery
          slug={workspace.slug}
          locale={locale}
          jobs={data.jobs}
          selectedId={data.selected?.id ?? null}
        />
      </section>
    </div>
  );
}

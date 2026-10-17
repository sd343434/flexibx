import { getFormatter, getTranslations } from "next-intl/server";

import { LtrText } from "@/components/common/ltr-text";
import { Badge, Card, EmptyState, Notice, type BadgeTone } from "@/components/marketing/page-parts";
import type { Locale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import type { ContentStage } from "@/server/marketing/campaign-progress";
import type { getCampaignProgress } from "@/server/marketing/plan-queries";
import { publicationErrorKind } from "@/server/social/publishing-readiness";

// A campaign's progress, next steps and recorded results (Pass 4). Server-rendered from
// recorded facts only; no engagement or revenue figure exists in Flexibx, so none is
// shown. Queued posts are never shown as published.

type Progress = NonNullable<Awaited<ReturnType<typeof getCampaignProgress>>>;

const STAGE_TONES: Readonly<Record<ContentStage, BadgeTone>> = {
  planned: "muted",
  draft: "muted",
  changes_requested: "danger",
  in_review: "accent",
  approved: "outline",
  scheduled: "soft",
  queued: "soft",
  uncertain: "danger",
  failed: "danger",
  published: "solid",
  published_manually: "solid",
};

export async function CampaignProgressCard({
  locale,
  slug,
  campaignId,
  data,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly campaignId: string;
  readonly data: Progress;
}) {
  const t = await getTranslations({ locale, namespace: "marketing" });
  const tp = await getTranslations({ locale, namespace: "social.publishing" });
  const format = await getFormatter({ locale });
  const { progress } = data;
  const day = (value: Date) => format.dateTime(value, { dateStyle: "medium", timeZone: "UTC" });
  const lastRun =
    data.schedulerLastRunAt === null
      ? tp("onHold.never")
      : format.dateTime(data.schedulerLastRunAt, { dateStyle: "medium", timeStyle: "short" });

  return (
    <>
      <Card title={t("progress.stepsTitle")} testId="campaign-next-steps">
        {progress.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="campaign-steps-none">
            {t("progress.stepsNone")}
          </p>
        ) : (
          <ol className="space-y-3">
            {progress.steps.map((step) => (
              <li
                key={step.action}
                className="rounded-md border-s-4 border-primary/60 bg-muted/40 px-3 py-2 text-sm"
                data-testid={`campaign-step-${step.action}`}
              >
                <p>{t(`progress.steps.${step.action}`, { count: step.count })}</p>
                {step.action === "unblock_publishing" ? (
                  <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
                    {data.blockers.map((blocker) => (
                      <li key={blocker}>{tp(`onHold.${blocker}`, { last: lastRun })}</li>
                    ))}
                  </ul>
                ) : null}
                {step.action === "approve_plan" ||
                step.action === "create_drafts" ||
                step.action === "write_plan" ? (
                  <Link
                    href={`/w/${slug}/campaigns/${campaignId}/plan`}
                    className="mt-1 inline-block underline"
                  >
                    {t("progress.openPlan")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card
        title={t("progress.title")}
        testId="campaign-progress"
        actions={
          progress.total === 0 ? null : (
            <span className="text-sm text-muted-foreground" data-testid="campaign-progress-summary">
              {t("progress.summary", { published: progress.published, total: progress.total })}
            </span>
          )
        }
      >
        {progress.total === 0 ? (
          <EmptyState message={t("progress.empty")} testId="campaign-progress-empty" />
        ) : (
          <ul className="divide-y" data-testid="campaign-progress-rows">
            {progress.rows.map((row) => (
              <li
                key={row.key}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid="campaign-progress-row"
                data-stage={row.stage}
              >
                <div className="min-w-0 space-y-1">
                  {row.contentId === null ? (
                    <span className="font-medium break-words">{row.title}</span>
                  ) : (
                    <Link
                      href={`/w/${slug}/content/${row.contentId}`}
                      className="font-medium break-words hover:underline"
                    >
                      {row.title}
                    </Link>
                  )}
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {row.channel === null
                        ? t("progress.notFromPlan")
                        : t(`enums.channel.${row.channel}`)}
                    </span>
                    {row.dueDate === null ? null : <span>{day(row.dueDate)}</span>}
                    {row.overdue ? (
                      <span className="text-destructive" data-testid="campaign-progress-overdue">
                        {t("progress.overdue")}
                      </span>
                    ) : null}
                    {row.errorCode === null ? null : (
                      <span className="text-destructive">
                        {tp(`errors.${publicationErrorKind(row.errorCode) ?? "other"}`)}
                      </span>
                    )}
                    {row.externalPostId === null ? null : (
                      <span>
                        {t("progress.facebookPost")}{" "}
                        <a
                          href={`https://www.facebook.com/${encodeURIComponent(row.externalPostId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          <LtrText>{row.externalPostId}</LtrText>
                        </a>
                      </span>
                    )}
                  </p>
                </div>
                <span className="self-start sm:self-auto">
                  <Badge tone={STAGE_TONES[row.stage]} testId="campaign-progress-stage">
                    {t(`progress.stage.${row.stage}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("progress.resultsTitle")} testId="campaign-results">
        <dl className="grid gap-4 sm:grid-cols-4">
          {(
            [
              ["publishedConfirmed", progress.counts.published],
              ["publishedManually", progress.counts.published_manually],
              ["uncertain", progress.counts.uncertain],
              ["failed", progress.counts.failed],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="space-y-1">
              <dt className="text-xs font-medium text-muted-foreground">{t(`progress.${key}`)}</dt>
              <dd
                className="text-2xl font-semibold tabular-nums"
                data-testid={`campaign-result-${key}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <Notice testId="campaign-results-note">
          {t("progress.resultsNote")}{" "}
          <Link
            href={`/w/${slug}/insights?campaign=${campaignId}`}
            className="font-medium underline"
            data-testid="campaign-insights-link"
          >
            {t("progress.insightsLink")}
          </Link>
        </Notice>
      </Card>
    </>
  );
}

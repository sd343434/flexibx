import { Check, CircleAlert, Clapperboard, Clock, Download, FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";

import { FlexibxLoader } from "@/components/ui/flexibx-loader";
import { ActionButton } from "@/components/marketing/entity-form";
import { Badge, EmptyState } from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { VideoGeneratePage } from "@/server/videos/generation/video-generation-queries";
import { formatDeletionTime } from "@/server/videos/retention-policy";

import { submitVideoRefresh, submitVideoRegenerate, submitVideoReview } from "./actions";

// The Video Studio's status views: the preview stage with the selected request (honest
// states only — no progress estimates, test-provider output labelled as a placeholder),
// its review and recovery actions, the gallery of recent requests and the workflow rail.
// Display only: every button posts to a server action that re-checks access and state.

type Job = NonNullable<VideoGeneratePage["selected"]>;
type JobState = Job["state"];

const STATE_TONES = {
  RESERVED: "outline",
  IN_PROGRESS: "accent",
  READY_FOR_REVIEW: "solid",
  ACCEPTED: "solid",
  REJECTED: "muted",
  FAILED: "muted",
  LIMIT_REACHED: "muted",
  NEEDS_RECONCILIATION: "accent",
  CANCELLED: "muted",
} as const satisfies Record<JobState, "outline" | "accent" | "solid" | "muted">;

const FAILURE_CODES = [
  "rejected",
  "refused",
  "max_attempts",
  "max_wall_time",
  "outcome_unknown",
] as const;
type KnownFailure = (typeof FAILURE_CODES)[number];
const isKnownFailure = (code: string): code is KnownFailure =>
  (FAILURE_CODES as readonly string[]).includes(code);

export function failureKey(code: string) {
  return isKnownFailure(code) ? (`failure.${code}` as const) : ("failure.other" as const);
}

function failureHintKey(code: string) {
  return isKnownFailure(code) && code !== "outcome_unknown"
    ? (`failureHint.${code}` as const)
    : ("failureHint.other" as const);
}

const ACTIVE: readonly JobState[] = ["RESERVED", "IN_PROGRESS"];
/** States from which "Generate again" may start a new request. */
const REGENERABLE: readonly JobState[] = [
  "READY_FOR_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "FAILED",
  "LIMIT_REACHED",
  "CANCELLED",
];

/** Works with both `getTranslations` (pages) and `useTranslations` (components). */
type LabelTranslator = (
  key: "aspect.landscape" | "aspect.portrait" | "tiers.DRAFT" | "tiers.STANDARD",
) => string;

export function aspectLabel(t: LabelTranslator, value: string): string {
  if (value === "16:9") return t("aspect.landscape");
  if (value === "9:16") return t("aspect.portrait");
  return value;
}

export function tierLabel(t: LabelTranslator, value: string): string {
  return value === "DRAFT" || value === "STANDARD" ? t(`tiers.${value}`) : value;
}

/** A frame in the job's own format, on the dark stage surface. */
function Stage({
  aspect,
  children,
  testId,
}: {
  readonly aspect: string;
  readonly children: React.ReactNode;
  readonly testId: string;
}) {
  const portrait = aspect === "9:16";
  return (
    <div className="flex justify-center rounded-xl bg-feature p-3 sm:p-4" data-testid={testId}>
      <div
        className={cn(
          "relative flex w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg border border-white/10 p-6 text-center text-feature-foreground",
          portrait ? "aspect-[9/16] max-h-[32rem] max-w-[18rem]" : "aspect-video",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The stage's single status light (the brand's one Lime dot marks what is live). */
function LiveDot() {
  return <span aria-hidden="true" className="size-2.5 rounded-full bg-lime" />;
}

export function JobStatus({
  slug,
  locale,
  timeZone,
  configured,
  job,
  result,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly configured: boolean;
  readonly job: Job | null;
  readonly result: VideoGeneratePage["result"];
}) {
  const t = useTranslations("ai.videos.generate");
  if (job === null) {
    return (
      <Stage aspect="16:9" testId="video-stage">
        <Clapperboard aria-hidden="true" className="size-10 opacity-80" />
        <p className="text-lg font-semibold" data-testid="video-job-empty">
          {t("preview.empty")}
        </p>
        <p className="max-w-sm text-sm text-feature-muted">{t("preview.emptyHint")}</p>
      </Stage>
    );
  }
  const when = (at: Date) => formatDeletionTime(at, locale, timeZone);
  const active = ACTIVE.includes(job.state);
  const failed = job.failureCode !== null && job.state !== "NEEDS_RECONCILIATION";
  const showResult = result !== null;

  const stage = (() => {
    if (active) {
      return (
        <>
          <FlexibxLoader
            tone="dark"
            size={56}
            label={t(`state.${job.state}`)}
            className="dark:hidden"
          />
          <FlexibxLoader
            tone="violet"
            size={56}
            label={t(`state.${job.state}`)}
            className="hidden dark:inline-block"
          />
          <p className="flex items-center gap-2 text-lg font-semibold">
            <LiveDot />
            {t(`state.${job.state}`)}
          </p>
          <p
            className="max-w-sm text-sm text-feature-muted"
            role="status"
            data-testid="video-job-progress"
          >
            {t("job.inProgress")} {t("preview.generatingHint")}
          </p>
        </>
      );
    }
    if (job.state === "NEEDS_RECONCILIATION") {
      return (
        <>
          <Clock aria-hidden="true" className="size-10 opacity-80" />
          <p className="max-w-sm text-sm" role="status" data-testid="video-job-reconciliation">
            {t("job.reconciliation")}
          </p>
        </>
      );
    }
    if (failed) {
      return (
        <>
          <CircleAlert aria-hidden="true" className="size-10 opacity-80" />
          <p className="text-lg font-semibold">{t("preview.failed")}</p>
          <p className="max-w-sm text-sm" role="alert" data-testid="video-job-failure">
            {t(failureKey(job.failureCode ?? ""))}{" "}
            <span className="text-feature-muted">{t(failureHintKey(job.failureCode ?? ""))}</span>
          </p>
        </>
      );
    }
    if (showResult && !result.downloadable) {
      return (
        <>
          <Clock aria-hidden="true" className="size-10 opacity-80" />
          <p className="text-lg font-semibold" data-testid="video-job-expired">
            {t("preview.expired")}
          </p>
          <p className="max-w-sm text-sm text-feature-muted">{t("job.expired")}</p>
        </>
      );
    }
    if (showResult && job.placeholder) {
      return (
        <div data-testid="video-placeholder" className="flex flex-col items-center gap-3">
          <FlaskConical aria-hidden="true" className="size-10 opacity-80" />
          <p className="flex items-center gap-2 text-lg font-semibold">
            <LiveDot />
            {t("preview.placeholder")}
          </p>
          <p className="max-w-sm text-sm text-feature-muted">{t("preview.placeholderHint")}</p>
        </div>
      );
    }
    if (showResult) {
      return (
        // A real provider's clip, streamed from the retention-aware download route.
        <video
          controls
          preload="metadata"
          className="absolute inset-0 size-full bg-black object-contain"
          src={`/api/w/${slug}/videos/${result.videoId}`}
          aria-label={t("preview.video", { title: job.title })}
          data-testid="video-player"
        />
      );
    }
    return (
      <>
        <Check aria-hidden="true" className="size-10 opacity-80" />
        <p className="text-lg font-semibold">{t(`state.${job.state}`)}</p>
      </>
    );
  })();

  return (
    <div className="space-y-4" data-testid="video-job-detail" data-state={job.state}>
      <Stage aspect={job.aspectRatio} testId="video-stage">
        {stage}
      </Stage>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold">{job.title}</h2>
          <Badge tone={STATE_TONES[job.state]} testId="video-job-state">
            {t(`state.${job.state}`)}
          </Badge>
          {job.placeholder ? (
            <Badge tone="outline" testId="video-job-placeholder">
              {t("preview.placeholder")}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("job.details", {
            seconds: job.durationSeconds,
            aspect: aspectLabel(t, job.aspectRatio),
            resolution: job.resolution,
            tier: tierLabel(t, job.tier),
          })}
          {" · "}
          {t("job.attempts", { count: job.attemptCount, max: job.maxAttempts })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("job.requestedAt", { date: when(job.createdAt) })}
          {job.finishedAt === null
            ? null
            : ` · ${t("job.finishedAt", { date: when(job.finishedAt) })}`}
        </p>

        {job.state === "READY_FOR_REVIEW" ? (
          <p className="text-sm" data-testid="video-job-review-hint">
            {t("job.review")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {active && configured ? (
            <ActionButton
              action={submitVideoRefresh.bind(null, slug, locale, job.id)}
              label={t("job.refresh")}
              testId="video-job-refresh"
            />
          ) : null}
          {job.state === "READY_FOR_REVIEW" ? (
            <>
              <ActionButton
                action={submitVideoReview.bind(null, slug, locale, job.id, "accept")}
                label={t("job.accept")}
                variant="default"
                testId="video-job-accept"
              />
              <ActionButton
                action={submitVideoReview.bind(null, slug, locale, job.id, "reject")}
                label={t("job.reject")}
                testId="video-job-reject"
              />
            </>
          ) : null}
          {showResult && result.downloadable ? (
            <Button asChild variant="outline" size="sm">
              <a
                href={`/api/w/${slug}/videos/${result.videoId}`}
                download
                data-testid="video-job-download"
              >
                <Download aria-hidden="true" />
                {t("job.download")}
              </a>
            </Button>
          ) : null}
          {configured && REGENERABLE.includes(job.state) ? (
            <ActionButton
              action={submitVideoRegenerate.bind(null, slug, locale, job.id)}
              label={t("job.regenerate")}
              variant="ghost"
              testId="video-job-regenerate"
            />
          ) : null}
        </div>

        <details className="rounded-lg border p-3 text-sm" data-testid="video-job-brief">
          <summary className="cursor-pointer font-medium">{t("job.brief")}</summary>
          <p className="mt-2 whitespace-pre-line text-muted-foreground" dir="auto">
            {job.prompt}
          </p>
        </details>
      </div>
    </div>
  );
}

export function Gallery({
  slug,
  locale,
  jobs,
  selectedId,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly jobs: VideoGeneratePage["jobs"];
  readonly selectedId: string | null;
}) {
  const t = useTranslations("ai.videos.generate");
  if (jobs.length === 0) {
    return <EmptyState message={t("gallery.empty")} testId="video-jobs-empty" />;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="video-jobs">
      {jobs.map((job) => {
        const selected = job.id === selectedId;
        return (
          <li
            key={job.id}
            className={cn(
              "flex flex-col gap-3 rounded-xl border bg-card p-3",
              selected && "border-primary",
            )}
            data-testid="video-jobs-item"
            data-job-id={job.id}
            data-state={job.state}
          >
            <Link
              href={`/w/${slug}/ai/videos/generate?job=${job.id}`}
              aria-current={selected ? "page" : undefined}
              className="flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-md bg-feature text-feature-foreground",
                  job.aspectRatio === "9:16" ? "h-14 w-8" : "h-9 w-16",
                )}
              >
                {ACTIVE.includes(job.state) ? (
                  <LiveDot />
                ) : (
                  <Clapperboard className="size-4 opacity-80" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{job.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {job.durationSeconds} s · {job.resolution} · {job.aspectRatio}
                  {job.placeholder ? ` · ${t("preview.placeholder")}` : ""}
                </span>
              </span>
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATE_TONES[job.state]}>{t(`state.${job.state}`)}</Badge>
              {selected ? (
                <span className="text-xs text-muted-foreground">{t("gallery.selected")}</span>
              ) : null}
            </div>
            {job.state === "READY_FOR_REVIEW" ? (
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  action={submitVideoReview.bind(null, slug, locale, job.id, "accept")}
                  label={t("job.accept")}
                  variant="default"
                  testId="gallery-accept"
                />
                <ActionButton
                  action={submitVideoReview.bind(null, slug, locale, job.id, "reject")}
                  label={t("job.reject")}
                  testId="gallery-reject"
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const STEPS = [
  { key: "brief", available: true },
  { key: "script", available: false },
  { key: "generate", available: true },
  { key: "review", available: true },
  { key: "edit", available: false },
  { key: "versions", available: false },
] as const;

/** The intended workflow; steps that do not exist yet are marked "Planned", not hidden. */
export function WorkflowRail() {
  const t = useTranslations("ai.videos.generate");
  return (
    <nav aria-label={t("workflow.label")} data-testid="video-workflow">
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((step, index) => (
          <li
            key={step.key}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm",
              step.available ? "bg-card" : "border-dashed text-muted-foreground",
            )}
            data-step={step.key}
            data-available={step.available}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-xs font-semibold",
                step.available ? "bg-primary text-primary-foreground" : "bg-muted",
              )}
            >
              {index + 1}
            </span>
            {t(`workflow.steps.${step.key}`)}
            <span className="text-xs text-muted-foreground">
              · {step.available ? t("workflow.available") : t("workflow.planned")}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

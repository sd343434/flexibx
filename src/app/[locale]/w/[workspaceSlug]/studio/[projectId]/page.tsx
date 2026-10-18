import { randomUUID } from "node:crypto";

import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  Detail,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getStudioProject } from "@/server/creator/creator-actions";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";
import {
  submitCancelJob,
  submitClip,
  submitExport,
  submitNewClip,
  submitRetryJob,
  submitReview,
  submitSegment,
  submitTranscription,
  submitTranslation,
} from "../actions";
import { AutoRefresh } from "../auto-refresh";
import { SegmentRow } from "../segment-row";
import {
  CLIP_STATUS_TONES,
  EXPORT_STATUS_TONES,
  JOB_STATE_TONES,
  PROJECT_STATUS_TONES,
  SOURCE_STATUS_TONES,
} from "../status-tones";
import { formatTimestamp, secondsInput } from "../time-format";
import { UploadPanel } from "../upload-panel";

// One Creator Studio project: upload → analysis → transcript (+ translations) → suggested
// clips → review → export. Simulated text is labelled wherever it appears; costs are shown
// before anything is requested; every button calls the server, which re-checks it all.

const TRANSLATION_TARGETS = ["ar", "en", "fr", "es", "tr", "ur"] as const;
const RTL_LANGUAGES = new Set(["ar", "ur", "fa", "he"]);
const ASPECTS = ["PORTRAIT_9_16", "LANDSCAPE_16_9", "SQUARE_1_1"] as const;

const textDir = (language: string | null) =>
  language === null ? "auto" : RTL_LANGUAGES.has(language.split("-")[0] ?? "") ? "rtl" : "ltr";

export default async function StudioProjectRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly projectId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { projectId } = await params;
  const t = await getTranslations({ locale, namespace: "studio" });
  const format = await getFormatter({ locale });
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return <ForbiddenNotice title={t("title")} message={t("notFound")} />;
  }
  const data = await guardPage(getStudioProject(workspace.slug, projectId));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;

  const slug = workspace.slug;
  const api = `/api/w/${encodeURIComponent(slug)}/studio`;
  const { project, source, estimate, provider } = data;
  const original = data.transcripts.find((row) => row.kind === "ORIGINAL") ?? null;
  const translations = data.transcripts.filter((row) => row.kind === "TRANSLATION");
  const activeJobs = data.jobs.filter((job) => job.state === "QUEUED" || job.state === "RUNNING");
  const busySource = data.sources.some((row) => row.status === "UPLOADED");
  const pendingUpload = data.sources.some((row) => row.status === "PENDING_UPLOAD");
  const transcribing = activeJobs.some((job) => job.kind === "TRANSCRIBE");
  const dateTime = (at: Date) => format.dateTime(at, { dateStyle: "medium", timeStyle: "short" });
  const failure = (code: string | null) => (code === null ? null : t(`failures.${code}` as never));
  const transcriptLabel = (row: { readonly language: string | null; readonly kind: string }) =>
    `${t(`transcriptKind.${row.kind}` as never)} · ${row.language ?? t("transcript.languageUnknown")}`;
  const simulatedBadge = (testId: string) => (
    <Badge tone="danger" testId={testId}>
      {t("simulated.badge")}
    </Badge>
  );

  return (
    <div className="space-y-8">
      <AutoRefresh active={activeJobs.length > 0 || busySource} />
      <div className="space-y-2">
        <Link href={`/w/${slug}/studio`} className="text-sm text-muted-foreground hover:underline">
          {t("back")}
        </Link>
        <PageHeader
          title={project.name}
          {...(project.description === null ? {} : { description: project.description })}
          actions={
            <Badge
              tone={PROJECT_STATUS_TONES[project.status]}
              testId={`studio-status-${project.status}`}
            >
              {t(`projectStatus.${project.status}`)}
            </Badge>
          }
        />
      </div>

      {provider === null ? (
        <Notice testId="studio-provider-disabled">{t("provider.disabled")}</Notice>
      ) : provider.simulated ? (
        <Notice testId="studio-provider-simulated">{t("provider.simulated")}</Notice>
      ) : null}

      {/* ── Source ─────────────────────────────────────────────────────────── */}
      <Card title={t("source.title")} testId="studio-source">
        {source === null && data.canCreate && !busySource && !pendingUpload ? (
          <UploadPanel
            slug={slug}
            locale={locale}
            projectId={project.id}
            maxBytes={data.limits.maxUploadBytes}
          />
        ) : null}
        {source === null && pendingUpload ? <Notice>{t("source.pending")}</Notice> : null}
        {busySource ? (
          <Notice testId="studio-source-checking">{t("source.checking")}</Notice>
        ) : null}
        {source === null ? (
          <p className="text-sm text-muted-foreground">
            {t("source.limits", { minutes: Math.floor(data.limits.maxDurationMs / 60_000) })}
          </p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-4" data-testid="studio-source-details">
            <Detail label={t("source.file")}>{source.originalName}</Detail>
            <Detail label={t("source.duration")}>
              <span dir="ltr">
                {source.durationMs === null ? "—" : formatTimestamp(source.durationMs)}
              </span>
            </Detail>
            <Detail label={t("source.dimensions")}>
              <span dir="ltr">
                {source.width === null || source.height === null
                  ? t("source.audioOnly")
                  : `${source.width}×${source.height}`}
              </span>
            </Detail>
            <Detail label={t("source.tracks")}>
              {[
                source.hasVideo ? t("source.video") : null,
                source.hasAudio ? t("source.audio") : null,
              ]
                .filter(Boolean)
                .join(" + ")}
            </Detail>
          </dl>
        )}
        {data.sources.length > 0 ? (
          <ul className="space-y-1 text-sm" data-testid="studio-source-history">
            {data.sources.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={SOURCE_STATUS_TONES[row.status]}
                  testId={`studio-source-status-${row.status}`}
                >
                  {t(`sourceStatus.${row.status}` as never)}
                </Badge>
                <span className="break-all">{row.originalName}</span>
                {row.rejectionCode === null ? null : (
                  <span className="text-destructive" data-testid="studio-source-rejection">
                    {failure(row.rejectionCode)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {/* ── Transcription ──────────────────────────────────────────────────── */}
      <Card title={t("transcript.title")} testId="studio-transcript">
        {source === null ? (
          <EmptyState message={t("transcript.needsSource")} testId="studio-transcript-empty" />
        ) : original === null ? (
          transcribing ? (
            <Notice testId="studio-transcribing">{t("transcript.running")}</Notice>
          ) : provider === null || !source.hasAudio ? (
            <Notice>{provider === null ? t("provider.disabled") : t("failures.no_audio")}</Notice>
          ) : data.canCreate ? (
            <div className="space-y-3">
              <p className="text-sm" data-testid="studio-estimate">
                {estimate.transcriptionCredits === 0
                  ? t("estimate.free", { minutes: estimate.minutes ?? 0 })
                  : t("estimate.transcription", {
                      minutes: estimate.minutes ?? 0,
                      credits: estimate.transcriptionCredits,
                    })}
              </p>
              <EntityForm
                action={submitTranscription.bind(null, slug, locale, project.id)}
                testId="studio-transcribe-form"
                submitLabel={t("transcript.start")}
                pendingLabel={t("common.requesting")}
                fields={[
                  {
                    kind: "select",
                    name: "language",
                    label: t("transcript.language"),
                    emptyLabel: t("transcript.autoDetect"),
                    options: [
                      { value: "ar", label: t("languages.ar") },
                      { value: "en", label: t("languages.en") },
                    ],
                  },
                ]}
              >
                <input type="hidden" name="requestKey" value={randomUUID()} />
              </EntityForm>
            </div>
          ) : (
            <EmptyState message={t("transcript.none")} />
          )
        ) : (
          <div className="space-y-6">
            {[original, ...translations].map((transcript) => (
              <section
                key={transcript.id}
                className="space-y-3"
                data-testid={`studio-transcript-${transcript.kind}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{transcriptLabel(transcript)}</h3>
                  {transcript.simulated ? simulatedBadge("studio-transcript-simulated") : null}
                  <span className="text-xs text-muted-foreground">
                    {t("transcript.segments", { count: transcript.segmentCount })}
                  </span>
                  <a
                    className="text-sm underline"
                    href={`${api}/transcripts/${transcript.id}?format=srt`}
                    data-testid="studio-download-srt"
                  >
                    SRT
                  </a>
                  <a
                    className="text-sm underline"
                    href={`${api}/transcripts/${transcript.id}?format=vtt`}
                  >
                    VTT
                  </a>
                </div>
                {transcript.simulated ? <Notice>{t("simulated.transcript")}</Notice> : null}
                <ol className="max-h-[28rem] divide-y overflow-y-auto rounded-md border px-3">
                  {transcript.segments.map((segment) => (
                    <SegmentRow
                      key={segment.id}
                      action={submitSegment.bind(null, slug, locale, segment.id)}
                      startMs={segment.startMs}
                      endMs={segment.endMs}
                      text={segment.text}
                      edited={segment.edited}
                      canEdit={data.canEdit}
                      dir={textDir(transcript.language)}
                    />
                  ))}
                </ol>
              </section>
            ))}
            {data.canCreate && provider !== null ? (
              <div className="space-y-2 border-t pt-4">
                <h3 className="font-semibold">{t("translate.title")}</h3>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="studio-translate-estimate"
                >
                  {estimate.translationCreditsPerLanguage === 0
                    ? t("estimate.free", { minutes: estimate.minutes ?? 0 })
                    : t("estimate.translation", {
                        minutes: estimate.minutes ?? 0,
                        credits: estimate.translationCreditsPerLanguage,
                      })}
                </p>
                <EntityForm
                  action={submitTranslation.bind(null, slug, locale, original.id)}
                  testId="studio-translate-form"
                  submitLabel={t("translate.submit")}
                  pendingLabel={t("common.requesting")}
                  fields={[
                    {
                      kind: "select",
                      name: "targetLanguage",
                      label: t("translate.target"),
                      options: TRANSLATION_TARGETS.filter(
                        (code) =>
                          code !== original.language &&
                          !translations.some((row) => row.language === code),
                      ).map((code) => ({ value: code, label: t(`languages.${code}`) })),
                    },
                  ]}
                >
                  <input type="hidden" name="requestKey" value={randomUUID()} />
                </EntityForm>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {/* ── Clips ──────────────────────────────────────────────────────────── */}
      <Card title={t("clips.title")} testId="studio-clips">
        <p className="text-sm text-muted-foreground">{t("clips.explain")}</p>
        {data.clips.length === 0 ? (
          <EmptyState
            message={original === null ? t("clips.needsTranscript") : t("clips.empty")}
            testId="studio-clips-empty"
          />
        ) : (
          <ul className="space-y-6">
            {data.clips.map((clip) => {
              const clipExports = data.exports.filter((row) => row.clipId === clip.id);
              return (
                <li
                  key={clip.id}
                  className="space-y-3 rounded-md border p-4"
                  data-testid="studio-clip"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold break-words">{clip.title}</h3>
                    <Badge
                      tone={CLIP_STATUS_TONES[clip.status]}
                      testId={`studio-clip-status-${clip.status}`}
                    >
                      {t(`clipStatus.${clip.status}` as never)}
                    </Badge>
                    {clip.simulated ? simulatedBadge("studio-clip-simulated") : null}
                    <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                      {formatTimestamp(clip.startMs)} → {formatTimestamp(clip.endMs)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`clipOrigin.${clip.origin}` as never)}
                      {` · ${t("clips.score", { score: clip.score })}`}
                    </span>
                  </div>
                  {clip.reasons.length > 0 ? (
                    <div className="flex flex-wrap gap-1" data-testid="studio-clip-reasons">
                      {clip.reasons.map((reason) => (
                        <Badge key={reason} tone="soft">
                          {t(`reasons.${reason}` as never)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <p
                    className="text-sm text-muted-foreground"
                    dir={textDir(original?.language ?? null)}
                  >
                    {clip.text}
                  </p>
                  {data.canEdit ? (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        {t("clips.edit")}
                      </summary>
                      <div className="pt-3">
                        <EntityForm
                          action={submitClip.bind(null, slug, locale, clip.id, clip.version)}
                          testId="studio-clip-form"
                          submitLabel={t("common.save")}
                          fields={[
                            {
                              kind: "text",
                              name: "title",
                              label: t("clips.titleField"),
                              defaultValue: clip.title,
                              maxLength: 200,
                              wide: true,
                            },
                            {
                              kind: "text",
                              name: "start",
                              label: t("time.startSeconds"),
                              defaultValue: secondsInput(clip.startMs),
                              dir: "ltr",
                            },
                            {
                              kind: "text",
                              name: "end",
                              label: t("time.endSeconds"),
                              defaultValue: secondsInput(clip.endMs),
                              dir: "ltr",
                            },
                            {
                              kind: "number",
                              name: "cropX",
                              label: t("clips.cropX"),
                              hint: t("clips.cropHint"),
                              defaultValue: String(clip.cropX),
                            },
                          ]}
                        />
                        <p className="pt-2 text-xs text-muted-foreground">
                          {t("clips.editResetsReview")}
                        </p>
                      </div>
                    </details>
                  ) : null}
                  {data.canApprove && clip.status !== "APPROVED" ? (
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        action={submitReview.bind(
                          null,
                          slug,
                          locale,
                          clip.id,
                          clip.version,
                          "APPROVED",
                        )}
                        label={t("clips.approve")}
                        variant="default"
                        testId="studio-clip-approve"
                      />
                      {clip.status === "SUGGESTED" ? (
                        <ActionButton
                          action={submitReview.bind(
                            null,
                            slug,
                            locale,
                            clip.id,
                            clip.version,
                            "REJECTED",
                          )}
                          label={t("clips.reject")}
                          testId="studio-clip-reject"
                        />
                      ) : null}
                    </div>
                  ) : null}
                  {clip.status !== "APPROVED" ? (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="studio-export-blocked"
                    >
                      {t("export.needsApproval")}
                    </p>
                  ) : source?.hasVideo !== true ? (
                    <p className="text-xs text-muted-foreground">{t("failures.no_video")}</p>
                  ) : data.canCreate ? (
                    <div className="space-y-2 border-t pt-3">
                      <p className="text-sm" data-testid="studio-export-estimate">
                        {t("estimate.export", {
                          credits:
                            Math.max(1, Math.ceil((clip.endMs - clip.startMs) / 60_000)) *
                            estimate.exportCreditsPerMinute,
                        })}
                      </p>
                      <EntityForm
                        action={submitExport.bind(null, slug, locale, clip.id)}
                        testId="studio-export-form"
                        submitLabel={t("export.submit")}
                        pendingLabel={t("common.requesting")}
                        fields={[
                          {
                            kind: "select",
                            name: "aspectRatio",
                            label: t("export.aspect"),
                            defaultValue: "PORTRAIT_9_16",
                            options: ASPECTS.map((value) => ({
                              value,
                              label: t(`aspect.${value}`),
                            })),
                          },
                          {
                            kind: "select",
                            name: "subtitleTranscriptId",
                            label: t("export.subtitles"),
                            emptyLabel: t("export.noSubtitles"),
                            options: data.transcripts.map((row) => ({
                              value: row.id,
                              label: `${transcriptLabel(row)}${row.simulated ? ` (${t("simulated.badge")})` : ""}`,
                            })),
                          },
                        ]}
                      >
                        <input type="hidden" name="requestKey" value={randomUUID()} />
                      </EntityForm>
                    </div>
                  ) : null}
                  {clipExports.length > 0 ? (
                    <ul className="space-y-1 text-sm" data-testid="studio-exports">
                      {clipExports.map((row) => (
                        <li
                          key={row.id}
                          className="flex flex-wrap items-center gap-2"
                          data-testid="studio-export"
                        >
                          <Badge
                            tone={EXPORT_STATUS_TONES[row.status]}
                            testId={`studio-export-status-${row.status}`}
                          >
                            {t(`exportStatus.${row.status}` as never)}
                          </Badge>
                          <span>{t(`aspect.${row.aspectRatio}`)}</span>
                          {row.burnSubtitles ? <span>· {t("export.withSubtitles")}</span> : null}
                          {row.status === "READY" ? (
                            <a
                              className="underline"
                              href={`${api}/exports/${row.id}`}
                              data-testid="studio-export-download"
                            >
                              {t("export.download")}
                            </a>
                          ) : null}
                          {row.failureCode === null ? null : (
                            <span className="text-destructive">{failure(row.failureCode)}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {data.canEdit && original !== null ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t("clips.add")}</summary>
            <div className="pt-3">
              <EntityForm
                action={submitNewClip.bind(null, slug, locale, project.id)}
                testId="studio-new-clip-form"
                submitLabel={t("clips.addSubmit")}
                fields={[
                  {
                    kind: "text",
                    name: "title",
                    label: t("clips.titleField"),
                    maxLength: 200,
                    wide: true,
                    required: true,
                  },
                  {
                    kind: "text",
                    name: "start",
                    label: t("time.startSeconds"),
                    dir: "ltr",
                    required: true,
                  },
                  {
                    kind: "text",
                    name: "end",
                    label: t("time.endSeconds"),
                    dir: "ltr",
                    required: true,
                  },
                ]}
              />
            </div>
          </details>
        ) : null}
      </Card>

      {/* ── Jobs and log ───────────────────────────────────────────────────── */}
      <Card title={t("jobs.title")} testId="studio-jobs">
        {data.jobs.length === 0 ? (
          <EmptyState message={t("jobs.empty")} testId="studio-jobs-empty" />
        ) : (
          <ul className="divide-y">
            {data.jobs.map((job) => (
              <li key={job.id} className="space-y-2 py-3" data-testid="studio-job">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t(`jobKind.${job.kind}` as never)}</span>
                  <Badge tone={JOB_STATE_TONES[job.state]} testId={`studio-job-state-${job.state}`}>
                    {t(`jobState.${job.state}` as never)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("jobs.attempts", { attempts: job.attempts, max: job.maxAttempts })} ·{" "}
                    {dateTime(job.createdAt)}
                  </span>
                </div>
                <ol className="flex flex-wrap gap-2 text-xs">
                  {job.steps.map((step) => (
                    <li
                      key={step.stage}
                      className="flex items-center gap-1 rounded border px-2 py-1"
                    >
                      {t(`stage.${step.stage}` as never)}: {t(`stepState.${step.state}` as never)}
                      {step.simulated ? ` · ${t("simulated.badge")}` : ""}
                    </li>
                  ))}
                </ol>
                {job.failureCode === null ? null : (
                  <p className="text-sm text-destructive" data-testid="studio-job-failure">
                    {failure(job.failureCode)}
                  </p>
                )}
                {job.state === "QUEUED" && job.attempts > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("jobs.retryAt", { at: dateTime(job.runAfter) })}
                  </p>
                ) : null}
                {data.canCreate ? (
                  <div className="flex flex-wrap gap-2">
                    {job.state === "QUEUED" || job.state === "RUNNING" ? (
                      <ActionButton
                        action={submitCancelJob.bind(null, slug, locale, job.id)}
                        label={t("jobs.cancel")}
                        confirm={t("jobs.cancelConfirm")}
                        danger
                        testId="studio-job-cancel"
                      />
                    ) : null}
                    {job.state === "FAILED" || job.state === "CANCELLED" ? (
                      <ActionButton
                        action={submitRetryJob.bind(null, slug, locale, job.id)}
                        label={t("jobs.retry")}
                        testId="studio-job-retry"
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {data.events.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t("jobs.log")}</summary>
            <ol className="space-y-1 pt-2 text-sm" data-testid="studio-events">
              {data.events.map((event) => {
                const meta = (event.metadata ?? {}) as Record<string, unknown>;
                return (
                  <li key={event.id} className="flex flex-wrap gap-2">
                    <span className="text-xs text-muted-foreground">
                      {dateTime(event.createdAt)}
                    </span>
                    <span>{t(`events.${event.type}` as never)}</span>
                    {typeof meta.kind === "string" ? (
                      <span>· {t(`jobKind.${meta.kind}` as never)}</span>
                    ) : null}
                    {typeof meta.failure === "string" ? (
                      <span className="text-destructive">· {failure(meta.failure)}</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </details>
        ) : null}
      </Card>
    </div>
  );
}

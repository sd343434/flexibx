import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm, inputClass } from "@/components/marketing/entity-form";
import {
  Badge,
  CONTENT_STATUS_TONES,
  Card,
  Detail,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { contentMetadata } from "@/server/marketing/content-service";
import { getContentPage } from "@/server/marketing/marketing-queries";
import { utcToZonedLocal } from "@/server/marketing/time";

import { contentFields } from "../../form-fields";
import {
  submitContent,
  submitContentTransition,
  submitDeleteContent,
  submitReschedule,
} from "../../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../page-data";

export default async function ContentRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly contentId: string }>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const { contentId } = await params;
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getContentPage(workspace.slug, contentId));
  if (data === null) {
    return <ForbiddenNotice title={t("content.title")} message={t("common.forbidden")} />;
  }
  const { content, timeZone } = data;
  const when = (value: Date) =>
    format.dateTime(value, { dateStyle: "medium", timeStyle: "short", timeZone });
  const metadata = contentMetadata(content.metadata);
  const plannedLocal =
    content.scheduledAt === null ? "" : utcToZonedLocal(content.scheduledAt, timeZone);
  const slug = workspace.slug;

  return (
    <div className="space-y-8">
      <PageHeader
        title={content.title}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/w/${slug}/content`}>{t("common.back")}</Link>
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge tone={CONTENT_STATUS_TONES[content.status]} testId="content-status">
          {t(`enums.contentStatus.${content.status}`)}
        </Badge>
        <span>{t(`enums.contentType.${content.type}`)}</span>
        {content.status === "PUBLISHED" && content.publishedAt !== null ? (
          <span>{t("content.publishedAt", { date: when(content.publishedAt) })}</span>
        ) : content.scheduledAt === null ? null : (
          <span data-testid="content-when">
            {content.status === "SCHEDULED"
              ? t("content.scheduledFor", { date: when(content.scheduledAt) })
              : t("content.plannedFor", { date: when(content.scheduledAt) })}
          </span>
        )}
        {content.createdBy === null ? null : (
          <span>{t("content.createdBy", { name: content.createdBy.name })}</span>
        )}
      </div>

      <Card title={t("content.workflowTitle")} testId="content-workflow">
        <p className="text-sm text-muted-foreground">{t("content.workflowHint")}</p>
        {content.transitions.length === 0 ? (
          <Notice testId="no-transitions">{t("content.noTransitions")}</Notice>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            {content.transitions.map((transition) => (
              <ActionButton
                key={transition}
                action={submitContentTransition.bind(null, slug, locale, content.id, transition)}
                label={t(`enums.transition.${transition}`)}
                variant={
                  transition === "approve" || transition === "submit" ? "default" : "outline"
                }
                testId={`transition-${transition}`}
              >
                {transition === "schedule" ? (
                  <label className="space-y-1 text-sm font-medium">
                    <span className="block">{t("content.scheduleAt", { zone: timeZone })}</span>
                    <input
                      type="datetime-local"
                      name="scheduledAt"
                      dir="ltr"
                      defaultValue={plannedLocal}
                      className={cn(inputClass, "h-9")}
                      data-testid="schedule-at"
                    />
                  </label>
                ) : null}
              </ActionButton>
            ))}
          </div>
        )}
        {content.transitions.includes("publish") ? (
          <p className="text-xs text-muted-foreground">{t("content.externalNotice")}</p>
        ) : null}
      </Card>

      {content.canReschedule ? (
        <Card title={t("content.rescheduleTitle")}>
          <p className="text-sm text-muted-foreground">
            {t("content.rescheduleHint", { zone: timeZone })}
          </p>
          <ActionButton
            action={submitReschedule.bind(null, slug, locale, content.id)}
            label={t("content.reschedule")}
            testId="content-reschedule"
          >
            <input
              type="datetime-local"
              name="scheduledAt"
              dir="ltr"
              aria-label={t("content.rescheduleTitle")}
              defaultValue={plannedLocal}
              className={cn(inputClass, "h-9 w-auto")}
            />
          </ActionButton>
        </Card>
      ) : null}

      {content.canEdit && data.options !== null ? (
        <Card title={t("content.editTitle")}>
          <EntityForm
            action={submitContent.bind(null, slug, locale, content.id)}
            fields={contentFields(t, content, data.options, timeZone)}
            submitLabel={t("content.submitUpdate")}
            testId="content-form"
          />
        </Card>
      ) : (
        <Card title={t("content.details")} testId="content-details">
          {content.status === "DRAFT" ? null : <Notice>{t("content.lockedNotice")}</Notice>}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">{t("content.body")}</h3>
            <p className="break-words whitespace-pre-line" dir="auto">
              {content.body === "" ? t("content.noBody") : content.body}
            </p>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label={t("content.fields.campaignId")}>
              {content.campaign?.name ?? t("common.none")}
            </Detail>
            <Detail label={t("content.fields.pillarId")}>
              {content.pillar?.name ?? t("common.none")}
            </Detail>
            <Detail label={t("content.fields.audienceId")}>
              {content.audience?.name ?? t("common.none")}
            </Detail>
            <Detail label={t("content.fields.goalId")}>
              {content.goal?.title ?? t("common.none")}
            </Detail>
            {metadata.callToAction === null ? null : (
              <Detail label={t("content.fields.callToAction")}>{metadata.callToAction}</Detail>
            )}
            {metadata.link === null ? null : (
              <Detail label={t("content.fields.link")}>
                <span dir="ltr">{metadata.link}</span>
              </Detail>
            )}
            {metadata.hashtags.length === 0 ? null : (
              <Detail label={t("content.fields.hashtags")}>{metadata.hashtags.join(" ")}</Detail>
            )}
            {content.notes === null ? null : (
              <Detail label={t("content.fields.notes")}>{content.notes}</Detail>
            )}
          </dl>
        </Card>
      )}

      {content.assets.length === 0 ? null : (
        <Card title={t("content.assets")}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="content-assets">
            {content.assets.map(({ mediaAsset }) => (
              <li key={mediaAsset.id} className="overflow-hidden rounded-md border">
                {/* eslint-disable-next-line @next/next/no-img-element -- access-checked API route, not an optimizable static asset */}
                <img
                  src={`/api/w/${slug}/media/${mediaAsset.id}`}
                  alt={mediaAsset.altText ?? ""}
                  width={mediaAsset.width ?? undefined}
                  height={mediaAsset.height ?? undefined}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {content.canDelete ? (
        <Card title={t("content.deleteTitle")} className="border-destructive/40">
          <ActionButton
            action={submitDeleteContent.bind(null, slug, locale, content.id)}
            label={t("content.delete")}
            confirm={t("content.deleteConfirm")}
            danger
            testId="content-delete"
          />
        </Card>
      ) : null}
    </div>
  );
}

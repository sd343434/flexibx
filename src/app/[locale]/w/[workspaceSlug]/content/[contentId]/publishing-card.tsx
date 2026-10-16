import { getFormatter, getTranslations } from "next-intl/server";

import type { Locale } from "@/i18n/config";
import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import { Badge, Card } from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import {
  publicationDisplayState,
  publicationErrorKind,
  type PublishingBlocker,
} from "@/server/social/publishing-readiness";
import { getContentPublishing } from "@/server/social/social-actions";

import { submitCancelPost, submitQueuePost, submitResolvePost } from "../../social/actions";

/** Where a person fixes each reason posts are held (none: an operator or the scheduler). */
const FIX: Partial<Record<PublishingBlocker, { path: string; label: "fixAds" | "fixAutopilot" }>> =
  {
    not_connected: { path: "ads", label: "fixAds" },
    connection_expired: { path: "ads", label: "fixAds" },
    emergency_stop: { path: "autopilot", label: "fixAutopilot" },
  };

/**
 * Publish this content to a Facebook Page at its scheduled time, or at the scheduler's
 * next run (publishing is never instant: the automation tick publishes). Only approved
 * or scheduled content can be queued; the server re-checks the approval right before it
 * publishes, and a lost answer is looked up on the Page instead of posting twice.
 * Posts that still need attention are always listed; settled ones a page at a time
 * (`?posts=<last id shown>`). When the server would hold queued posts (sending switched
 * off, no Meta setup or connection, the emergency stop, a scheduler that is not running),
 * the card says so and due posts show why they wait instead of a plain "Scheduled".
 */
export async function PublishingCard({
  slug,
  locale,
  contentId,
  status,
  timeZone,
  historyAfter,
}: {
  readonly slug: string;
  readonly locale: Locale;
  readonly contentId: string;
  readonly status: string;
  readonly timeZone: string;
  readonly historyAfter?: string | undefined;
}) {
  const data = await getContentPublishing(slug, contentId, historyAfter);
  if (data === null) return null;
  const t = await getTranslations({ locale, namespace: "social.publishing" });
  const format = await getFormatter({ locale });
  const when = (value: Date) =>
    format.dateTime(value, { dateStyle: "medium", timeStyle: "short", timeZone });
  const queueable = status === "APPROVED" || status === "SCHEDULED";
  const { blockers, schedulerLastRunAt } = data.readiness;
  const onHold = blockers.length > 0;
  const row = (post: (typeof data.open)[number]) => {
    const state = publicationDisplayState(post, data.now, blockers);
    return (
      <li
        key={post.id}
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
        data-testid="content-post"
        data-status={post.status}
        data-state={state}
      >
        <span>
          {post.channel.name} ·{" "}
          {post.publishedAt === null ? when(post.scheduledAt) : when(post.publishedAt)}
          {post.withImage ? <> · {t("withImage")}</> : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={state === "published" ? "solid" : "outline"}>{t(`display.${state}`)}</Badge>
          {state === "queued" || state === "on_hold" ? (
            <span
              className={onHold ? "text-destructive" : "text-muted-foreground"}
              data-testid="content-post-due"
            >
              {blockers[0] === undefined ? t("dueNext") : t(`onHold.${blockers[0]}`, { last })}
            </span>
          ) : null}
          {state === "published" && post.externalPostId !== null ? (
            <span className="text-muted-foreground" data-testid="content-post-ref">
              {t("publishedRef", { id: post.externalPostId })}{" "}
              <a
                href={`https://www.facebook.com/${encodeURIComponent(post.externalPostId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {t("viewOnFacebook")}
              </a>
            </span>
          ) : null}
          {state === "uncertain" ? (
            <span className="text-muted-foreground" data-testid="content-post-uncertain">
              {t("uncertainHint")}
            </span>
          ) : null}
          {post.errorCode === null ? null : (
            <span className="text-destructive" data-testid="content-post-error">
              {t(`errors.${publicationErrorKind(post.errorCode) ?? "other"}`)}
            </span>
          )}
          {data.canPublish && (post.status === "SCHEDULED" || post.status === "FAILED") ? (
            <ActionButton
              action={submitCancelPost.bind(null, slug, locale, contentId, post.id)}
              label={t("cancel")}
            />
          ) : null}
          {data.canPublish && post.status === "UNCERTAIN" ? (
            <ActionButton
              action={submitResolvePost.bind(null, slug, locale, contentId, post.id)}
              label={t("check")}
            />
          ) : null}
        </span>
      </li>
    );
  };
  const base = `/w/${slug}/content/${contentId}`;
  const last = schedulerLastRunAt === null ? t("onHold.never") : when(schedulerLastRunAt);

  return (
    <Card title={t("title")} testId="content-publishing">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      {onHold ? (
        <div
          role="status"
          className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm"
          data-testid="content-publishing-on-hold"
        >
          <p className="font-medium">{t("onHold.title")}</p>
          <p>{t("onHold.intro")}</p>
          <ul className="list-disc space-y-1 ps-5">
            {blockers.map((blocker) => {
              const fix = FIX[blocker];
              return (
                <li key={blocker} data-testid="content-publishing-blocker" data-blocker={blocker}>
                  {t(`onHold.${blocker}`, { last })}{" "}
                  {fix === undefined ? null : (
                    <Link href={`/w/${slug}/${fix.path}`} className="underline">
                      {t(`onHold.${fix.label}`)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground">{t("onHold.missedWindow")}</p>
        </div>
      ) : null}
      {data.open.length === 0 ? null : (
        <ul className="space-y-2 text-sm" data-testid="content-posts-open">
          {data.open.map(row)}
        </ul>
      )}
      {data.openTotal > data.open.length ? (
        <p className="text-sm text-muted-foreground" data-testid="content-posts-open-more">
          {t("moreOpen", { count: data.openTotal - data.open.length })}
        </p>
      ) : null}
      {data.history.length === 0 ? null : (
        <ul className="space-y-2 text-sm" data-testid="content-posts-history">
          {data.history.map(row)}
        </ul>
      )}
      {historyAfter === undefined && data.nextHistoryAfter === null ? null : (
        <p className="flex gap-4 text-sm">
          {historyAfter === undefined ? null : <Link href={base}>{t("newest")}</Link>}
          {data.nextHistoryAfter === null ? null : (
            <Link href={`${base}?posts=${data.nextHistoryAfter}`} data-testid="content-posts-older">
              {t("older")}
            </Link>
          )}
        </p>
      )}
      {!data.canPublish ? null : !queueable ? (
        <p className="text-sm">{t("needsApproval")}</p>
      ) : data.channels.length === 0 ? (
        <p className="text-sm">{t("noPages")}</p>
      ) : (
        <EntityForm
          action={submitQueuePost.bind(null, slug, locale, contentId)}
          fields={[
            {
              kind: "select",
              name: "channelId",
              label: t("page"),
              required: true,
              options: data.channels.map((channel) => ({ value: channel.id, label: channel.name })),
            },
          ]}
          submitLabel={status === "SCHEDULED" ? t("schedule") : t("queueNow")}
          pendingLabel={t("working")}
          testId="content-publish-form"
        />
      )}
      {data.canPublish && queueable && status !== "SCHEDULED" && data.channels.length > 0 ? (
        <p className="text-xs text-muted-foreground">{t("queueNowHint")}</p>
      ) : null}
    </Card>
  );
}

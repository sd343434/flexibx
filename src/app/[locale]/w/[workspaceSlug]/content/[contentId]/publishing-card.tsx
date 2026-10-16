import { getFormatter, getTranslations } from "next-intl/server";

import type { Locale } from "@/i18n/config";
import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import { Badge, Card } from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getContentPublishing } from "@/server/social/social-actions";

import { submitCancelPost, submitQueuePost, submitResolvePost } from "../../social/actions";

/**
 * Publish this content to a Facebook Page at its scheduled time (or now). Only approved
 * or scheduled content can be queued; the server re-checks the approval right before it
 * publishes, and a lost answer is looked up on the Page instead of posting twice.
 * Posts that still need attention are always listed; settled ones a page at a time
 * (`?posts=<last id shown>`).
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
  const row = (post: (typeof data.open)[number]) => (
    <li
      key={post.id}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
      data-testid="content-post"
      data-status={post.status}
    >
      <span>
        {post.channel.name} ·{" "}
        {post.publishedAt === null ? when(post.scheduledAt) : when(post.publishedAt)}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={post.status === "PUBLISHED" ? "solid" : "outline"}>
          {t(`status.${post.status as "SCHEDULED"}`)}
        </Badge>
        {post.errorCode === null ? null : (
          <span className="text-destructive">
            {t.has(`errors.${post.errorCode}` as never)
              ? t(`errors.${post.errorCode}` as "errors.other")
              : t("errors.other")}
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
  const base = `/w/${slug}/content/${contentId}`;

  return (
    <Card title={t("title")} testId="content-publishing">
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
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
          submitLabel={status === "SCHEDULED" ? t("schedule") : t("publishNow")}
          pendingLabel={t("working")}
          testId="content-publish-form"
        />
      )}
    </Card>
  );
}

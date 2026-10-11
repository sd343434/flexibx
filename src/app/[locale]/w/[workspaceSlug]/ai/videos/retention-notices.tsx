import { CalendarClock, Info, TriangleAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";

import type { Locale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { getVideoExpiryBanner } from "@/server/videos/video-queries";
import {
  expiresAtFor,
  formatDeletionTime,
  timeZoneLabel,
  VIDEO_RETENTION_HOURS,
} from "@/server/videos/retention-policy";

// Customer-facing retention notices (server components, ar/en). Until an email provider
// is configured these are the only warnings that videos will be deleted.

const DAYS = VIDEO_RETENTION_HOURS / 24;

/** The standing notice at the top of the AI videos page. */
export async function VideoRetentionNotice({
  locale,
  timeZone,
  now,
}: {
  readonly locale: Locale;
  readonly timeZone: string;
  readonly now: Date;
}) {
  const t = await getTranslations({ locale, namespace: "ai.videos" });
  const zone = `${timeZone} (${timeZoneLabel(now, locale, timeZone)})`;
  return (
    <section
      aria-labelledby="video-retention-notice"
      className="flex gap-3 rounded-2xl border border-primary/30 bg-accent px-4 py-4 text-accent-foreground"
      data-testid="video-retention-notice"
    >
      <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="space-y-1 text-sm">
        <h2 id="video-retention-notice" className="font-semibold">
          {t("notice.title", { days: DAYS })}
        </h2>
        <p>{t("notice.body", { days: DAYS, hours: VIDEO_RETENTION_HOURS })}</p>
        <p>{t("notice.download")}</p>
        <p className="text-xs opacity-80" data-testid="video-time-zone">
          {t("notice.timeZone", { zone })}
        </p>
      </div>
    </section>
  );
}

/**
 * Shown before a video is generated: the retention rule and the deletion date a video
 * generated now would get (now + 168 h, in the workspace time zone). Every video
 * generation form must render this above its submit button.
 */
export async function BeforeGenerationNotice({
  locale,
  timeZone,
  now,
}: {
  readonly locale: Locale;
  readonly timeZone: string;
  readonly now: Date;
}) {
  const t = await getTranslations({ locale, namespace: "ai.videos.beforeGeneration" });
  const zone = timeZoneLabel(now, locale, timeZone);
  return (
    <section
      aria-labelledby="video-before-generation"
      className="flex gap-3 rounded-2xl border border-dashed px-4 py-4"
      data-testid="video-before-generation-notice"
    >
      <CalendarClock aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="space-y-1 text-sm">
        <h2 id="video-before-generation" className="font-semibold">
          {t("title")}
        </h2>
        <p>{t("body", { days: DAYS })}</p>
        <p className="font-medium">
          {t("deadline", {
            date: formatDeletionTime(expiresAtFor(now), locale, timeZone),
            zone,
          })}
        </p>
      </div>
    </section>
  );
}

/** AI Studio banner when available videos are deleted within 48 hours. */
export async function VideoExpiryBanner({
  locale,
  slug,
}: {
  readonly locale: Locale;
  readonly slug: string;
}) {
  const data = await getVideoExpiryBanner(slug).catch(() => null);
  if (data === null || data.expiringSoon === 0) return null;
  const t = await getTranslations({ locale, namespace: "ai.videos" });
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/40 bg-accent px-4 py-3 text-sm text-accent-foreground"
      data-testid="video-expiry-banner"
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span>{t("expiringBanner", { count: data.expiringSoon })}</span>
      <Link href={`/w/${slug}/ai/videos`} className="font-medium underline">
        {t("expiringBannerLink")}
      </Link>
    </p>
  );
}

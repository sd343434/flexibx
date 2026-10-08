import { getFormatter, getTranslations } from "next-intl/server";

import type { Locale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import type { ActivityEntry } from "@/server/marketing/overview-service";

const STATUS_NAMESPACES = {
  content: "contentStatus",
  campaign: "campaignStatus",
  goal: "goalStatus",
} as const;

const ENTITY_PATHS: Readonly<Record<string, string>> = {
  content: "content",
  campaign: "campaigns",
  goal: "campaigns/goals",
  pillar: "brand/pillars",
  audience: "brand/audiences",
};

/** Audit entries as sentences ("Sara approved…"), with links to records that still exist. */
export async function ActivityList({
  locale,
  slug,
  entries,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly entries: readonly ActivityEntry[];
}) {
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });

  return (
    <ul className="divide-y rounded-lg border" data-testid="activity-list">
      {entries.map((entry) => {
        const actionKey = `activity.actions.${entry.action.replaceAll(".", "_")}`;
        const action = t.has(actionKey as never)
          ? t(actionKey as never)
          : t("activity.actions.other");
        const statusNamespace = (STATUS_NAMESPACES as Readonly<Record<string, string | undefined>>)[
          entry.entityType
        ];
        const status = (value: string) => {
          const key = `enums.${statusNamespace}.${value}`;
          return statusNamespace !== undefined && t.has(key as never) ? t(key as never) : value;
        };
        const path = ENTITY_PATHS[entry.entityType];
        const deleted = entry.action.endsWith(".deleted");
        return (
          <li
            key={entry.id}
            className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:justify-between"
            data-testid="activity-row"
            data-action={entry.action}
          >
            <p>
              <span className="font-medium">{entry.actor ?? t("activity.unknownActor")}</span>{" "}
              {path === undefined || entry.entityId === null || deleted ? (
                action
              ) : (
                <Link href={`/w/${slug}/${path}/${entry.entityId}`} className="hover:underline">
                  {action}
                </Link>
              )}
              {entry.from === null || entry.to === null ? null : (
                <span className="ms-2 text-muted-foreground">
                  ({t("activity.statusChange", { from: status(entry.from), to: status(entry.to) })})
                </span>
              )}
            </p>
            <time
              dateTime={entry.createdAt.toISOString()}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {format.dateTime(entry.createdAt, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

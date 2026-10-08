import "server-only";

import type { getTranslations } from "next-intl/server";

import type { FieldSpec, Option } from "@/components/marketing/entity-form";
import type { AudienceRow } from "@/server/marketing/audience-service";
import { audienceAttributes } from "@/server/marketing/audience-service";
import type { BrandView } from "@/server/marketing/brand-service";
import type { CampaignDetail } from "@/server/marketing/campaign-service";
import { fromMinorUnits } from "@/server/marketing/campaign-service";
import { contentMetadata, type ContentDetail } from "@/server/marketing/content-service";
import type { GoalRow } from "@/server/marketing/goal-service";
import { ENUM_VALUES } from "@/server/marketing/inputs";
import type { ContentFormOptions, LinkOptions } from "@/server/marketing/marketing-queries";
import type { PillarRow } from "@/server/marketing/pillar-service";
import { utcToZonedLocal } from "@/server/marketing/time";

import { dateInput, linesInput } from "./page-data";

// Form field definitions for the Marketing Core forms, with labels in the page's locale
// and current values as defaults. Data only — the client form renders them.

export type MarketingT = Awaited<ReturnType<typeof getTranslations<"marketing">>>;

const enumOptions = <T extends string>(
  values: readonly T[],
  label: (value: T) => string,
): Option[] => values.map((value) => ({ value, label: label(value) }));

/**
 * Link choices: active records, plus the current one even when archived (it may stay
 * linked; it just cannot be newly chosen).
 */
function linkChoices(
  t: MarketingT,
  rows: readonly { id: string; name: string; archived: boolean }[],
  current: readonly string[] = [],
): Option[] {
  return rows
    .filter((row) => !row.archived || current.includes(row.id))
    .map((row) => ({
      value: row.id,
      label: row.archived ? `${row.name} (${t("common.archivedTag")})` : row.name,
    }));
}

export function brandFields(t: MarketingT, brand: BrandView | null): FieldSpec[] {
  const f = (key: Parameters<MarketingT>[0]) => t(key);
  return [
    {
      kind: "text",
      name: "name",
      label: f("brand.fields.name"),
      required: true,
      maxLength: 120,
      defaultValue: brand?.name ?? "",
    },
    {
      kind: "url",
      name: "website",
      label: f("brand.fields.website"),
      maxLength: 2048,
      defaultValue: brand?.website ?? "",
      placeholder: "https://",
    },
    {
      kind: "textarea",
      name: "description",
      label: f("brand.fields.description"),
      maxLength: 2000,
      wide: true,
      rows: 3,
      defaultValue: brand?.description ?? "",
    },
    {
      kind: "text",
      name: "industry",
      label: f("brand.fields.industry"),
      maxLength: 120,
      defaultValue: brand?.industry ?? "",
    },
    {
      kind: "text",
      name: "market",
      label: f("brand.fields.market"),
      hint: f("brand.fields.marketHint"),
      maxLength: 200,
      defaultValue: brand?.market ?? "",
    },
    {
      kind: "select",
      name: "language",
      label: f("brand.fields.language"),
      options: enumOptions(ENUM_VALUES.brandLanguage, (value) => t(`enums.language.${value}`)),
      defaultValue: brand?.language ?? "AR",
    },
    {
      kind: "textarea",
      name: "mission",
      label: f("brand.fields.mission"),
      maxLength: 2000,
      wide: true,
      rows: 3,
      defaultValue: brand?.mission ?? "",
    },
    {
      kind: "textarea",
      name: "positioning",
      label: f("brand.fields.positioning"),
      maxLength: 2000,
      rows: 3,
      defaultValue: brand?.positioning ?? "",
    },
    {
      kind: "textarea",
      name: "valueProposition",
      label: f("brand.fields.valueProposition"),
      maxLength: 2000,
      rows: 3,
      defaultValue: brand?.valueProposition ?? "",
    },
    {
      kind: "textarea",
      name: "toneOfVoice",
      label: f("brand.fields.toneOfVoice"),
      hint: f("brand.fields.toneHint"),
      maxLength: 1000,
      rows: 3,
      defaultValue: brand?.toneOfVoice ?? "",
    },
    {
      kind: "textarea",
      name: "personality",
      label: f("brand.fields.personality"),
      maxLength: 1000,
      rows: 3,
      defaultValue: brand?.personality ?? "",
    },
    {
      kind: "textarea",
      name: "keywords",
      label: f("brand.fields.keywords"),
      hint: f("brand.fields.listHint"),
      rows: 4,
      defaultValue: linesInput(brand?.keywords ?? []),
    },
    {
      kind: "textarea",
      name: "forbiddenWords",
      label: f("brand.fields.forbiddenWords"),
      hint: f("brand.fields.listHint"),
      rows: 4,
      defaultValue: linesInput(brand?.forbiddenWords ?? []),
    },
    {
      kind: "textarea",
      name: "ctaStyle",
      label: f("brand.fields.ctaStyle"),
      maxLength: 500,
      wide: true,
      rows: 2,
      defaultValue: brand?.ctaStyle ?? "",
    },
  ];
}

export function audienceFields(t: MarketingT, audience: AudienceRow | null): FieldSpec[] {
  const listHint = t("brand.fields.listHint");
  const list = (name: "painPoints" | "needs" | "interests" | "objections" | "preferredChannels") =>
    ({
      kind: "textarea",
      name,
      label: t(`audiences.fields.${name}`),
      hint: listHint,
      rows: 3,
      defaultValue: linesInput(audience?.[name] ?? []),
    }) as const;
  return [
    {
      kind: "text",
      name: "name",
      label: t("audiences.fields.name"),
      required: true,
      maxLength: 120,
      defaultValue: audience?.name ?? "",
    },
    {
      kind: "select",
      name: "buyingIntent",
      label: t("audiences.fields.buyingIntent"),
      options: enumOptions(ENUM_VALUES.buyingIntent, (value) => t(`enums.buyingIntent.${value}`)),
      emptyLabel: t("common.notSet"),
      defaultValue: audience?.buyingIntent ?? "",
    },
    {
      kind: "textarea",
      name: "description",
      label: t("audiences.fields.description"),
      maxLength: 2000,
      wide: true,
      rows: 3,
      defaultValue: audience?.description ?? "",
    },
    {
      kind: "textarea",
      name: "attributes",
      label: t("audiences.fields.attributes"),
      hint: t("audiences.fields.attributesHint"),
      wide: true,
      rows: 4,
      defaultValue:
        audience === null
          ? ""
          : audienceAttributes(audience)
              .map((attribute) => `${attribute.label}: ${attribute.value}`)
              .join("\n"),
    },
    list("painPoints"),
    list("needs"),
    list("interests"),
    list("objections"),
    list("preferredChannels"),
    {
      kind: "textarea",
      name: "notes",
      label: t("audiences.fields.notes"),
      maxLength: 4000,
      rows: 3,
      defaultValue: audience?.notes ?? "",
    },
  ];
}

export function goalFields(t: MarketingT, goal: GoalRow | null): FieldSpec[] {
  return [
    {
      kind: "text",
      name: "title",
      label: t("goals.fields.title"),
      required: true,
      maxLength: 160,
      defaultValue: goal?.title ?? "",
    },
    {
      kind: "select",
      name: "type",
      label: t("goals.fields.type"),
      options: enumOptions(ENUM_VALUES.goalType, (value) => t(`enums.goalType.${value}`)),
      defaultValue: goal?.type ?? "AWARENESS",
    },
    {
      kind: "textarea",
      name: "description",
      label: t("goals.fields.description"),
      maxLength: 2000,
      wide: true,
      rows: 3,
      defaultValue: goal?.description ?? "",
    },
    {
      kind: "text",
      name: "kpi",
      label: t("goals.fields.kpi"),
      hint: t("goals.fields.kpiHint"),
      maxLength: 160,
      defaultValue: goal?.kpi ?? "",
    },
    {
      kind: "number",
      name: "target",
      label: t("goals.fields.target"),
      maxLength: 16,
      defaultValue: goal?.target === null || goal === null ? "" : String(goal.target),
    },
    {
      kind: "date",
      name: "startDate",
      label: t("goals.fields.startDate"),
      defaultValue: dateInput(goal?.startDate ?? null),
    },
    {
      kind: "date",
      name: "endDate",
      label: t("goals.fields.endDate"),
      defaultValue: dateInput(goal?.endDate ?? null),
    },
    {
      kind: "select",
      name: "status",
      label: t("goals.fields.status"),
      options: enumOptions(ENUM_VALUES.goalStatus, (value) => t(`enums.goalStatus.${value}`)),
      defaultValue: goal?.status ?? "ACTIVE",
    },
  ];
}

export function pillarFields(
  t: MarketingT,
  pillar: PillarRow | null,
  audiences: readonly { id: string; name: string }[],
): FieldSpec[] {
  return [
    {
      kind: "text",
      name: "name",
      label: t("pillars.fields.name"),
      required: true,
      maxLength: 120,
      defaultValue: pillar?.name ?? "",
    },
    {
      kind: "select",
      name: "audienceId",
      label: t("pillars.fields.audienceId"),
      options: audiences.map((row) => ({ value: row.id, label: row.name })),
      emptyLabel: t("common.none"),
      defaultValue: pillar?.audienceId ?? "",
    },
    {
      kind: "textarea",
      name: "description",
      label: t("pillars.fields.description"),
      maxLength: 2000,
      wide: true,
      rows: 3,
      defaultValue: pillar?.description ?? "",
    },
    {
      kind: "textarea",
      name: "objective",
      label: t("pillars.fields.objective"),
      maxLength: 1000,
      wide: true,
      rows: 2,
      defaultValue: pillar?.objective ?? "",
    },
    ...(pillar === null
      ? []
      : [
          {
            kind: "checkbox",
            name: "archived",
            label: t("pillars.fields.archived"),
            defaultChecked: pillar.status === "ARCHIVED",
          } as const,
        ]),
  ];
}

export function campaignFields(
  t: MarketingT,
  campaign: CampaignDetail | null,
  options: LinkOptions,
): FieldSpec[] {
  const goalIds = campaign?.goals.map((link) => link.goal.id) ?? [];
  const pillarIds = campaign?.pillars.map((link) => link.pillar.id) ?? [];
  return [
    {
      kind: "text",
      name: "name",
      label: t("campaigns.fields.name"),
      required: true,
      maxLength: 160,
      defaultValue: campaign?.name ?? "",
    },
    {
      kind: "select",
      name: "audienceId",
      label: t("campaigns.fields.audienceId"),
      options: linkChoices(t, options.audiences),
      emptyLabel: t("common.none"),
      defaultValue: campaign?.audienceId ?? "",
    },
    {
      kind: "textarea",
      name: "description",
      label: t("campaigns.fields.description"),
      maxLength: 2000,
      wide: true,
      rows: 3,
      defaultValue: campaign?.description ?? "",
    },
    {
      kind: "textarea",
      name: "objective",
      label: t("campaigns.fields.objective"),
      maxLength: 1000,
      wide: true,
      rows: 2,
      defaultValue: campaign?.objective ?? "",
    },
    {
      kind: "date",
      name: "startDate",
      label: t("campaigns.fields.startDate"),
      defaultValue: dateInput(campaign?.startDate ?? null),
    },
    {
      kind: "date",
      name: "endDate",
      label: t("campaigns.fields.endDate"),
      defaultValue: dateInput(campaign?.endDate ?? null),
    },
    {
      kind: "multiselect",
      name: "goalIds",
      label: t("campaigns.fields.goalIds"),
      options: linkChoices(t, options.goals, goalIds),
      defaultValue: goalIds,
      emptyLabel: t("campaigns.fields.goalIdsEmpty"),
      wide: true,
    },
    {
      kind: "multiselect",
      name: "pillarIds",
      label: t("campaigns.fields.pillarIds"),
      options: linkChoices(t, options.pillars, pillarIds),
      defaultValue: pillarIds,
      emptyLabel: t("campaigns.fields.pillarIdsEmpty"),
      wide: true,
    },
    {
      kind: "number",
      name: "budgetAmount",
      label: t("campaigns.fields.budgetAmount"),
      hint: t("campaigns.fields.budgetHint"),
      maxLength: 16,
      defaultValue:
        campaign?.budgetAmountMinor === null || campaign === null
          ? ""
          : fromMinorUnits(campaign.budgetAmountMinor),
    },
    {
      kind: "text",
      name: "budgetCurrency",
      label: t("campaigns.fields.budgetCurrency"),
      hint: t("campaigns.fields.budgetCurrencyHint"),
      maxLength: 3,
      dir: "ltr",
      placeholder: "SAR",
      defaultValue: campaign?.budgetCurrency ?? "",
    },
  ];
}

export function contentFields(
  t: MarketingT,
  content: ContentDetail | null,
  options: ContentFormOptions,
  timeZone: string,
): FieldSpec[] {
  const metadata = contentMetadata(content?.metadata ?? {});
  const current = (id: string | null | undefined) => (id === null || id === undefined ? [] : [id]);
  const assetIds = content?.assets.map((link) => link.mediaAsset.id) ?? [];
  return [
    {
      kind: "text",
      name: "title",
      label: t("content.fields.title"),
      required: true,
      maxLength: 200,
      defaultValue: content?.title ?? "",
    },
    {
      kind: "select",
      name: "type",
      label: t("content.fields.type"),
      options: enumOptions(ENUM_VALUES.contentType, (value) => t(`enums.contentType.${value}`)),
      defaultValue: content?.type ?? "POST",
    },
    {
      kind: "textarea",
      name: "body",
      label: t("content.fields.body"),
      maxLength: 10000,
      wide: true,
      rows: 8,
      defaultValue: content?.body ?? "",
    },
    {
      kind: "select",
      name: "campaignId",
      label: t("content.fields.campaignId"),
      options: linkChoices(t, options.campaigns, current(content?.campaignId)),
      emptyLabel: t("common.none"),
      defaultValue: content?.campaignId ?? "",
    },
    {
      kind: "select",
      name: "pillarId",
      label: t("content.fields.pillarId"),
      options: linkChoices(t, options.pillars, current(content?.pillarId)),
      emptyLabel: t("common.none"),
      defaultValue: content?.pillarId ?? "",
    },
    {
      kind: "select",
      name: "audienceId",
      label: t("content.fields.audienceId"),
      options: linkChoices(t, options.audiences, current(content?.audienceId)),
      emptyLabel: t("common.none"),
      defaultValue: content?.audienceId ?? "",
    },
    {
      kind: "select",
      name: "goalId",
      label: t("content.fields.goalId"),
      options: linkChoices(t, options.goals, current(content?.goalId)),
      emptyLabel: t("common.none"),
      defaultValue: content?.goalId ?? "",
    },
    {
      kind: "datetime",
      name: "plannedAt",
      label: t("content.fields.plannedAt", { zone: timeZone }),
      defaultValue:
        content?.scheduledAt === null || content === null
          ? ""
          : utcToZonedLocal(content.scheduledAt, timeZone),
    },
    {
      kind: "text",
      name: "callToAction",
      label: t("content.fields.callToAction"),
      maxLength: 200,
      defaultValue: metadata.callToAction ?? "",
    },
    {
      kind: "url",
      name: "link",
      label: t("content.fields.link"),
      maxLength: 2048,
      placeholder: "https://",
      defaultValue: metadata.link ?? "",
    },
    {
      kind: "textarea",
      name: "hashtags",
      label: t("content.fields.hashtags"),
      hint: t("brand.fields.listHint"),
      rows: 2,
      defaultValue: linesInput(metadata.hashtags),
    },
    {
      kind: "multiselect",
      name: "assetIds",
      label: t("content.fields.assetIds"),
      options: options.media.map((row) => ({ value: row.id, label: row.altText ?? row.name })),
      defaultValue: assetIds,
      emptyLabel: t("content.fields.assetIdsEmpty"),
      wide: true,
    },
    {
      kind: "textarea",
      name: "notes",
      label: t("content.fields.notes"),
      maxLength: 4000,
      wide: true,
      rows: 3,
      defaultValue: content?.notes ?? "",
    },
  ];
}

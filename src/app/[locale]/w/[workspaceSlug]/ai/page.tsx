import { BarChart3, Film, RotateCcw } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import {
  Card,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
  SectionTabs,
} from "@/components/marketing/page-parts";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getAiStudioPage } from "@/server/ai/ai-queries";
import { ENUM_VALUES } from "@/server/marketing/inputs";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { submitGenerate, type StudioTool } from "./ai-actions";
import { Suggestion, SuggestionHistory } from "./suggestion";
import { VideoExpiryBanner } from "./videos/retention-notices";

const TOOLS: readonly StudioTool[] = ["ideas", "brief", "copy"];
const TOOL_OF_OPERATION: Readonly<Record<string, StudioTool>> = {
  IDEAS: "ideas",
  BRIEF: "brief",
  COPY: "copy",
};

/** AI Studio: generate ideas, briefs and copy; suggestions stay drafts until used. */
export default async function AiStudioRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const raw = await searchParams;
  const t = await getTranslations({ locale, namespace: "ai" });
  const tEnums = await getTranslations({ locale, namespace: "marketing.enums" });
  const generationId = typeof raw.g === "string" ? raw.g : undefined;
  const data = await guardPage(getAiStudioPage(workspace.slug, generationId));
  if (data === null) {
    return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  }
  const requested = typeof raw.tool === "string" ? raw.tool : "";
  const tool: StudioTool =
    (data.selected === null ? undefined : TOOL_OF_OPERATION[data.selected.operation]) ??
    TOOLS.find((candidate) => candidate === requested) ??
    "ideas";
  const base = `/w/${workspace.slug}/ai`;

  const none = t("fields.none");
  const language: FieldSpec = {
    kind: "select",
    name: "language",
    label: t("fields.language"),
    hint: t("fields.languageHint"),
    emptyLabel: t("fields.languageAuto"),
    options: [
      { value: "ar", label: t("languages.ar") },
      { value: "en", label: t("languages.en") },
    ],
  };
  const pillar: FieldSpec = {
    kind: "select",
    name: "pillarId",
    label: t("fields.pillar"),
    emptyLabel: none,
    options: data.options.pillars.map((row) => ({ value: row.id, label: row.name })),
  };
  const campaign: FieldSpec = {
    kind: "select",
    name: "campaignId",
    label: t("fields.campaign"),
    emptyLabel: none,
    options: data.options.campaigns.map((row) => ({ value: row.id, label: row.name })),
  };
  const contentType = (emptyLabel: string): FieldSpec => ({
    kind: "select",
    name: "contentType",
    label: t("fields.contentType"),
    emptyLabel,
    options: ENUM_VALUES.contentType.map((value) => ({
      value,
      label: tEnums(`contentType.${value}`),
    })),
  });
  const fields: Readonly<Record<StudioTool, readonly FieldSpec[]>> = {
    ideas: [
      {
        kind: "textarea",
        name: "topic",
        label: t("fields.topicOptional"),
        hint: t("fields.topicHint"),
        maxLength: 500,
        rows: 3,
        wide: true,
      },
      {
        kind: "select",
        name: "count",
        label: t("fields.count"),
        defaultValue: "5",
        options: [3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({
          value: String(value),
          label: String(value),
        })),
      },
      language,
      pillar,
      campaign,
    ],
    brief: [
      {
        kind: "textarea",
        name: "topic",
        label: t("fields.topic"),
        hint: t("fields.topicHint"),
        required: true,
        maxLength: 500,
        rows: 3,
        wide: true,
      },
      contentType(t("fields.anyType")),
      language,
      pillar,
      campaign,
    ],
    copy: [
      {
        kind: "textarea",
        name: "topic",
        label: t("fields.copyTopic"),
        hint: t("fields.topicHint"),
        required: true,
        maxLength: 1000,
        rows: 4,
        wide: true,
      },
      contentType(t("fields.anyType")),
      {
        kind: "select",
        name: "variants",
        label: t("fields.variants"),
        defaultValue: "2",
        options: [0, 1, 2, 3].map((value) => ({ value: String(value), label: String(value) })),
      },
      language,
      campaign,
    ],
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`${base}/videos`} data-testid="ai-videos-link">
                <Film aria-hidden="true" />
                {t("videos.title")}
              </Link>
            </Button>
            {data.can.usage ? (
              <Button asChild variant="outline">
                <Link href={`${base}/usage`} data-testid="ai-usage-link">
                  <BarChart3 aria-hidden="true" />
                  {t("usage.title")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {data.configured ? null : <Notice testId="ai-not-configured">{t("notConfigured")}</Notice>}
      <VideoExpiryBanner locale={locale} slug={workspace.slug} />
      <SectionTabs
        label={t("tabsLabel")}
        tabs={TOOLS.map((candidate) => ({
          href: `${base}?tool=${candidate}`,
          label: t(`tools.${candidate}.tab`),
          active: candidate === tool,
        }))}
      />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-8">
          <Card title={t(`tools.${tool}.title`)} testId="ai-tool">
            <p id="ai-form" className="text-sm text-muted-foreground">
              {t(`tools.${tool}.description`)}
            </p>
            <EntityForm
              key={tool}
              action={submitGenerate.bind(null, workspace.slug, locale, tool)}
              fields={fields[tool]}
              submitLabel={t("generate")}
              pendingLabel={t("generating")}
              testId={`ai-${tool}-form`}
              readOnly={!data.configured}
            />
          </Card>
          <Card
            title={t("result.title")}
            testId="ai-result"
            actions={
              data.selected === null ? null : (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`${base}?tool=${tool}#ai-form`} data-testid="ai-regenerate">
                    <RotateCcw aria-hidden="true" />
                    {t("regenerate")}
                  </Link>
                </Button>
              )
            }
          >
            {data.selected === null ? (
              <EmptyState message={t("result.empty")} testId="ai-result-empty" />
            ) : (
              <Suggestion locale={locale} slug={workspace.slug} view={data.selected} />
            )}
          </Card>
        </div>
        <aside className="space-y-3" aria-labelledby="ai-history">
          <h2 id="ai-history" className="text-lg font-bold">
            {t("history.title")}
          </h2>
          <SuggestionHistory
            locale={locale}
            items={data.history}
            currentId={data.selected?.id ?? null}
            href={(item) =>
              `${base}?tool=${TOOL_OF_OPERATION[item.operation] ?? "ideas"}&g=${item.id}`
            }
          />
        </aside>
      </div>
    </div>
  );
}

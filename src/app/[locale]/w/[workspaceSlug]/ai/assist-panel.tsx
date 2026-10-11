import { Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { Card, Notice } from "@/components/marketing/page-parts";
import type { Locale } from "@/i18n/config";
import type { GenerationSummary, GenerationView } from "@/server/ai/ai-service";
import { ASSIST_OPERATIONS } from "@/server/ai/operations";

import { submitAssist } from "./ai-actions";
import { Suggestion, SuggestionHistory } from "./suggestion";

/** AI assistance for one DRAFT (content.edit). Using a suggestion changes the draft only. */
export async function AssistPanel({
  locale,
  slug,
  contentId,
  data,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly contentId: string;
  readonly data: {
    readonly configured: boolean;
    readonly history: readonly GenerationSummary[];
    readonly selected: GenerationView | null;
  };
}) {
  const t = await getTranslations({ locale, namespace: "ai" });
  return (
    <Card title={t("assist.title")} testId="ai-assist">
      <div id="ai-assist" className="flex items-start gap-2 text-sm text-muted-foreground">
        <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>{t("assist.description")}</p>
      </div>
      {data.configured ? null : <Notice testId="ai-not-configured">{t("notConfigured")}</Notice>}
      <EntityForm
        action={submitAssist.bind(null, slug, locale, contentId)}
        fields={[
          {
            kind: "select",
            name: "operation",
            label: t("fields.operation"),
            defaultValue: "CONTENT_REWRITE",
            options: ASSIST_OPERATIONS.map((operation) => ({
              value: operation,
              label: t(`operations.${operation}`),
            })),
          },
          {
            kind: "select",
            name: "language",
            label: t("fields.language"),
            emptyLabel: t("fields.languageAuto"),
            options: [
              { value: "ar", label: t("languages.ar") },
              { value: "en", label: t("languages.en") },
            ],
          },
          {
            kind: "textarea",
            name: "instructions",
            label: t("fields.instructions"),
            maxLength: 500,
            rows: 2,
            wide: true,
          },
        ]}
        submitLabel={t("generate")}
        pendingLabel={t("generating")}
        testId="ai-assist-form"
        readOnly={!data.configured}
      />
      {data.selected === null ? null : (
        <Suggestion locale={locale} slug={slug} view={data.selected} />
      )}
      {data.history.length === 0 ? null : (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("history.title")}</h3>
          <SuggestionHistory
            locale={locale}
            items={data.history}
            currentId={data.selected?.id ?? null}
            href={(item) => `/w/${slug}/content/${contentId}?ai=${item.id}#ai-assist`}
          />
        </div>
      )}
    </Card>
  );
}

import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { ActionButton } from "@/components/marketing/entity-form";
import { Badge, Notice } from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/config";
import type { GenerationSummary, GenerationView } from "@/server/ai/ai-service";

import { submitApply } from "./ai-actions";

// Renders one stored, server-validated AI suggestion. Text is shown as plain text (React
// escapes it). "Use" sends only the generation id and the option index; the server
// re-reads, re-validates and applies the stored output.

type Record_ = Readonly<Record<string, unknown>>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const records = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is Record_ => typeof item === "object" && item !== null)
    : [];

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm leading-relaxed whitespace-pre-line">{children}</dd>
    </div>
  );
}

export async function Suggestion({
  locale,
  slug,
  view,
}: {
  readonly locale: Locale;
  readonly slug: string;
  readonly view: GenerationView;
}) {
  const t = await getTranslations({ locale, namespace: "ai" });
  const tEnums = await getTranslations({ locale, namespace: "marketing.enums" });
  const output = view.output as Record_ | null;

  if (view.status !== "SUCCEEDED" || output === null) {
    return (
      <Notice testId="suggestion-failed">
        {view.status === "PENDING"
          ? t("result.pending")
          : t("result.failed", {
              reason: t.has(`failures.${view.errorCode ?? "unavailable"}` as never)
                ? t(`failures.${view.errorCode ?? "unavailable"}` as never)
                : t("failures.unavailable"),
            })}
      </Notice>
    );
  }

  const reference = (handle: unknown) => {
    const name = typeof handle === "string" ? view.referenceNames[handle] : undefined;
    return name ?? null;
  };
  const renderUseButton = (choice: number, label: string) =>
    view.usable ? (
      <ActionButton
        action={submitApply.bind(null, slug, locale, view.id, choice)}
        label={label}
        variant="default"
        testId={`use-${String(choice)}`}
      />
    ) : null;

  const options: { key: string; title?: string; body: ReactNode; use: string }[] = [];
  switch (view.operation) {
    case "IDEAS":
      records(output.ideas).forEach((idea, index) => {
        const pillar = reference(idea.pillarRef);
        const campaign = reference(idea.campaignRef);
        options.push({
          key: String(index),
          title: str(idea.title),
          use: t("use.idea"),
          body: (
            <dl className="grid gap-2 sm:grid-cols-2">
              <Field label={t("fields.contentType")}>
                {tEnums(`contentType.${str(idea.contentType)}` as never)}
              </Field>
              <Field label={t("fields.objective")}>{str(idea.objective)}</Field>
              <Field label={t("fields.angle")}>{str(idea.angle)}</Field>
              <Field label={t("fields.audience")}>{str(idea.audience)}</Field>
              <Field label={t("fields.cta")}>{str(idea.ctaDirection)}</Field>
              <Field label={t("fields.rationale")}>{str(idea.rationale)}</Field>
              {pillar === null ? null : <Field label={t("fields.pillar")}>{pillar}</Field>}
              {campaign === null ? null : <Field label={t("fields.campaign")}>{campaign}</Field>}
            </dl>
          ),
        });
      });
      break;
    case "BRIEF":
    case "CONTENT_BRIEF": {
      const pillar = reference(output.pillarRef);
      const campaign = reference(output.campaignRef);
      options.push({
        key: "brief",
        title: str(output.title),
        use: view.operation === "BRIEF" ? t("use.brief") : t("use.notes"),
        body: (
          <dl className="grid gap-2 sm:grid-cols-2">
            <Field label={t("fields.contentType")}>
              {tEnums(`contentType.${str(output.contentType)}` as never)}
            </Field>
            <Field label={t("fields.objective")}>{str(output.objective)}</Field>
            <Field label={t("fields.audience")}>{str(output.audience)}</Field>
            <Field label={t("fields.keyMessage")}>{str(output.keyMessage)}</Field>
            <Field label={t("fields.angle")}>{str(output.angle)}</Field>
            <Field label={t("fields.hook")}>{str(output.hook)}</Field>
            <Field label={t("fields.cta")}>{str(output.cta)}</Field>
            <Field label={t("fields.tone")}>{str(output.tone)}</Field>
            <Field label={t("fields.supportingPoints")}>
              {strings(output.supportingPoints)
                .map((point) => `• ${point}`)
                .join("\n")}
            </Field>
            <Field label={t("fields.structure")}>
              {strings(output.structure)
                .map((step, index) => `${String(index + 1)}. ${step}`)
                .join("\n")}
            </Field>
            {pillar === null ? null : <Field label={t("fields.pillar")}>{pillar}</Field>}
            {campaign === null ? null : <Field label={t("fields.campaign")}>{campaign}</Field>}
          </dl>
        ),
      });
      break;
    }
    case "COPY":
    case "CONTENT_DRAFT":
    case "CONTENT_REWRITE": {
      const hashtags = strings(output.hashtags);
      const versions = [output, ...records(output.variants)];
      versions.forEach((version, index) => {
        options.push({
          key: String(index),
          title:
            index === 0
              ? view.operation === "COPY"
                ? str(output.title)
                : t("result.main")
              : t("result.variant", { number: index }),
          use: view.operation === "COPY" ? t("use.copy") : t("use.apply"),
          body: (
            <dl className="space-y-2">
              <Field label={t("fields.hook")}>{str(version.hook)}</Field>
              <Field label={t("fields.caption")}>{str(version.caption)}</Field>
              <Field label={t("fields.cta")}>{str(version.cta)}</Field>
              {index === 0 && hashtags.length > 0 ? (
                <Field label={t("fields.hashtags")}>
                  <span dir="auto">{hashtags.join(" ")}</span>
                </Field>
              ) : null}
            </dl>
          ),
        });
      });
      break;
    }
    case "CONTENT_ALTERNATIVES":
      records(output.alternatives).forEach((alternative, index) => {
        options.push({
          key: String(index),
          title: t("result.variant", { number: index + 1 }),
          use: t("use.apply"),
          body: (
            <dl className="space-y-2">
              <Field label={t("fields.hook")}>{str(alternative.hook)}</Field>
              <Field label={t("fields.caption")}>{str(alternative.caption)}</Field>
              <Field label={t("fields.cta")}>{str(alternative.cta)}</Field>
            </dl>
          ),
        });
      });
      break;
    case "CONTENT_HOOK":
    case "CONTENT_CTA":
      strings(view.operation === "CONTENT_HOOK" ? output.hooks : output.ctas).forEach(
        (line, index) => {
          options.push({
            key: String(index),
            use: t("use.apply"),
            body: <p className="text-sm leading-relaxed">{line}</p>,
          });
        },
      );
      break;
    case "AD_PLAN":
    case "SOCIAL_REPLY":
    case "SOCIAL_LEARNING":
      // Advertising proposals and social agents' work belong to their own areas; the server
      // never shows them here.
      break;
  }

  return (
    <section className="space-y-4" data-testid="suggestion" data-operation={view.operation}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">
          <Sparkles aria-hidden="true" className="me-1 inline size-3" />
          {t("label")}
        </Badge>
        <span className="text-xs text-muted-foreground">{t(`operations.${view.operation}`)}</span>
      </div>
      <p className="text-sm text-muted-foreground">{t("reviewNotice")}</p>
      {view.forbiddenWords.length > 0 ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-lime-soft p-3 text-sm text-lime-soft-foreground"
          data-testid="forbidden-warning"
        >
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          {t("forbiddenWarning", { words: view.forbiddenWords.join("، ") })}
        </p>
      ) : null}
      {view.appliedAt !== null ? (
        <p className="flex items-center gap-2 text-sm" data-testid="suggestion-used">
          <CheckCircle2 aria-hidden="true" className="size-4 text-primary" />
          {t("result.used")}
          {view.appliedContentItemId === null ? null : (
            <Link
              href={`/w/${slug}/content/${view.appliedContentItemId}`}
              className="font-medium text-primary hover:underline"
            >
              {t("result.openContent")}
            </Link>
          )}
        </p>
      ) : null}
      <ol className="grid gap-3 lg:grid-cols-2">
        {options.map((option, index) => (
          <li
            key={option.key}
            className="flex flex-col gap-3 rounded-2xl border bg-card p-4 text-card-foreground"
            data-testid="suggestion-option"
          >
            {option.title === undefined ? null : <h3 className="font-semibold">{option.title}</h3>}
            {option.body}
            <div className="mt-auto">{renderUseButton(index, option.use)}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The person's recent suggestions, newest first. */
export async function SuggestionHistory({
  locale,
  items,
  href,
  currentId,
}: {
  readonly locale: Locale;
  readonly items: readonly GenerationSummary[];
  readonly href: (item: GenerationSummary) => string;
  readonly currentId: string | null;
}) {
  const t = await getTranslations({ locale, namespace: "ai" });
  const format = await getFormatter({ locale });
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("history.empty")}</p>;
  }
  return (
    <ul className="divide-y rounded-2xl border" data-testid="suggestion-history">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={href(item)}
            aria-current={item.id === currentId ? "true" : undefined}
            className="flex flex-wrap items-center gap-2 p-3 text-sm hover:bg-accent aria-[current=true]:bg-accent"
          >
            <span className="flex-1 font-medium">{t(`operations.${item.operation}`)}</span>
            <Badge
              tone={
                item.status === "FAILED"
                  ? "danger"
                  : item.status === "PENDING"
                    ? "muted"
                    : item.appliedAt === null
                      ? "accent"
                      : "solid"
              }
            >
              {item.appliedAt === null ? t(`status.${item.status}`) : t("result.usedShort")}
            </Badge>
            <time dateTime={item.createdAt.toISOString()} className="text-xs text-muted-foreground">
              {format.dateTime(item.createdAt, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

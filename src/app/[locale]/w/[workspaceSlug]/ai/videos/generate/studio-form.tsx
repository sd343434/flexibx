"use client";

import { PendingLabel } from "@/components/common/loaders";

import { RectangleHorizontal, RectangleVertical, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";

import {
  actionErrorMessage,
  inputClass,
  type FormAction,
} from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { MarketingFormState } from "../../../marketing-actions";

// The Video Studio brief and settings. It only collects input: every value is validated,
// and every permission and limit decided, on the server. The platform suggests its usual
// format until the person picks a format themselves.

type Aspect = "16:9" | "9:16";

export interface StudioOptions {
  readonly durations: readonly number[];
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  readonly tiers: readonly string[];
  readonly platforms: readonly string[];
  readonly styles: readonly string[];
  readonly languages: readonly string[];
  readonly platformAspect: Readonly<Record<string, Aspect>>;
}

const DEFAULT_PLATFORM = "instagram_reels";

function fieldErrors(state: MarketingFormState) {
  const map = new Map<string, { code: string; params?: unknown }>();
  if (state !== null && "error" in state) {
    for (const field of state.error.fields ?? []) {
      const name = field.path.split(".")[0] ?? "";
      if (!map.has(name)) map.set(name, { code: field.code, params: field.params });
    }
  }
  return map;
}

function Section({
  title,
  hint,
  children,
  testId,
}: {
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" data-testid={testId}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function StudioForm({
  action,
  configured,
  options,
  defaultLanguage,
}: {
  readonly action: FormAction;
  readonly configured: boolean;
  readonly options: StudioOptions;
  readonly defaultLanguage: string;
}) {
  const t = useTranslations("ai.videos.generate");
  const tAll = useTranslations();
  const [state, formAction, pending] = useActionState<MarketingFormState, FormData>(action, null);
  const values = state !== null && "values" in state ? state.values : undefined;
  const value = (name: string, fallback = "") => {
    const raw = values?.[name];
    return typeof raw === "string" ? raw : fallback;
  };
  const errors = fieldErrors(state);
  const [platform, setPlatform] = useState(value("platform", DEFAULT_PLATFORM));
  const [aspect, setAspect] = useState<string>(
    value("aspectRatio", options.platformAspect[DEFAULT_PLATFORM] ?? "9:16"),
  );
  // Only a click on a format stops the platform suggestion (not a returned form).
  const [aspectChosen, setAspectChosen] = useState(false);

  const errorFor = (name: string) => {
    const error = errors.get(name);
    if (error === undefined) return undefined;
    const key = `validation.${error.code}`;
    return tAll.has(key as never)
      ? tAll(key as never, error.params as never)
      : tAll("validation.invalid" as never);
  };
  const described = (name: string, hint: boolean) =>
    [hint ? `studio-${name}-hint` : null, errors.has(name) ? `studio-${name}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const errorText = (name: string) => {
    const message = errorFor(name);
    return message === undefined ? null : (
      <p id={`studio-${name}-error`} className="text-sm text-destructive">
        {message}
      </p>
    );
  };
  const hint = (name: string, text: string) => (
    <p id={`studio-${name}-hint`} className="text-xs text-muted-foreground">
      {text}
    </p>
  );
  const label = "block text-sm font-medium";
  const known = new Set([
    "title",
    "objective",
    "audience",
    "description",
    "platform",
    "style",
    "language",
    "durationSeconds",
    "aspectRatio",
    "resolution",
    "tier",
    "audio",
  ]);
  const unplaced =
    state !== null &&
    "error" in state &&
    ((state.error.fields ?? []).length === 0 ||
      (state.error.fields ?? []).some((field) => !known.has(field.path.split(".")[0] ?? "")));

  const choice = (selected: boolean) =>
    cn(
      "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm whitespace-nowrap transition-colors",
      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
      selected ? "border-primary bg-accent font-medium" : "hover:bg-muted",
    );

  return (
    <form action={formAction} className="space-y-4" data-testid="video-request-form" noValidate>
      {state !== null && "error" in state ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          data-testid="form-error"
        >
          {unplaced ? actionErrorMessage(tAll, state.error) : tAll(state.error.messageKey as never)}
        </p>
      ) : null}
      <fieldset disabled={!configured || pending} className="space-y-4">
        <Section title={t("sections.brief")} hint={t("sections.briefHint")} testId="studio-brief">
          <div className="space-y-1.5 sm:col-span-2">
            <label htmlFor="studio-title" className={label}>
              {t("fields.title")}
            </label>
            <input
              id="studio-title"
              name="title"
              required
              maxLength={200}
              defaultValue={value("title")}
              aria-invalid={errors.has("title") || undefined}
              aria-describedby={described("title", false)}
              className={cn(inputClass, "h-10")}
            />
            {errorText("title")}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <label htmlFor="studio-objective" className={label}>
              {t("fields.objective")}
            </label>
            <input
              id="studio-objective"
              name="objective"
              required
              maxLength={400}
              defaultValue={value("objective")}
              aria-invalid={errors.has("objective") || undefined}
              aria-describedby={described("objective", true)}
              className={cn(inputClass, "h-10")}
            />
            {hint("objective", t("fields.objectiveHint"))}
            {errorText("objective")}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <label htmlFor="studio-description" className={label}>
              {t("fields.description")}
            </label>
            <textarea
              id="studio-description"
              name="description"
              required
              rows={4}
              maxLength={1000}
              defaultValue={value("description")}
              aria-invalid={errors.has("description") || undefined}
              aria-describedby={described("description", true)}
              className={cn(inputClass, "py-2")}
            />
            {hint("description", t("fields.descriptionHint"))}
            {errorText("description")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="studio-audience" className={label}>
              {t("fields.audience")}
            </label>
            <input
              id="studio-audience"
              name="audience"
              maxLength={250}
              defaultValue={value("audience")}
              aria-invalid={errors.has("audience") || undefined}
              aria-describedby={described("audience", true)}
              className={cn(inputClass, "h-10")}
            />
            {hint("audience", t("fields.audienceHint"))}
            {errorText("audience")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="studio-platform" className={label}>
              {t("fields.platform")}
            </label>
            <select
              id="studio-platform"
              name="platform"
              value={platform}
              onChange={(event) => {
                setPlatform(event.target.value);
                const suggested = options.platformAspect[event.target.value];
                if (!aspectChosen && suggested !== undefined) setAspect(suggested);
              }}
              aria-invalid={errors.has("platform") || undefined}
              aria-describedby={described("platform", true)}
              className={cn(inputClass, "h-10")}
            >
              {options.platforms.map((option) => (
                <option key={option} value={option}>
                  {t(`fields.platforms.${option}` as "fields.platforms.tiktok")}
                </option>
              ))}
            </select>
            {hint("platform", t("fields.platformHint"))}
            {errorText("platform")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="studio-style" className={label}>
              {t("fields.style")}
            </label>
            <select
              id="studio-style"
              name="style"
              defaultValue={value("style", options.styles[0] ?? "")}
              aria-invalid={errors.has("style") || undefined}
              className={cn(inputClass, "h-10")}
            >
              {options.styles.map((option) => (
                <option key={option} value={option}>
                  {t(`fields.styles.${option}` as "fields.styles.cinematic")}
                </option>
              ))}
            </select>
            {errorText("style")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="studio-language" className={label}>
              {t("fields.language")}
            </label>
            <select
              id="studio-language"
              name="language"
              defaultValue={value("language", defaultLanguage)}
              aria-invalid={errors.has("language") || undefined}
              aria-describedby={described("language", true)}
              className={cn(inputClass, "h-10")}
            >
              {options.languages.map((option) => (
                <option key={option} value={option}>
                  {t(`fields.languages.${option}` as "fields.languages.ar")}
                </option>
              ))}
            </select>
            {hint("language", t("fields.languageHint"))}
            {errorText("language")}
          </div>
        </Section>

        <Section
          title={t("sections.settings")}
          hint={t("sections.settingsHint")}
          testId="studio-settings"
        >
          <fieldset
            className="space-y-2 sm:col-span-2"
            aria-describedby={described("aspectRatio", false)}
          >
            <legend className={cn(label, "mb-2")}>{t("fields.aspectRatio")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {options.aspectRatios.map((option) => (
                <label key={option} className={choice(aspect === option)}>
                  <input
                    type="radio"
                    name="aspectRatio"
                    value={option}
                    checked={aspect === option}
                    onChange={() => {
                      setAspect(option);
                      setAspectChosen(true);
                    }}
                    className="sr-only"
                  />
                  {option === "9:16" ? (
                    <RectangleVertical aria-hidden="true" className="size-4" />
                  ) : (
                    <RectangleHorizontal aria-hidden="true" className="size-4" />
                  )}
                  {option === "9:16" ? t("aspect.portrait") : t("aspect.landscape")}
                </label>
              ))}
            </div>
            {errorText("aspectRatio")}
          </fieldset>

          <fieldset
            className="space-y-2 sm:col-span-2"
            aria-describedby={described("durationSeconds", false)}
          >
            <legend className={cn(label, "mb-2")}>{t("fields.duration")}</legend>
            {options.durations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("fields.noDurations")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {options.durations.map((seconds) => (
                  <label
                    key={seconds}
                    className={cn(
                      choice(false),
                      "has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:font-medium",
                    )}
                  >
                    <input
                      type="radio"
                      name="durationSeconds"
                      value={String(seconds)}
                      defaultChecked={value("durationSeconds") === String(seconds)}
                      className="sr-only"
                    />
                    {t("fields.durationOption", { seconds })}
                  </label>
                ))}
              </div>
            )}
            {errorText("durationSeconds")}
          </fieldset>

          <fieldset className="space-y-2 sm:col-span-2">
            <legend className={cn(label, "mb-2")}>{t("fields.tier")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.tiers.map((option) => (
                <label
                  key={option}
                  className={cn(
                    choice(false),
                    "items-start whitespace-normal has-[:checked]:border-primary has-[:checked]:bg-accent",
                  )}
                >
                  <input
                    type="radio"
                    name="tier"
                    value={option}
                    defaultChecked={value("tier", "DRAFT") === option}
                    className="sr-only"
                  />
                  <span>
                    <span className="block font-medium">
                      {t(`tiers.${option}` as "tiers.DRAFT")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`fields.tierHints.${option}` as "fields.tierHints.DRAFT")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {errorText("tier")}
          </fieldset>

          <div className="space-y-1.5">
            <label htmlFor="studio-resolution" className={label}>
              {t("fields.resolution")}
            </label>
            <select
              id="studio-resolution"
              name="resolution"
              defaultValue={value("resolution", "720p")}
              aria-invalid={errors.has("resolution") || undefined}
              className={cn(inputClass, "h-10")}
            >
              {options.resolutions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {errorText("resolution")}
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium">
            <input
              type="checkbox"
              name="audio"
              defaultChecked={value("audio") === "on"}
              className="size-4 accent-[var(--primary)]"
            />
            {t("fields.audio")}
          </label>
        </Section>
      </fieldset>

      {configured ? (
        <Button
          type="submit"
          disabled={pending}
          className="w-full sm:w-auto"
          data-testid="video-request-form-submit"
        >
          <Sparkles aria-hidden="true" />
          <PendingLabel
            pending={pending}
            idle={t("submit")}
            busy={t("submitting")}
            surface="primary"
          />
        </Button>
      ) : null}
    </form>
  );
}

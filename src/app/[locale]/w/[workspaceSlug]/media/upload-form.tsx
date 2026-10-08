"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";

import { actionErrorMessage, inputClass } from "@/components/marketing/entity-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { submitUpload, type MarketingFormState } from "../marketing-actions";

/** Image upload. The server checks the size, reads the real type from the file and stores it. */
export function UploadForm({ slug }: { readonly slug: string }) {
  const locale = useLocale();
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<MarketingFormState, FormData>(
    submitUpload.bind(null, slug, locale),
    null,
  );

  return (
    <form
      action={formAction}
      className="grid gap-4 sm:grid-cols-2 sm:items-end"
      data-testid="media-upload"
    >
      <div className="space-y-2">
        <label htmlFor="media-file" className="block text-sm font-medium">
          {t("marketing.media.file")}
        </label>
        <input
          id="media-file"
          name="file"
          type="file"
          required
          accept="image/png,image/jpeg,image/webp"
          className={cn(inputClass, "py-2")}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="media-alt" className="block text-sm font-medium">
          {t("marketing.media.altText")}
        </label>
        <input
          id="media-alt"
          name="altText"
          maxLength={500}
          dir="auto"
          aria-describedby="media-alt-hint"
          className={cn(inputClass, "h-10")}
        />
        <p id="media-alt-hint" className="text-xs text-muted-foreground">
          {t("marketing.media.altHint")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending} data-testid="media-upload-submit">
          {pending ? t("marketing.common.working") : t("marketing.media.upload")}
        </Button>
        {state !== null && "done" in state ? (
          <p role="status" className="text-sm text-muted-foreground" data-testid="form-saved">
            {t("marketing.common.saved")}
          </p>
        ) : null}
        {state !== null && "error" in state ? (
          <p role="alert" className="text-sm text-destructive" data-testid="form-error">
            {actionErrorMessage(t, state.error)}
          </p>
        ) : null}
      </div>
    </form>
  );
}

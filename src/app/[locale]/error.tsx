"use client";

import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

// Localized error boundary. Shows a friendly message and the error digest (an opaque
// id that matches server logs) — never the error message or stack trace.
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");

  return (
    <main
      id="main"
      role="alert"
      className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-24 sm:px-6"
    >
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>
      {error.digest === undefined ? null : (
        <p className="font-mono text-sm text-muted-foreground" dir="ltr">
          {t("reference", { digest: error.digest })}
        </p>
      )}
      <Button
        onClick={() => {
          reset();
        }}
      >
        <RotateCcw aria-hidden="true" />
        {t("retry")}
      </Button>
    </main>
  );
}

import { useTranslations } from "next-intl";

/** Shown while a workspace page loads (streamed before the server data is ready). */
export default function WorkspaceLoading() {
  const t = useTranslations("marketing.common");
  return (
    <div className="space-y-6" aria-busy="true" data-testid="page-loading">
      <p className="sr-only" role="status">
        {t("loading")}
      </p>
      <div className="h-9 w-1/3 animate-pulse rounded-md bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-32 animate-pulse rounded-lg bg-muted" />
        <div className="h-32 animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}

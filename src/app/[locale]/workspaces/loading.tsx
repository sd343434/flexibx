import { useTranslations } from "next-intl";

import { PageLoader } from "@/components/common/loaders";

/** Shown while the workspace list or the new-workspace page loads (session and membership checks). */
export default function Loading() {
  const t = useTranslations("common.loading");
  return <PageLoader label={t("workspaces")} />;
}

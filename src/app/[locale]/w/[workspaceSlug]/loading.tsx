import { useTranslations } from "next-intl";

import { PageLoader } from "@/components/common/loaders";

/** Shown while a workspace page loads (streamed before the server data is ready). */
export default function Loading() {
  const t = useTranslations("common.loading");
  return <PageLoader label={t("workspace")} />;
}

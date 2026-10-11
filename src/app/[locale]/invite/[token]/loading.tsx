import { useTranslations } from "next-intl";

import { PageLoader } from "@/components/common/loaders";

/** Shown while an invitation is looked up. */
export default function Loading() {
  const t = useTranslations("common.loading");
  return <PageLoader label={t("invitation")} />;
}

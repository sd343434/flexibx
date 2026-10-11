import { useTranslations } from "next-intl";

import { PageLoader } from "@/components/common/loaders";

/** Shown while a sign-in, sign-up or recovery page loads (session check). */
export default function Loading() {
  const t = useTranslations("common.loading");
  return <PageLoader label={t("page")} />;
}

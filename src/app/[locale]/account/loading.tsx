import { useTranslations } from "next-intl";

import { PageLoader } from "@/components/common/loaders";

/** Shown while the account pages load (session check). */
export default function Loading() {
  const t = useTranslations("common.loading");
  return <PageLoader label={t("account")} />;
}

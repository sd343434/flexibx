import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { DirectionalIcon } from "@/components/common/directional-icon";
import { SiteHeader } from "@/components/common/site-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default function LocaleNotFound() {
  const t = useTranslations("notFound");

  return (
    <>
      <SiteHeader />
      <main
        id="main"
        className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-24 sm:px-6"
      >
        <p className="text-sm font-semibold text-primary tabular-nums">404</p>
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
        <Button asChild>
          <Link href="/" data-testid="back-home">
            {t("backHome")}
            <DirectionalIcon icon={ArrowRight} />
          </Link>
        </Button>
      </main>
    </>
  );
}

"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { LOCALES } from "@/i18n/config";
import { Link, usePathname } from "@/i18n/navigation";

/** Links to the current page in every other locale (works without JavaScript). */
export function LocaleSwitcher() {
  const t = useTranslations("common.language");
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <nav aria-label={t("label")} className="flex items-center gap-1">
      {LOCALES.filter((candidate) => candidate !== locale).map((candidate) => (
        <Button key={candidate} asChild variant="ghost" size="sm">
          <Link
            href={pathname}
            locale={candidate}
            hrefLang={candidate}
            lang={candidate}
            aria-label={t("switchTo", { language: t(`names.${candidate}`) })}
            data-testid={`locale-switch-${candidate}`}
          >
            <Languages />
            {t(`names.${candidate}`)}
          </Link>
        </Button>
      ))}
    </nav>
  );
}

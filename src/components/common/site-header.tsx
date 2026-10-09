import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

import { BrandMark } from "./brand-mark";
import { LocaleSwitcher } from "./locale-switcher";
import { ThemeToggle } from "./theme-toggle";

/** `actions`: extra controls for the end of the header (e.g. the sign-out button). */
export function SiteHeader({ actions }: { readonly actions?: ReactNode } = {}) {
  const t = useTranslations("common");

  return (
    <header className="border-b">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="rounded-md">
          <BrandMark label={t("appName")} />
        </Link>
        <div className="flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
          {actions}
        </div>
      </div>
    </header>
  );
}

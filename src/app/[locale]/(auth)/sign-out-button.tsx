import { LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

import { submitSignOut } from "./actions";

/** Sign-out control for signed-in pages (a plain form: works without JavaScript). */
export function SignOutButton() {
  const locale = useLocale();
  const t = useTranslations("auth.signOut");

  return (
    <form action={submitSignOut.bind(null, locale)}>
      <Button type="submit" variant="ghost" size="sm" data-testid="sign-out">
        <LogOut aria-hidden="true" />
        {t("submit")}
      </Button>
    </form>
  );
}

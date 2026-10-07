import { useTranslations } from "next-intl";

// Shown by protected pages when there is no valid session. Interim until the sign-in
// page exists (Phase 2, Step 5), which will replace this with a redirect to it.
export function SignInRequired() {
  const t = useTranslations("signInRequired");

  return (
    <main
      id="main"
      data-testid="sign-in-required"
      className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-24 sm:px-6"
    >
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("description")}</p>
    </main>
  );
}

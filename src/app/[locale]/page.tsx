import { BarChart3, Brain, CalendarClock, PenLine, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { SiteHeader } from "@/components/common/site-header";

const STEPS = [
  { key: "brand", icon: Brain },
  { key: "plan", icon: PenLine },
  { key: "publish", icon: CalendarClock },
  { key: "improve", icon: BarChart3 },
] as const satisfies readonly { key: string; icon: LucideIcon }[];

export default function HomePage() {
  const t = useTranslations("home");

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <section className="max-w-3xl space-y-6">
          <p className="inline-flex rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground">
            {t("eyebrow")}
          </p>
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            {t("title")}
          </h1>
          <p className="text-lg text-pretty text-muted-foreground">{t("subtitle")}</p>
        </section>

        <section aria-labelledby="loop-title" className="mt-20 space-y-8">
          <h2 id="loop-title" className="text-2xl font-semibold">
            {t("loopTitle")}
          </h2>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map(({ key, icon: Icon }, index) => (
              <li
                key={key}
                className="space-y-3 rounded-xl border bg-card p-6 text-card-foreground"
              >
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <span className="text-sm font-medium text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                </div>
                <h3 className="font-semibold">{t(`steps.${key}.title`)}</h3>
                <p className="text-sm text-muted-foreground">{t(`steps.${key}.description`)}</p>
              </li>
            ))}
          </ol>
          <p className="border-s-4 border-primary ps-4 text-muted-foreground">{t("principle")}</p>
        </section>
      </main>
    </>
  );
}

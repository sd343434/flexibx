import { redirect } from "@/i18n/navigation";
import { requireLocale } from "@/i18n/params";
import { requirePlatformAdminPage } from "@/server/admin/platform-admin";

/** The admin area's start page: its only section for now. */
export default async function AdminPage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const locale = requireLocale((await params).locale);
  await requirePlatformAdminPage(locale);
  return redirect({ href: "/admin/storage", locale });
}

import { getTranslations } from "next-intl/server";

import { requireLocale } from "@/i18n/params";
import { requirePlatformAdminPage } from "@/server/admin/platform-admin";
import { getStorageAdminPageView } from "@/server/admin/storage-admin-actions";
import type { StorageProviderId } from "@/server/storage/storage";

import {
  ChangeWriteProviderForm,
  ConnectionCheckButton,
  WasabiSettingsForm,
} from "./storage-forms";

// Platform admin → Storage settings. Shows provider status and object counts, Wasabi's
// non-secret settings (access keys: presence only) and the write-provider switch. Nothing
// here moves existing files.

export default async function AdminStoragePage({
  params,
}: {
  readonly params: Promise<{ locale: string }>;
}) {
  const locale = requireLocale((await params).locale);
  await requirePlatformAdminPage();
  const view = await getStorageAdminPageView();
  const t = await getTranslations({ locale, namespace: "admin.storage" });
  const ready: Record<StorageProviderId, boolean> = {
    LEGACY_S3: view.legacy.configured,
    WASABI: view.wasabi.ready,
  };
  const providers: readonly StorageProviderId[] = ["LEGACY_S3", "WASABI"];

  return (
    <div className="space-y-10" data-testid="admin-storage">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <section aria-labelledby="providers-title" className="space-y-4">
        <h3 id="providers-title" className="text-lg font-semibold">
          {t("providersTitle")}
        </h3>
        <ul className="space-y-3">
          {providers.map((id) => (
            <li key={id} className="space-y-2 rounded-lg border p-4" data-testid={`provider-${id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`providers.${id}`)}</span>
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {ready[id] ? t("configured") : t("notConfigured")}
                </span>
                {view.writeProvider === id ? (
                  <span
                    className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground"
                    data-testid="write-target"
                  >
                    {t("writeTarget")}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">{t(`providerHints.${id}`)}</p>
              <p className="text-sm">
                {t("objects", {
                  media: view.objects[id].media,
                  videos: view.objects[id].videoFiles,
                })}
              </p>
              <ConnectionCheckButton provider={id} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="wasabi-title" className="space-y-4">
        <h3 id="wasabi-title" className="text-lg font-semibold">
          {t("wasabi.title")}
        </h3>
        <p className="text-sm" data-testid="wasabi-credentials">
          {view.wasabi.credentialsPresent
            ? t("wasabi.credentialsPresent")
            : t("wasabi.credentialsMissing")}
        </p>
        {view.wasabi.missing.length === 0 ? null : (
          <p className="text-sm text-muted-foreground">
            {t("wasabi.missing", {
              fields: view.wasabi.missing.map((field) => t(`wasabi.fields.${field}`)).join(", "),
            })}
          </p>
        )}
        {view.wasabi.locationLocked ? (
          <p className="text-sm text-muted-foreground">{t("wasabi.locked")}</p>
        ) : null}
        <WasabiSettingsForm
          defaults={{
            region: view.wasabi.region ?? "",
            endpoint: view.wasabi.endpoint ?? "",
            bucket: view.wasabi.bucket ?? "",
          }}
          locked={view.wasabi.locationLocked}
        />
      </section>

      <section aria-labelledby="change-title" className="space-y-4">
        <h3 id="change-title" className="text-lg font-semibold">
          {t("change.title")}
        </h3>
        <ChangeWriteProviderForm
          current={view.writeProvider}
          options={providers.map((id) => ({ id, ready: ready[id] }))}
        />
      </section>

      <p className="text-sm text-muted-foreground">{t("policy")}</p>
    </div>
  );
}

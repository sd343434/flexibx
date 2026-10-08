import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import {
  Card,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { getMediaPage } from "@/server/marketing/marketing-queries";

import { submitDeleteMedia, submitMediaAltText } from "../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { UploadForm } from "./upload-form";

export default async function MediaRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getMediaPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("media.title")} message={t("common.forbidden")} />;
  }
  const size = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${format.number(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`
      : `${format.number(Math.ceil(bytes / 1024))} KB`;

  return (
    <div className="space-y-8">
      <PageHeader title={t("media.title")} description={t("media.description")} />

      {data.can.contentCreate ? (
        <Card title={t("media.uploadTitle")}>
          <UploadForm slug={workspace.slug} />
          <p className="text-xs text-muted-foreground">{t("media.videoDeferred")}</p>
        </Card>
      ) : (
        <Notice testId="view-only">{t("common.viewOnly")}</Notice>
      )}

      {data.media.length === 0 ? (
        <EmptyState message={t("media.empty")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="media-list">
          {data.media.map((asset) => (
            <li
              key={asset.id}
              className="space-y-3 overflow-hidden rounded-lg border"
              data-testid="media-row"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- access-checked API route, not an optimizable static asset */}
              <img
                src={`/api/w/${workspace.slug}/media/${asset.id}`}
                alt={asset.altText ?? ""}
                width={asset.width ?? undefined}
                height={asset.height ?? undefined}
                loading="lazy"
                className="aspect-video w-full bg-muted object-contain"
                data-testid="media-image"
              />
              <div className="space-y-2 px-4 pb-4">
                <p className="truncate text-sm font-medium" dir="auto" title={asset.filename}>
                  {asset.filename}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("media.size", {
                    width: asset.width ?? 0,
                    height: asset.height ?? 0,
                    size: size(asset.sizeBytes),
                  })}
                  {" · "}
                  {t("media.usedIn", { count: asset._count.contentLinks })}
                </p>
                {asset.uploadedBy === null ? null : (
                  <p className="text-xs text-muted-foreground">
                    {t("media.uploadedBy", { name: asset.uploadedBy.name })}
                  </p>
                )}
                {data.can.contentEdit ? (
                  <>
                    <EntityForm
                      action={submitMediaAltText.bind(null, workspace.slug, locale, asset.id)}
                      fields={[
                        {
                          kind: "text",
                          name: "altText",
                          label: t("media.altText"),
                          maxLength: 500,
                          defaultValue: asset.altText ?? "",
                          wide: true,
                        },
                      ]}
                      submitLabel={t("media.saveAlt")}
                      testId={`media-alt-${asset.id}`}
                    />
                    <ActionButton
                      action={submitDeleteMedia.bind(null, workspace.slug, locale, asset.id)}
                      label={t("media.delete")}
                      confirm={t("media.deleteConfirm")}
                      danger
                      testId="media-delete"
                    />
                  </>
                ) : asset.altText === null ? null : (
                  <p className="text-sm">{asset.altText}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

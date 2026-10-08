import { getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import { ForbiddenNotice, Notice, PageHeader } from "@/components/marketing/page-parts";
import { getBrandPage } from "@/server/marketing/marketing-queries";

import { brandFields } from "../form-fields";
import { submitBrand } from "../marketing-actions";
import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";
import { BrandTabs } from "../section-tabs";

/** The brand profile: editable with brand.edit, read-only with brand.view. */
export default async function BrandRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "marketing" });
  const data = await guardPage(getBrandPage(workspace.slug));
  if (data === null) {
    return <ForbiddenNotice title={t("brand.title")} message={t("common.forbidden")} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("brand.title")} description={t("brand.description")} />
      <BrandTabs locale={locale} slug={workspace.slug} active="profile" />
      {data.can.brandEdit ? null : <Notice testId="view-only">{t("common.viewOnly")}</Notice>}
      {data.brand === null && !data.can.brandEdit ? (
        <Notice testId="empty-state">{t("brand.empty")}</Notice>
      ) : (
        <EntityForm
          action={submitBrand.bind(null, workspace.slug, locale)}
          fields={brandFields(t, data.brand)}
          submitLabel={t("brand.submit")}
          testId="brand-form"
          readOnly={!data.can.brandEdit}
        />
      )}
    </div>
  );
}

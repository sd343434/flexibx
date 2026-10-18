import { getFormatter, getTranslations } from "next-intl/server";

import { EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getStudioList } from "@/server/creator/creator-actions";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { submitCreateProject } from "./actions";
import { PROJECT_STATUS_TONES } from "./status-tones";

// Creator Studio (Pass 8): a project is one uploaded video or audio and everything made
// from it — transcript, translations, suggested clips and rendered exports.

export default async function StudioRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "studio" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getStudioList(workspace.slug));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const base = `/w/${workspace.slug}/studio`;

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      {data.canCreate ? (
        <Card title={t("create.title")} testId="studio-create">
          <EntityForm
            action={submitCreateProject.bind(null, workspace.slug, locale)}
            testId="studio-create-form"
            submitLabel={t("create.submit")}
            pendingLabel={t("create.pending")}
            fields={[
              {
                kind: "text",
                name: "name",
                label: t("create.name"),
                required: true,
                maxLength: 200,
              },
              {
                kind: "textarea",
                name: "description",
                label: t("create.descriptionField"),
                maxLength: 2000,
                rows: 2,
              },
            ]}
          />
        </Card>
      ) : null}
      <Card title={t("list.title")} testId="studio-projects">
        {data.projects.length === 0 ? (
          <EmptyState message={t("list.empty")} testId="studio-empty" />
        ) : (
          <ul className="divide-y">
            {data.projects.map((project) => (
              <li
                key={project.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid="studio-project"
              >
                <div className="min-w-0 space-y-1">
                  <Link
                    href={`${base}/${project.id}`}
                    className="font-medium break-words hover:underline"
                  >
                    {project.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {t("list.counts", {
                      clips: project._count.clips,
                      exports: project._count.exports,
                    })}
                    {" · "}
                    {format.dateTime(project.updatedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </div>
                <Badge
                  tone={PROJECT_STATUS_TONES[project.status]}
                  testId={`studio-project-status-${project.status}`}
                >
                  {t(`projectStatus.${project.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

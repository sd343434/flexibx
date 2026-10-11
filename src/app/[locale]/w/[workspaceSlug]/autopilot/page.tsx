import { Bot } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ActionButton, EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import { Card, ForbiddenNotice, Notice } from "@/components/marketing/page-parts";
import { cn } from "@/lib/utils";
import { getAutopilotPage } from "@/server/orchestration/automation-queries";
import { formatDeletionTime } from "@/server/videos/retention-policy";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import { submitAutomationPaused, submitAutomationPolicy, submitPlanningRun } from "./actions";
import { ApprovalList, Capabilities, ExceptionList, RunList } from "./autopilot-views";

/**
 * The AI Marketing Manager: its status and emergency stop, what it did (runs and their
 * steps), what needs a person, the policy it works within and its boundaries. Everything
 * shown is read from persisted runs; every control posts to a server action.
 */
export default async function AutopilotRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "automation" });
  const data = await guardPage(getAutopilotPage(workspace.slug));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const { policy } = data;
  const status = policy.paused
    ? "paused"
    : policy.enabled && policy.nextPlanningAt !== null
      ? "active"
      : "off";

  const fields: readonly FieldSpec[] = [
    {
      kind: "checkbox",
      name: "enabled",
      label: t("policy.enabled"),
      defaultChecked: policy.enabled,
    },
    {
      kind: "select",
      name: "planningCadence",
      label: t("policy.cadence"),
      defaultValue: policy.planningCadence === "OFF" ? "WEEKLY" : policy.planningCadence,
      options: (["DAILY", "WEEKLY"] as const).map((value) => ({
        value,
        label: t(`policy.cadences.${value}`),
      })),
    },
    {
      kind: "checkbox",
      name: "allowDrafts",
      label: t("policy.allowDrafts"),
      hint: t("policy.allowDraftsHint"),
      defaultChecked: policy.allowDrafts,
    },
    {
      kind: "select",
      name: "maxDraftsPerRun",
      label: t("policy.maxDrafts"),
      defaultValue: String(policy.maxDraftsPerRun),
      options: Array.from({ length: 10 }, (_, index) => ({
        value: String(index + 1),
        label: String(index + 1),
      })),
    },
  ];

  return (
    <div className="space-y-6">
      <section
        className="flex flex-col gap-5 rounded-2xl bg-feature p-5 text-feature-foreground sm:p-7 lg:flex-row lg:items-center lg:justify-between"
        data-testid="automation-manager"
        data-status={status}
      >
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white/10">
            <Bot aria-hidden="true" className="size-6" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium tracking-[0.14em] uppercase opacity-80">
              {workspace.name}
            </p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t("title")}</h1>
            <p className="text-sm text-feature-muted">{t("description")}</p>
            <p
              className="flex flex-wrap items-center gap-2 pt-1 text-sm"
              data-testid="automation-status"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 rounded-full",
                  status === "active"
                    ? "bg-lime"
                    : status === "paused"
                      ? "bg-destructive"
                      : "bg-white/40",
                )}
              />
              <span className="font-semibold">{t(`status.${status}`)}</span>
              <span className="text-feature-muted">
                {status === "active" && policy.nextPlanningAt !== null
                  ? t("statusHint.active", {
                      date: formatDeletionTime(policy.nextPlanningAt, locale, data.timeZone),
                    })
                  : t(`statusHint.${status}`)}
              </span>
            </p>
            {policy.delegate === null ? null : (
              <p className="text-xs text-feature-muted">
                {t("delegate", { name: policy.delegate.name })}
              </p>
            )}
          </div>
        </div>
        {data.canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {policy.paused ? (
              <ActionButton
                action={submitAutomationPaused.bind(null, workspace.slug, locale, false)}
                label={t("resume")}
                variant="default"
                testId="automation-resume"
              />
            ) : (
              <>
                <ActionButton
                  action={submitPlanningRun.bind(null, workspace.slug, locale)}
                  label={t("runNow")}
                  variant="default"
                  testId="automation-run-now"
                />
                <ActionButton
                  action={submitAutomationPaused.bind(null, workspace.slug, locale, true)}
                  label={t("stop")}
                  confirm={t("stopConfirm")}
                  danger
                  testId="automation-stop"
                />
              </>
            )}
          </div>
        ) : null}
      </section>

      {data.aiConfigured ? null : <Notice testId="automation-ai-off">{t("aiOff")}</Notice>}
      {data.canManage ? null : <Notice testId="automation-read-only">{t("readOnly")}</Notice>}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0 space-y-6">
          <Card title={t("approvals.title")} testId="automation-approvals-card">
            <ApprovalList
              slug={workspace.slug}
              locale={locale}
              timeZone={data.timeZone}
              approvals={data.pendingApprovals}
              canApprove={data.canApprove}
            />
          </Card>
          <Card title={t("exceptions.title")} testId="automation-attention">
            <ExceptionList exceptions={data.exceptions} />
          </Card>
          <section aria-labelledby="automation-activity" className="space-y-3">
            <h2 id="automation-activity" className="text-lg font-bold">
              {t("runs.title")}
            </h2>
            <RunList
              slug={workspace.slug}
              locale={locale}
              timeZone={data.timeZone}
              runs={data.runs}
              canManage={data.canManage}
            />
          </section>
        </div>
        <div className="min-w-0 space-y-6">
          <Card title={t("policy.title")} testId="automation-policy">
            <p className="text-sm text-muted-foreground">{t("policy.hint")}</p>
            <EntityForm
              action={submitAutomationPolicy.bind(null, workspace.slug, locale)}
              fields={fields}
              submitLabel={t("policy.save")}
              pendingLabel={t("policy.saving")}
              testId="automation-policy-form"
              readOnly={!data.canManage}
            />
          </Card>
          <Card title={t("capabilities.title")} testId="automation-boundaries">
            <Capabilities />
          </Card>
        </div>
      </div>
    </div>
  );
}

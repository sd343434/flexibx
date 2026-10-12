import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getAgentPage } from "@/server/social/social-actions";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../../page-data";
import {
  submitAgent,
  submitAgentActive,
  submitApplyGuidance,
  submitDismissLesson,
  submitRule,
  submitSelfReview,
} from "../../actions";

/**
 * One AI social agent: its knowledge and limits, what it learned (examples, rules,
 * guidance proposals), its self-review, and its numbers. Owners and admins change it;
 * others read it.
 */
export default async function AgentRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { agentId: string }>;
}) {
  const routeParams = await params;
  const { locale, workspace } = await openWorkspacePage(Promise.resolve(routeParams));
  const t = await getTranslations({ locale, namespace: "social" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getAgentPage(workspace.slug, routeParams.agentId));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const { agent, metrics } = data;
  const slug = workspace.slug;
  const proposals = data.lessons.filter((lesson) => lesson.kind === "GUIDANCE");
  const rules = data.lessons.filter((lesson) => lesson.kind === "RULE");
  const examples = data.lessons.filter((lesson) => lesson.kind === "EXAMPLE");

  const fields: readonly FieldSpec[] = [
    {
      kind: "text",
      name: "name",
      label: t("agentForm.name"),
      required: true,
      maxLength: 120,
      defaultValue: agent.name,
    },
    {
      kind: "select",
      name: "role",
      label: t("agentForm.role"),
      required: true,
      defaultValue: agent.role,
      options: (["customer_service", "sales", "community"] as const).map((role) => ({
        value: role,
        label: t(`roles.${role}`),
      })),
    },
    {
      kind: "select",
      name: "language",
      label: t("agentForm.language"),
      required: true,
      defaultValue: agent.language,
      options: (["auto", "ar", "en"] as const).map((value) => ({
        value,
        label: t(`languages.${value}`),
      })),
    },
    {
      kind: "text",
      name: "tone",
      label: t("agentForm.tone"),
      maxLength: 500,
      defaultValue: agent.tone,
    },
    {
      kind: "textarea",
      name: "businessInfo",
      label: t("agentForm.businessInfo"),
      hint: t("agentForm.businessInfoHint"),
      rows: 5,
      wide: true,
      defaultValue: agent.businessInfo,
    },
    {
      kind: "textarea",
      name: "faq",
      label: t("agentForm.faq"),
      hint: t("agentForm.faqHint"),
      rows: 5,
      wide: true,
      defaultValue: agent.faq.map((item) => `${item.q} :: ${item.a}`).join("\n"),
    },
    {
      kind: "textarea",
      name: "policies",
      label: t("agentForm.policies"),
      rows: 3,
      wide: true,
      defaultValue: agent.policies,
    },
    {
      kind: "textarea",
      name: "escalation",
      label: t("agentForm.escalation"),
      hint: t("agentForm.escalationHint"),
      rows: 2,
      wide: true,
      defaultValue: agent.escalation,
    },
    {
      kind: "textarea",
      name: "forbidden",
      label: t("agentForm.forbidden"),
      rows: 2,
      wide: true,
      defaultValue: agent.forbidden,
    },
    {
      kind: "select",
      name: "mode",
      label: t("agentForm.mode"),
      hint: t("agentForm.modeHint"),
      required: true,
      defaultValue: agent.mode,
      options: (["SUGGEST", "AUTO"] as const).map((mode) => ({
        value: mode,
        label: t(`modes.${mode}`),
      })),
    },
    {
      kind: "multiselect",
      name: "autoCategories",
      label: t("agentForm.autoCategories"),
      emptyLabel: t("agentForm.noAutoCategories"),
      defaultValue: agent.autoCategories,
      options: (["question", "praise", "lead", "other"] as const).map((value) => ({
        value,
        label: t(`categories.${value}`),
      })),
    },
    {
      kind: "number",
      name: "minConfidence",
      label: t("agentForm.minConfidence"),
      hint: t("agentForm.minConfidenceHint"),
      defaultValue: String(agent.minConfidence),
      dir: "ltr",
    },
    {
      kind: "number",
      name: "dailyAutoCap",
      label: t("agentForm.dailyAutoCap"),
      defaultValue: String(agent.dailyAutoCap),
      dir: "ltr",
    },
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href={`/w/${slug}/social`} className="underline-offset-4 hover:underline">
          {t("agentPage.back")}
        </Link>
      </p>
      <PageHeader title={agent.name} description={t("agentPage.description")} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={agent.active ? "solid" : "muted"}>
          {agent.active ? t("agents.active") : t("agents.paused")}
        </Badge>
        <Badge tone="outline">{t(`modes.${agent.mode}`)}</Badge>
        <Badge tone="muted">
          {t("agents.guidanceVersion", { version: agent.guidanceVersion })}
        </Badge>
        {data.canManage ? (
          <ActionButton
            action={submitAgentActive.bind(null, slug, locale, agent.id, !agent.active)}
            label={agent.active ? t("agentPage.pause") : t("agentPage.activate")}
            confirm={agent.active ? undefined : t("agentPage.activateConfirm")}
            variant={agent.active ? "outline" : "default"}
            testId="social-agent-toggle"
          />
        ) : null}
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="social-agent-stats">
        {(
          [
            ["replied", metrics.replied],
            ["automatic", metrics.automatic],
            ["edited", metrics.edited],
            ["rejected", metrics.rejected],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-xl border bg-card p-4">
            <p className="text-2xl font-bold">{format.number(value)}</p>
            <p className="text-xs text-muted-foreground">{t(`stats.${key}`)}</p>
          </div>
        ))}
      </section>

      <Card title={t("learning.title")} testId="social-learning">
        <p className="text-sm text-muted-foreground">{t("learning.hint")}</p>
        <ol className="grid gap-2 text-sm sm:grid-cols-3">
          {(["collect", "learn", "update"] as const).map((step, index) => (
            <li key={step} className="rounded-md border p-3">
              <span className="font-semibold">
                {index + 1}. {t(`learning.steps.${step}.title`)}
              </span>
              <p className="text-muted-foreground">{t(`learning.steps.${step}.body`)}</p>
            </li>
          ))}
        </ol>
        {data.canManage ? (
          <ActionButton
            action={submitSelfReview.bind(null, slug, locale, agent.id)}
            label={t("learning.review", { count: data.reviewPrice })}
            testId="social-self-review"
          />
        ) : null}
        {proposals.length === 0 ? null : (
          <ul className="space-y-3">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="space-y-2 rounded-lg border p-3 text-sm"
                data-testid="social-proposal"
              >
                <p className="font-medium">{t("learning.proposal")}</p>
                {proposal.draftText === null ? null : (
                  <ul className="list-disc ps-5">
                    {proposal.draftText.split("\n").map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="cursor-pointer">{t("learning.fullGuidance")}</summary>
                  <p className="mt-2 whitespace-pre-wrap" dir="auto">
                    {proposal.content}
                  </p>
                </details>
                {data.canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      action={submitApplyGuidance.bind(null, slug, locale, proposal.id)}
                      label={t("learning.apply")}
                      variant="default"
                    />
                    <ActionButton
                      action={submitDismissLesson.bind(null, slug, locale, proposal.id)}
                      label={t("learning.dismiss")}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("learning.currentGuidance")}</p>
          <p className="text-sm whitespace-pre-wrap text-muted-foreground" dir="auto">
            {agent.guidance === "" ? t("learning.noGuidance") : agent.guidance}
          </p>
        </div>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card title={t("learning.rules")}>
          {rules.length === 0 ? (
            <EmptyState message={t("learning.noRules")} />
          ) : (
            <ul className="space-y-2 text-sm">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-start justify-between gap-2 rounded-md border p-2"
                >
                  <span dir="auto">{rule.content}</span>
                  {data.canManage ? (
                    <ActionButton
                      action={submitDismissLesson.bind(null, slug, locale, rule.id)}
                      label={t("learning.remove")}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {data.canManage ? (
            <EntityForm
              action={submitRule.bind(null, slug, locale, agent.id)}
              fields={[
                { kind: "text", name: "rule", label: t("learning.addRule"), maxLength: 500 },
              ]}
              submitLabel={t("learning.add")}
              pendingLabel={t("actions.sending")}
              testId="social-rule-form"
            />
          ) : null}
        </Card>
        <Card title={t("learning.examples")}>
          {examples.length === 0 ? (
            <EmptyState message={t("learning.noExamples")} />
          ) : (
            <ul className="space-y-2 text-sm">
              {examples.slice(0, 20).map((example) => (
                <li key={example.id} className="space-y-1 rounded-md border p-2">
                  <p className="text-muted-foreground" dir="auto">
                    {example.customerText}
                  </p>
                  <p dir="auto">↳ {example.content}</p>
                  <div className="flex items-center justify-between">
                    <Badge tone="muted">{t(`learning.sources.${example.source as "edit"}`)}</Badge>
                    {data.canManage ? (
                      <ActionButton
                        action={submitDismissLesson.bind(null, slug, locale, example.id)}
                        label={t("learning.remove")}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {data.canManage ? (
        <Card title={t("agentPage.settings")} testId="social-agent-form">
          <EntityForm
            action={submitAgent.bind(null, slug, locale, agent.id)}
            fields={fields}
            submitLabel={t("agentPage.save")}
            pendingLabel={t("actions.sending")}
            testId="social-agent-settings"
          />
        </Card>
      ) : null}
    </div>
  );
}

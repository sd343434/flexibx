import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  EmptyState,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getSocialPage, INBOX_FILTERS, type InboxFilter } from "@/server/social/social-actions";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../page-data";

import {
  submitApprove,
  submitAgent,
  submitAssignChannel,
  submitIgnore,
  submitPull,
  submitRedraft,
  submitReject,
  submitResolve,
  submitRetry,
  submitSubscribe,
  submitSyncChannels,
} from "./actions";

/**
 * AI Social Manager: the inbox of comments and messages from the workspace's Facebook
 * Pages and Instagram accounts, the AI agents that draft the replies, and their numbers.
 * Every reply is decided on the server: a person approves, edits or rejects, or an agent
 * in automatic mode sends low-risk replies within its limits.
 */
export default async function SocialRoute({
  params,
  searchParams,
}: {
  readonly params: Promise<WorkspaceRouteParams>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "social" });
  const format = await getFormatter({ locale });
  const raw = (await searchParams).filter;
  const filter: InboxFilter = INBOX_FILTERS.find((value) => value === raw) ?? "review";
  const data = await guardPage(getSocialPage(workspace.slug, filter));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const slug = workspace.slug;
  const m = data.metrics;
  const when = (value: Date) => format.relativeTime(value);

  const stats = [
    { key: "received", value: format.number(m.received) },
    { key: "replied", value: format.number(m.replied) },
    { key: "waiting", value: format.number(m.waiting + m.escalated) },
    { key: "acceptance", value: m.acceptanceRate === null ? "—" : `${String(m.acceptanceRate)}%` },
    {
      key: "response",
      value:
        m.medianResponseMinutes === null
          ? "—"
          : t("stats.minutes", { count: m.medianResponseMinutes }),
    },
    { key: "automatic", value: format.number(m.automatic) },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      {!data.metaConfigured ? (
        <Notice testId="social-not-configured">{t("setup.notConfigured")}</Notice>
      ) : null}
      {data.metaConfigured && !data.metaConnected ? (
        <Notice testId="social-not-connected">
          {t("setup.notConnected")}{" "}
          <Link href={`/w/${slug}/integrations`} className="underline">
            {t("setup.openIntegrations")}
          </Link>
        </Notice>
      ) : null}
      {!data.aiConfigured ? <Notice testId="social-ai-off">{t("setup.aiOff")}</Notice> : null}
      {data.metaConfigured && !data.webhookConfigured ? (
        <Notice>{t("setup.webhookOff")}</Notice>
      ) : null}

      <section
        aria-label={t("stats.label")}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        data-testid="social-stats"
      >
        {stats.map((stat) => (
          <div key={stat.key} className="rounded-xl border bg-card p-4" data-stat={stat.key}>
            <p className="text-2xl font-bold">{stat.value}</p>
            <p className="text-xs text-muted-foreground">{t(`stats.${stat.key}`)}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-muted-foreground">{t("stats.hint")}</p>

      <Card title={t("inbox.title")} testId="social-inbox">
        <nav aria-label={t("inbox.filters")} className="flex flex-wrap gap-2 text-sm">
          {INBOX_FILTERS.map((value) => (
            <Link
              key={value}
              href={`/w/${slug}/social?filter=${value}`}
              className={`rounded-full border px-3 py-1 ${value === filter ? "bg-primary text-primary-foreground" : ""}`}
              aria-current={value === filter ? "page" : undefined}
            >
              {t(`inbox.filter.${value}`)}
            </Link>
          ))}
        </nav>
        <p className="text-xs text-muted-foreground">
          {t("inbox.cost", { count: data.replyPrice })}
        </p>
        {data.interactions.length === 0 ? (
          <EmptyState message={t("inbox.empty")} testId="social-inbox-empty" />
        ) : (
          <ul className="space-y-3">
            {data.interactions.map((item) => {
              const reply = item.reply;
              const pending = reply !== null && reply.decision === "PENDING";
              return (
                <li
                  key={item.id}
                  className="space-y-3 rounded-lg border p-3"
                  data-testid="social-interaction"
                  data-status={item.status}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone="outline">{t(`platforms.${item.channel.platform}`)}</Badge>
                    <Badge tone="muted">{t(`kinds.${item.kind}`)}</Badge>
                    <span className="font-medium">{item.authorName ?? t("inbox.someone")}</span>
                    <span className="text-muted-foreground">
                      · {item.channel.name} · {when(item.receivedAt)}
                    </span>
                    <Badge tone={item.status === "REPLIED" ? "solid" : "outline"}>
                      {t(`status.${item.status}`)}
                    </Badge>
                    {item.category === null ? null : (
                      <Badge tone="muted">{t(`categories.${item.category as "question"}`)}</Badge>
                    )}
                  </div>
                  <p className="text-sm whitespace-pre-wrap" dir="auto">
                    {item.text}
                  </p>
                  {item.lastError === null ? null : (
                    <p className="text-sm text-destructive" role="status">
                      {t.has(`errors.${item.lastError}` as never)
                        ? t(`errors.${item.lastError}` as "errors.window_closed")
                        : t("errors.other")}
                    </p>
                  )}
                  {reply === null ? null : (
                    <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
                      <p className="text-xs text-muted-foreground">
                        {item.agent?.name ?? t("inbox.agent")} ·{" "}
                        {t("inbox.confidence", { value: reply.confidence })}
                        {reply.needsHuman ? ` · ${t("inbox.needsHuman")}` : ""}
                      </p>
                      <p className="whitespace-pre-wrap" dir="auto" data-testid="social-draft">
                        {reply.finalText ?? reply.draftText ?? t("inbox.noDraft")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("inbox.reason")}: {reply.reason}
                      </p>
                      {pending && data.canReply ? (
                        <div className="space-y-2">
                          {reply.draftText === null ? null : (
                            <ActionButton
                              action={submitApprove.bind(null, slug, locale, reply.id)}
                              label={t("actions.approve")}
                              variant="default"
                              testId="social-approve"
                            />
                          )}
                          <EntityForm
                            action={submitApprove.bind(null, slug, locale, reply.id)}
                            fields={[
                              {
                                kind: "textarea",
                                name: "text",
                                label: t("actions.editLabel"),
                                defaultValue: reply.draftText ?? "",
                                rows: 3,
                              },
                            ]}
                            submitLabel={t("actions.editAndSend")}
                            pendingLabel={t("actions.sending")}
                            testId="social-edit"
                          />
                          <EntityForm
                            action={submitReject.bind(null, slug, locale, reply.id)}
                            fields={[
                              {
                                kind: "text",
                                name: "reason",
                                label: t("actions.rejectReason"),
                                hint: t("actions.rejectHint"),
                                maxLength: 500,
                              },
                            ]}
                            submitLabel={t("actions.reject")}
                            pendingLabel={t("actions.sending")}
                            testId="social-reject"
                          />
                        </div>
                      ) : null}
                      {data.canReply && reply.sendStatus === "UNCERTAIN" ? (
                        <div className="flex flex-wrap gap-2" data-testid="social-uncertain">
                          <p className="w-full text-sm">{t("uncertain.hint")}</p>
                          {item.kind === "COMMENT" ? (
                            <ActionButton
                              action={submitResolve.bind(null, slug, locale, reply.id, "check")}
                              label={t("uncertain.check")}
                            />
                          ) : null}
                          <ActionButton
                            action={submitResolve.bind(null, slug, locale, reply.id, "sent")}
                            label={t("uncertain.sent")}
                          />
                          <ActionButton
                            action={submitResolve.bind(null, slug, locale, reply.id, "not_sent")}
                            label={t("uncertain.notSent")}
                          />
                        </div>
                      ) : null}
                      {data.canReply &&
                      reply.sendStatus === "FAILED" &&
                      reply.decision !== "PENDING" &&
                      reply.decision !== "REJECTED" ? (
                        <ActionButton
                          action={submitRetry.bind(null, slug, locale, reply.id)}
                          label={t("actions.retry")}
                        />
                      ) : null}
                    </div>
                  )}
                  {data.canReply &&
                  ["AWAITING_REVIEW", "ESCALATED", "FAILED", "NEW"].includes(item.status) ? (
                    <div className="flex flex-wrap gap-2">
                      {item.status !== "NEW" ? (
                        <ActionButton
                          action={submitRedraft.bind(null, slug, locale, item.id)}
                          label={t("actions.redraft", { count: data.replyPrice })}
                        />
                      ) : null}
                      <ActionButton
                        action={submitIgnore.bind(null, slug, locale, item.id)}
                        label={t("actions.ignore")}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card title={t("channels.title")} testId="social-channels">
          <p className="text-sm text-muted-foreground">{t("channels.hint")}</p>
          {data.canManage && data.metaConnected ? (
            <ActionButton
              action={submitSyncChannels.bind(null, slug, locale)}
              label={t("channels.sync")}
              testId="social-sync"
            />
          ) : null}
          {data.channels.length === 0 ? (
            <EmptyState message={t("channels.empty")} />
          ) : (
            <ul className="space-y-3">
              {data.channels.map((channel) => (
                <li
                  key={channel.id}
                  className="space-y-2 rounded-lg border p-3 text-sm"
                  data-testid="social-channel"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="outline">{t(`platforms.${channel.platform}`)}</Badge>
                    <span className="font-medium">{channel.name}</span>
                    {!channel.enabled ? <Badge tone="muted">{t("channels.off")}</Badge> : null}
                    {channel.subscribed ? <Badge tone="muted">{t("channels.live")}</Badge> : null}
                  </div>
                  {data.canManage ? (
                    <EntityForm
                      action={submitAssignChannel.bind(null, slug, locale, channel.id)}
                      fields={[
                        {
                          kind: "select",
                          name: "agentId",
                          label: t("channels.agent"),
                          options: data.agents.map((agent) => ({
                            value: agent.id,
                            label: agent.name,
                          })),
                          emptyLabel: t("channels.noAgent"),
                          defaultValue: channel.agentId ?? "",
                        },
                        {
                          kind: "checkbox",
                          name: "enabled",
                          label: t("channels.enabled"),
                          defaultChecked: channel.enabled,
                        },
                      ]}
                      submitLabel={t("channels.save")}
                      pendingLabel={t("actions.sending")}
                      testId="social-channel-form"
                    />
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {data.canManage && !channel.subscribed && channel.platform === "FACEBOOK" ? (
                      <ActionButton
                        action={submitSubscribe.bind(null, slug, locale, channel.id)}
                        label={t("channels.subscribe")}
                      />
                    ) : null}
                    {data.canReply && channel.enabled ? (
                      <ActionButton
                        action={submitPull.bind(null, slug, locale, channel.id)}
                        label={t("channels.pull")}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("agents.title")} testId="social-agents">
          <p className="text-sm text-muted-foreground">{t("agents.hint")}</p>
          {data.agents.length === 0 ? (
            <EmptyState message={t("agents.empty")} />
          ) : (
            <ul className="space-y-2">
              {data.agents.map((agent) => (
                <li
                  key={agent.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                >
                  <Link
                    href={`/w/${slug}/social/agents/${agent.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {agent.name}
                  </Link>
                  <span className="flex flex-wrap gap-2">
                    <Badge tone={agent.active ? "solid" : "muted"}>
                      {agent.active ? t("agents.active") : t("agents.paused")}
                    </Badge>
                    <Badge tone="outline">{t(`modes.${agent.mode}`)}</Badge>
                    <Badge tone="muted">
                      {t("agents.guidanceVersion", { version: agent.guidanceVersion })}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.canManage ? (
            <EntityForm
              action={submitAgent.bind(null, slug, locale, null)}
              fields={[
                {
                  kind: "text",
                  name: "name",
                  label: t("agentForm.name"),
                  required: true,
                  maxLength: 120,
                },
                {
                  kind: "select",
                  name: "role",
                  label: t("agentForm.role"),
                  required: true,
                  options: (["customer_service", "sales", "community"] as const).map((role) => ({
                    value: role,
                    label: t(`roles.${role}`),
                  })),
                },
                {
                  kind: "textarea",
                  name: "businessInfo",
                  label: t("agentForm.businessInfo"),
                  hint: t("agentForm.businessInfoHint"),
                  rows: 4,
                  wide: true,
                },
              ]}
              submitLabel={t("agents.create")}
              pendingLabel={t("actions.sending")}
              testId="social-agent-create"
            />
          ) : null}
        </Card>
      </div>
    </div>
  );
}

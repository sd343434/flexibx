import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, Clock, Lock } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { ActionButton, inputClass } from "@/components/marketing/entity-form";
import { Badge, EmptyState } from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { AutopilotPage } from "@/server/orchestration/automation-queries";
import { formatDeletionTime } from "@/server/videos/retention-policy";

import { submitAdvanceRun, submitApprovalDecision, submitCancelRun } from "./actions";

// Views of what the AI Marketing Manager does: its runs (each step with its honest
// state), the approvals and exceptions that need a person, and the boundaries it works
// within.
// Display only — every button posts to a server action that re-checks access.

type Run = AutopilotPage["runs"][number];
type RunState = Run["state"];
type TaskState = Run["tasks"][number]["state"];

const RUN_TONES = {
  PENDING: "outline",
  RUNNING: "accent",
  SUCCEEDED: "solid",
  FAILED: "muted",
  CANCELLED: "muted",
  NEEDS_ATTENTION: "accent",
} as const satisfies Record<RunState, "outline" | "accent" | "solid" | "muted">;

const TASK_ICONS = {
  PENDING: CircleDashed,
  RUNNING: Clock,
  SUCCEEDED: CircleCheck,
  FAILED: CircleAlert,
  SKIPPED: CircleSlash,
  CANCELLED: CircleSlash,
  NEEDS_APPROVAL: Lock,
} as const satisfies Record<TaskState, unknown>;

const KNOWN_TASKS = ["observe", "plan_ideas", "create_drafts", "report"] as const;
const KNOWN_FAILURES = [
  "ai_not_configured",
  "ai_daily_cap",
  "actor_no_access",
  "approval_required",
  "timeout",
  "lease_expired",
  "approval_rejected",
  "outcome_unknown",
  "invalid_action",
] as const;

/** A run's failure code (`task:code`, `approval_required:task`, `actor_no_access`) → message key. */
export function failureMessageKey(code: string | null) {
  const parts = (code ?? "").split(":");
  const candidates = [parts[0], parts[parts.length - 1]];
  const known = candidates.find((part): part is (typeof KNOWN_FAILURES)[number] =>
    (KNOWN_FAILURES as readonly string[]).includes(part ?? ""),
  );
  return known === undefined ? ("failure.other" as const) : (`failure.${known}` as const);
}

interface Summary {
  readonly ideas: number | undefined;
  readonly draftsCreated: number | undefined;
  readonly emptyDaysNext7: number | undefined;
  readonly contentIds: readonly string[];
}

/** The run's stored report (counts and ids only), read defensively. */
function summaryOf(value: unknown): Summary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const number = (key: string) => {
    const entry = record[key];
    return typeof entry === "number" ? entry : undefined;
  };
  return {
    ideas: number("ideas"),
    draftsCreated: number("draftsCreated"),
    emptyDaysNext7: number("emptyDaysNext7"),
    contentIds: Array.isArray(record.contentIds)
      ? record.contentIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function RunList({
  slug,
  locale,
  timeZone,
  runs,
  canManage,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly runs: AutopilotPage["runs"];
  readonly canManage: boolean;
}) {
  const t = useTranslations("automation");
  if (runs.length === 0)
    return <EmptyState message={t("runs.empty")} testId="automation-runs-empty" />;
  return (
    <ol className="space-y-3" data-testid="automation-runs">
      {runs.map((run) => {
        const summary = run.state === "SUCCEEDED" ? summaryOf(run.summary) : null;
        const active = run.state === "PENDING" || run.state === "RUNNING";
        return (
          <li
            key={run.id}
            className="space-y-3 rounded-xl border bg-card p-4"
            data-testid="automation-run"
            data-run-id={run.id}
            data-state={run.state}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">
                  {run.trigger === "SCHEDULE"
                    ? t("runs.scheduled")
                    : t("runs.manual", { name: run.requestedBy?.name ?? "—" })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("runs.started", { date: formatDeletionTime(run.createdAt, locale, timeZone) })}
                </p>
              </div>
              <Badge tone={RUN_TONES[run.state]} testId="automation-run-state">
                {t(`runState.${run.state}`)}
              </Badge>
            </div>

            <ol className="grid gap-1.5 sm:grid-cols-2" aria-label={t("runs.title")}>
              {run.tasks.map((task) => {
                const Icon = TASK_ICONS[task.state];
                const label = (KNOWN_TASKS as readonly string[]).includes(task.key)
                  ? t(`tasks.${task.key as (typeof KNOWN_TASKS)[number]}`)
                  : task.key;
                return (
                  <li
                    key={task.key}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-2 py-1 text-sm",
                      task.state === "FAILED" || task.state === "NEEDS_APPROVAL"
                        ? "bg-destructive/10"
                        : "bg-muted/60",
                    )}
                    data-task={task.key}
                    data-state={task.state}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`taskState.${task.state}`)}
                      {task.attempts > 1
                        ? ` · ${t("attempts", { count: task.attempts, max: task.maxAttempts })}`
                        : ""}
                    </span>
                  </li>
                );
              })}
            </ol>

            {summary === null ? null : (
              <div className="space-y-1 text-sm" data-testid="automation-run-summary">
                {summary.emptyDaysNext7 === undefined ? null : (
                  <p>{t("runs.emptyDays", { count: summary.emptyDaysNext7 })}</p>
                )}
                {summary.ideas === undefined ? null : (
                  <p>{t("runs.ideas", { count: summary.ideas })}</p>
                )}
                <p>{t("runs.draftsCreated", { count: summary.draftsCreated ?? 0 })}</p>
                {summary.contentIds.length === 0 ? null : (
                  <ul className="flex flex-wrap gap-2">
                    {summary.contentIds.map((id, index) => (
                      <li key={id}>
                        <Link
                          href={`/w/${slug}/content/${id}`}
                          className="text-primary underline-offset-4 hover:underline"
                          data-testid="automation-draft-link"
                        >
                          {t("runs.openDraft", { number: index + 1 })}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {run.state === "FAILED" || run.state === "NEEDS_ATTENTION" ? (
              <p
                className="text-sm text-destructive"
                role="alert"
                data-testid="automation-run-failure"
              >
                {t(failureMessageKey(run.failureCode))}
              </p>
            ) : null}

            {canManage && (active || run.state === "NEEDS_ATTENTION") ? (
              <div className="flex flex-wrap gap-2">
                {active ? (
                  <ActionButton
                    action={submitAdvanceRun.bind(null, slug, locale, run.id)}
                    label={t("runs.continue")}
                    testId="automation-run-continue"
                  />
                ) : null}
                <ActionButton
                  action={submitCancelRun.bind(null, slug, locale, run.id)}
                  label={t("runs.cancel")}
                  variant="ghost"
                  testId="automation-run-cancel"
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ExceptionList({
  exceptions,
}: {
  readonly exceptions: AutopilotPage["exceptions"];
}) {
  const t = useTranslations("automation");
  if (exceptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="automation-exceptions-empty">
        {t("exceptions.empty")}
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="automation-exceptions">
      {exceptions.map((run) => (
        <li
          key={run.id}
          className="flex items-start gap-2 rounded-lg border border-destructive/30 p-3 text-sm"
          data-run-id={run.id}
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{t(failureMessageKey(run.failureCode))}</span>
        </li>
      ))}
    </ul>
  );
}

/** Minor units → the currency's major units (2 decimals for SAR, 0 for JPY, 3 for KWD). */
function majorUnits(minor: number, currency: string): number {
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return minor / 10 ** digits;
}

function detailText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Tasks waiting for a person: the exact action (and amount, for spending) as it will run,
 * with Approve / Reject (each confirmed first, each with an optional note). What is shown
 * is what is decided: the form carries the action's hash, and a changed action is refused.
 */
export function ApprovalList({
  slug,
  locale,
  timeZone,
  approvals,
  canApprove,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly approvals: AutopilotPage["pendingApprovals"];
  readonly canApprove: boolean;
}) {
  const t = useTranslations("automation");
  const format = useFormatter();
  if (approvals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="automation-approvals-empty">
        {t("approvals.empty")}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="automation-approvals">
      {approvals.map((approval) => {
        const { snapshot } = approval;
        const amount =
          snapshot.amount === null
            ? null
            : format.number(majorUnits(snapshot.amount.minor, snapshot.amount.currency), {
                style: "currency",
                currency: snapshot.amount.currency,
              });
        const label = (KNOWN_TASKS as readonly string[]).includes(approval.key)
          ? t(`tasks.${approval.key as (typeof KNOWN_TASKS)[number]}`)
          : approval.key;
        const decide = (decision: "APPROVED" | "REJECTED") =>
          submitApprovalDecision.bind(
            null,
            slug,
            locale,
            approval.taskId,
            decision,
            approval.snapshotHash,
          );
        const note = (
          <input
            type="text"
            name="note"
            maxLength={500}
            dir="auto"
            aria-label={t("approvals.note")}
            placeholder={t("approvals.note")}
            className={cn(inputClass, "h-9 w-full sm:w-56")}
          />
        );
        return (
          <li
            key={approval.taskId}
            className="space-y-3 rounded-xl border border-destructive/30 p-4"
            data-testid="automation-approval"
            data-task-id={approval.taskId}
            data-risk={snapshot.risk}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {t("approvals.requested", {
                    date: formatDeletionTime(approval.requestedAt, locale, timeZone),
                  })}
                </p>
              </div>
              <Badge tone="accent">{t(`approvals.risk.${snapshot.risk}`)}</Badge>
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-muted-foreground">{t("approvals.action")}</dt>
              <dd
                className="font-mono break-all"
                dir="ltr"
                data-testid="automation-approval-action"
              >
                {snapshot.action}
              </dd>
              {amount === null ? null : (
                <>
                  <dt className="text-muted-foreground">{t("approvals.amount")}</dt>
                  <dd className="font-semibold" data-testid="automation-approval-amount">
                    {amount}
                  </dd>
                </>
              )}
              {Object.entries(snapshot.details).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-muted-foreground" dir="ltr">
                    {key}
                  </dt>
                  <dd className="break-words" dir="auto">
                    {detailText(value)}
                  </dd>
                </div>
              ))}
            </dl>
            {canApprove ? (
              <div className="flex flex-wrap gap-3">
                <ActionButton
                  action={decide("APPROVED")}
                  label={t("approvals.approve")}
                  confirm={
                    amount === null
                      ? t("approvals.approveConfirm")
                      : t("approvals.approveSpendConfirm", { amount })
                  }
                  variant="default"
                  testId="automation-approve"
                >
                  {note}
                </ActionButton>
                <ActionButton
                  action={decide("REJECTED")}
                  label={t("approvals.reject")}
                  confirm={t("approvals.rejectConfirm")}
                  danger
                  testId="automation-reject"
                >
                  {note}
                </ActionButton>
              </div>
            ) : (
              <p
                className="text-sm text-muted-foreground"
                data-testid="automation-approval-readonly"
              >
                {t("approvals.cannotDecide")}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const CAPABILITIES = [
  { key: "observe", level: "auto" },
  { key: "plan", level: "auto" },
  { key: "drafts", level: "auto" },
  { key: "publish", level: "notYet" },
  { key: "spend", level: "notYet" },
  { key: "approvals", level: "approval" },
  { key: "permissions", level: "approval" },
] as const;

/** The boundaries automation works within (what exists today, honestly labelled). */
export function Capabilities() {
  const t = useTranslations("automation");
  return (
    <ul className="space-y-2" data-testid="automation-capabilities">
      {CAPABILITIES.map((capability) => (
        <li
          key={capability.key}
          className="flex items-center justify-between gap-3 text-sm"
          data-capability={capability.key}
          data-level={capability.level}
        >
          <span>{t(`capabilities.items.${capability.key}`)}</span>
          <Badge tone={capability.level === "auto" ? "solid" : "outline"}>
            {t(`capabilities.${capability.level}`)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

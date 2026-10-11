import { getFormatter, getTranslations } from "next-intl/server";

import { ActionButton, EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import {
  Badge,
  Card,
  Detail,
  ForbiddenNotice,
  Notice,
  PageHeader,
} from "@/components/marketing/page-parts";
import { Link } from "@/i18n/navigation";
import { getAdPlanPage } from "@/server/ads/ads-queries";
import { PLATFORM_PLACEMENTS } from "@/server/ads/model";
import { formatMajor } from "@/server/ads/planner-math";

import { guardPage, openWorkspacePage, type WorkspaceRouteParams } from "../../../page-data";
import { submitPlanCommand, submitSelectIdentity, submitUpdatePlan } from "../../actions";
import { ExpectedResultsView, ExternalActions, MoneyText } from "../../ads-views";

/**
 * The review screen of one campaign plan: objective, audience, placements, creative,
 * budget, dates, expected results (only when the account's history supports them), and
 * the exact external calls a launch would make. Launching is only ever a request for
 * approval, and only where the platform's write path exists.
 */
export default async function AdPlanRoute({
  params,
}: {
  readonly params: Promise<WorkspaceRouteParams & { readonly planId: string }>;
}) {
  const { planId } = await params;
  const { locale, workspace } = await openWorkspacePage(params);
  const t = await getTranslations({ locale, namespace: "ads" });
  const format = await getFormatter({ locale });
  const data = await guardPage(getAdPlanPage(workspace.slug, planId));
  if (data === null) return <ForbiddenNotice title={t("title")} message={t("forbidden")} />;
  const { review } = data;
  const spec = review.spec;
  const editable = data.canPlan && review.status === "DRAFT";
  const dailyAverage = {
    minor: Math.floor(review.budget.minor / review.days),
    currency: review.budget.currency,
  };
  const reopenable =
    data.canPlan &&
    (review.status === "FAILED" ||
      (review.status === "SUBMITTED" && ["FAILED", "CANCELLED"].includes(review.runState ?? "")));

  const editFields: readonly FieldSpec[] =
    spec === null
      ? []
      : [
          {
            kind: "text",
            name: "budget",
            label: t("planForm.budget"),
            defaultValue: formatMajor(review.budget),
            dir: "ltr",
            required: true,
            maxLength: 20,
          },
          {
            kind: "date",
            name: "startDate",
            label: t("planForm.start"),
            defaultValue: review.startDate,
            required: true,
          },
          {
            kind: "date",
            name: "endDate",
            label: t("planForm.end"),
            defaultValue: review.endDate,
            required: true,
          },
          {
            kind: "text",
            name: "campaignName",
            label: t("review.campaignName"),
            defaultValue: spec.campaignName,
            maxLength: 200,
            required: true,
            wide: true,
          },
          {
            kind: "text",
            name: "headline",
            label: t("review.headline"),
            defaultValue: spec.creative.headline,
            maxLength: 120,
            required: true,
            wide: true,
          },
          {
            kind: "textarea",
            name: "primaryText",
            label: t("review.primaryText"),
            defaultValue: spec.creative.primaryText,
            maxLength: 1000,
            rows: 4,
            required: true,
            wide: true,
          },
          {
            kind: "multiselect",
            name: "placements",
            label: t("review.placements"),
            hint: t("identity.placementsHint"),
            emptyLabel: t("placements.AUTOMATIC"),
            defaultValue: spec.placements.filter((placement) => placement !== "AUTOMATIC"),
            options: PLATFORM_PLACEMENTS[review.platform]
              .filter((placement) => placement !== "AUTOMATIC")
              .map((placement) => ({ value: placement, label: t(`placements.${placement}`) })),
            wide: true,
          },
          {
            kind: "url",
            name: "destinationUrl",
            label: t("review.destination"),
            defaultValue: spec.creative.destinationUrl ?? "",
            dir: "ltr",
            maxLength: 2000,
            wide: true,
          },
        ];
  const { execution } = review;

  return (
    <div className="space-y-6" data-testid="ads-review" data-status={review.status}>
      <PageHeader
        title={review.name}
        description={`${t(`platforms.${review.platform}.name`)} · ${review.account.name}`}
        actions={
          <Badge
            tone={review.status === "LAUNCHED" ? "solid" : "outline"}
            testId="ads-review-status"
          >
            {t(`planStatus.${review.status as "DRAFT"}`)}
          </Badge>
        }
      />
      <Link
        href={`/w/${workspace.slug}/ads`}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        {t("review.back")}
      </Link>

      {spec === null ? (
        <Notice testId="ads-review-invalid">{t("review.invalid")}</Notice>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card title={t("review.campaign")} testId="ads-review-campaign">
            <dl className="grid gap-3">
              <Detail label={t("review.objective")}>
                <span data-testid="ads-review-objective" data-value={spec.objective}>
                  {t(`objectives.${spec.objective}`)}
                </span>
              </Detail>
              {review.platform === "META" && spec.objective === "MESSAGES" ? (
                <p className="text-sm" data-testid="ads-review-whatsapp">
                  {t("review.whatsappDestination")}
                </p>
              ) : null}
              <Detail label={t("review.rationale")}>{spec.rationale}</Detail>
            </dl>
          </Card>
          <Card title={t("review.budgetAndDates")} testId="ads-review-budget">
            <dl className="grid gap-3">
              <Detail label={t("review.totalBudget")}>
                <span data-testid="ads-review-total">
                  <MoneyText money={review.budget} />
                </span>
              </Detail>
              <Detail label={t("review.dailyAverage")}>
                <MoneyText money={dailyAverage} />
              </Detail>
              <Detail label={t("review.duration")}>
                <span dir="ltr">
                  {review.startDate} → {review.endDate}
                </span>{" "}
                ({t("review.days", { count: review.days })})
              </Detail>
              <p className="text-xs text-muted-foreground">{t("review.moneyNote")}</p>
            </dl>
          </Card>
          <Card title={t("review.audience")} testId="ads-review-audience">
            <dl className="grid gap-3">
              <Detail label={t("review.audienceDescription")}>{spec.audience.description}</Detail>
              <Detail label={t("review.countries")}>
                <span dir="ltr">{spec.audience.countries.join(", ")}</span>
              </Detail>
              <Detail label={t("review.ages")}>
                <span dir="ltr">
                  {spec.audience.ageMin}–{spec.audience.ageMax}
                </span>
              </Detail>
              <Detail label={t("review.genders")}>{t(`genders.${spec.audience.genders}`)}</Detail>
              <Detail label={t("review.interests")}>
                {spec.audience.interests.length === 0 ? "—" : spec.audience.interests.join("، ")}
              </Detail>
              <Detail label={t("review.placements")}>
                <span data-testid="ads-review-placements">
                  {spec.placements.map((placement) => t(`placements.${placement}`)).join(" · ")}
                </span>
              </Detail>
            </dl>
          </Card>
          <Card title={t("review.creative")} testId="ads-review-creative">
            <dl className="grid gap-3">
              <Detail label={t("review.headline")}>{spec.creative.headline}</Detail>
              <Detail label={t("review.primaryText")}>{spec.creative.primaryText}</Detail>
              <Detail label={t("review.destination")}>
                <span dir="ltr" className="break-all" data-testid="ads-review-destination">
                  {spec.creative.destinationUrl ?? "—"}
                </span>
              </Detail>
              <Detail label={t("review.callToAction")}>
                {t(`ctas.${spec.creative.callToAction}`)}
              </Detail>
              <Detail label={t("review.image")}>
                {review.media === null ? (
                  t("review.noImage")
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- served by the app's own media route
                  <img
                    src={`/api/w/${encodeURIComponent(workspace.slug)}/media/${review.media.id}`}
                    alt={review.media.altText ?? review.media.filename}
                    className="max-h-48 rounded-md border"
                    data-testid="ads-review-image"
                  />
                )}
              </Detail>
            </dl>
          </Card>
          <Card title={t("review.expected")} testId="ads-review-expected">
            <ExpectedResultsView expected={review.expected} />
          </Card>
          <Card title={t("review.launch")} testId="ads-review-launch">
            {review.status === "LAUNCHED" ? (
              <p className="text-sm" data-testid="ads-review-launched">
                {t("review.launched", { id: review.externalCampaignId ?? "—" })}
              </p>
            ) : review.status === "SUBMITTED" ? (
              <p className="text-sm" data-testid="ads-review-submitted">
                {t("review.submitted")}{" "}
                <Link
                  href={`/w/${workspace.slug}/autopilot`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {t("review.openApprovals")}
                </Link>
              </p>
            ) : !review.launch.available ? (
              <p
                className="text-sm"
                data-testid="ads-launch-unavailable"
                data-reason={review.launch.reason}
              >
                {t(`review.launchUnavailable.${review.launch.reason}`)}
                {review.launch.reason === "not_supported" ? (
                  <> {t(`platforms.${review.platform}.launchNote`)}</>
                ) : null}
              </p>
            ) : data.canSubmit && review.status === "DRAFT" ? (
              <ActionButton
                action={submitPlanCommand.bind(null, workspace.slug, locale, review.id, "submit")}
                label={t("review.requestLaunch")}
                confirm={t("review.requestLaunchConfirm")}
                variant="default"
                testId="ads-request-launch"
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("review.adminOnly")}</p>
            )}
            {review.failureCode === null ? null : (
              <p className="text-sm text-destructive" role="alert" data-testid="ads-review-failure">
                {t("review.failed")}
              </p>
            )}
            {reopenable ? (
              <ActionButton
                action={submitPlanCommand.bind(null, workspace.slug, locale, review.id, "reopen")}
                label={t("review.reopen")}
                testId="ads-plan-reopen"
              />
            ) : null}
          </Card>
        </div>
      )}

      {execution.identityRequired && spec !== null ? (
        <Card title={t("identity.title")} testId="ads-identity">
          <p className="text-sm text-muted-foreground">{t("identity.hint")}</p>
          <p
            className="text-sm"
            data-testid="ads-identity-chosen"
            data-value={execution.identity ?? ""}
          >
            {execution.identity === null
              ? t("identity.none")
              : t("identity.chosen", { name: execution.identityName ?? execution.identity })}
          </p>
          {editable ? (
            <>
              <ActionButton
                action={submitPlanCommand.bind(
                  null,
                  workspace.slug,
                  locale,
                  review.id,
                  "identities",
                )}
                label={t("identity.load")}
                testId="ads-identity-load"
              />
              {execution.identityOptions.length === 0 ? (
                execution.identityCheckedAt === null ? null : (
                  <p
                    className="text-sm text-destructive"
                    role="alert"
                    data-testid="ads-identity-empty"
                  >
                    {t("identity.empty")}
                  </p>
                )
              ) : (
                <EntityForm
                  action={submitSelectIdentity.bind(null, workspace.slug, locale, review.id)}
                  fields={[
                    {
                      kind: "select",
                      name: "identityId",
                      label: t("identity.choose"),
                      required: true,
                      defaultValue: execution.identity ?? "",
                      options: execution.identityOptions.map((option) => ({
                        value: option.id,
                        label: option.name,
                      })),
                    },
                  ]}
                  submitLabel={t("identity.save")}
                  pendingLabel={t("planForm.pending")}
                  testId="ads-identity-form"
                />
              )}
            </>
          ) : null}
        </Card>
      ) : null}

      {execution.steps.length === 0 && execution.activationStatus === null ? null : (
        <Card title={t("execution.title")} testId="ads-execution">
          <p className="text-sm text-muted-foreground">{t("execution.hint")}</p>
          {execution.steps.length === 0 ? null : (
            <ul className="grid gap-2 text-sm" data-testid="ads-execution-steps">
              {execution.steps.map((step) => (
                <li
                  key={step.step}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`ads-step-${step.step}`}
                  data-status={step.status}
                >
                  <span className="font-medium">{t(`execution.steps.${step.step as "ad"}`)}</span>
                  <Badge tone={step.status === "SUCCEEDED" ? "solid" : "outline"}>
                    {t(`execution.stepStatus.${step.status as "SUCCEEDED"}`)}
                  </Badge>
                  {step.externalId === null ? null : (
                    <span dir="ltr" className="text-xs text-muted-foreground">
                      {step.externalId}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <dl className="mt-4 grid gap-3">
            <Detail label={t("execution.platformStatus")}>
              <span data-testid="ads-external-status">{execution.externalStatus ?? "—"}</span>
              {execution.externalCheckedAt === null ? null : (
                <span className="text-xs text-muted-foreground">
                  {" "}
                  (
                  {t("execution.checkedAt", {
                    date: format.dateTime(execution.externalCheckedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: data.timeZone,
                    }),
                  })}
                  )
                </span>
              )}
            </Detail>
            <Detail label={t("execution.activation")}>
              <span
                data-testid="ads-activation-status"
                data-value={execution.activationStatus ?? "NONE"}
              >
                {t(
                  `execution.activationStatus.${(execution.activationStatus ?? "NONE") as "NONE"}`,
                )}
              </span>
            </Detail>
          </dl>
          {execution.canRequestActivation && data.canSubmit ? (
            <ActionButton
              action={submitPlanCommand.bind(null, workspace.slug, locale, review.id, "activate")}
              label={t("execution.requestActivation")}
              confirm={t("execution.requestActivationConfirm")}
              variant="default"
              testId="ads-request-activation"
            />
          ) : null}
          {execution.activationStatus === "REQUESTED" ? (
            <p className="text-sm">
              {t("execution.activationPending")}{" "}
              <Link
                href={`/w/${workspace.slug}/autopilot`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {t("review.openApprovals")}
              </Link>
            </p>
          ) : null}
        </Card>
      )}

      {review.externalActions === null ? null : (
        <Card title={t("review.externalActions")} testId="ads-review-actions">
          <p className="text-sm text-muted-foreground">{t("review.externalActionsHint")}</p>
          <ExternalActions actions={review.externalActions} />
        </Card>
      )}

      {editable ? (
        <Card title={t("review.edit")} testId="ads-plan-edit-card">
          <EntityForm
            action={submitUpdatePlan.bind(null, workspace.slug, locale, review.id)}
            fields={editFields}
            submitLabel={t("review.save")}
            pendingLabel={t("planForm.pending")}
            testId="ads-plan-edit"
          />
          <ActionButton
            action={submitPlanCommand.bind(null, workspace.slug, locale, review.id, "discard")}
            label={t("review.discard")}
            confirm={t("review.discardConfirm")}
            variant="ghost"
            danger
            testId="ads-plan-discard"
          />
        </Card>
      ) : null}
    </div>
  );
}

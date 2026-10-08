"use client";

import { Check, Copy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  submitChangeRole,
  submitInvite,
  submitLeaveWorkspace,
  submitRemoveMember,
  submitRevokeInvitation,
  type InviteFormState,
  type SimpleFormState,
} from "./actions";
import { actionErrorMessage } from "./error-message";

// Members-page forms. They only collect input and show results; what is allowed is
// decided on the server for every submission.

const inputClass =
  "h-10 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive";
const dangerClass = "border-destructive text-destructive hover:bg-destructive/10";

function FormError({ state }: { readonly state: SimpleFormState | InviteFormState }) {
  const t = useTranslations();
  if (state === null || !("error" in state)) return null;
  return (
    <p role="alert" className="text-sm text-destructive" data-testid="form-error">
      {actionErrorMessage(t, state.error)}
    </p>
  );
}

function CopyLink({ url }: { readonly url: string }) {
  const t = useTranslations("members.invite");
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <label htmlFor="invitation-link" className="block text-sm font-medium">
        {t("linkLabel")}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="invitation-link"
          readOnly
          dir="ltr"
          value={url}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className={inputClass}
          data-testid="invitation-link"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
    </div>
  );
}

export function InviteForm({
  slug,
  roles,
}: {
  readonly slug: string;
  readonly roles: readonly { readonly value: string; readonly label: string }[];
}) {
  const locale = useLocale();
  const t = useTranslations("members.invite");
  const tRoot = useTranslations();
  const [state, formAction, pending] = useActionState<InviteFormState, FormData>(
    submitInvite.bind(null, slug, locale),
    null,
  );
  const fieldError = (path: string) => {
    if (state === null || !("error" in state)) return undefined;
    const field = state.error.fields?.find((candidate) => candidate.path === path);
    if (field === undefined) return undefined;
    const key = `validation.${field.code}`;
    return tRoot.has(key as never)
      ? tRoot(key as never, field.params as never)
      : tRoot("validation.invalid");
  };
  const emailError = fieldError("email");
  const roleError = fieldError("role");
  const values = state !== null && "values" in state ? state.values : undefined;
  const created = state !== null && "created" in state ? state.created : undefined;

  return (
    <div className="space-y-4">
      <form
        action={formAction}
        className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        data-testid="invite-form"
      >
        <div className="space-y-2">
          <label htmlFor="invite-email" className="block text-sm font-medium">
            {t("email")}
          </label>
          <input
            id="invite-email"
            name="email"
            type="email"
            dir="ltr"
            required
            maxLength={254}
            autoComplete="off"
            defaultValue={values?.email}
            aria-invalid={emailError === undefined ? undefined : true}
            aria-describedby={emailError === undefined ? undefined : "invite-email-error"}
            className={inputClass}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="invite-role" className="block text-sm font-medium">
            {t("role")}
          </label>
          <select
            id="invite-role"
            name="role"
            defaultValue={values?.role ?? roles.at(-1)?.value}
            aria-invalid={roleError === undefined ? undefined : true}
            className={inputClass}
          >
            {roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending} data-testid="invite-submit">
          {pending ? t("submitting") : t("submit")}
        </Button>
      </form>
      {emailError === undefined ? null : (
        <p
          id="invite-email-error"
          role="alert"
          className="text-sm text-destructive"
          data-testid="invite-email-error"
        >
          {emailError}
        </p>
      )}
      {roleError === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {roleError}
        </p>
      )}
      {emailError === undefined && roleError === undefined ? <FormError state={state} /> : null}
      {created === undefined ? null : (
        <div role="status" className="space-y-3 rounded-md border p-4" data-testid="invite-result">
          <p className="font-medium">{t("created", { email: created.email })}</p>
          <p className="text-sm" data-testid="invite-delivery">
            {created.delivery.status === "sent"
              ? t("sent")
              : created.delivery.reason === "development"
                ? t("notSentDevelopment")
                : created.delivery.reason === "not_configured"
                  ? t("notSentNotConfigured")
                  : t("notSentFailed")}
          </p>
          <p className="text-sm text-muted-foreground">{t("shareLink")}</p>
          <CopyLink url={created.acceptUrl} />
        </div>
      )}
    </div>
  );
}

export function RoleForm({
  slug,
  memberId,
  name,
  current,
  roles,
}: {
  readonly slug: string;
  readonly memberId: string;
  readonly name: string;
  readonly current: string;
  readonly roles: readonly { readonly value: string; readonly label: string }[];
}) {
  const locale = useLocale();
  const t = useTranslations("members.list");
  const [state, formAction, pending] = useActionState<SimpleFormState, FormData>(
    submitChangeRole.bind(null, slug, locale),
    null,
  );
  const id = `role-${memberId}`;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2" data-testid="role-form">
      <input type="hidden" name="memberId" value={memberId} />
      <label htmlFor={id} className="sr-only">
        {t("changeRole", { name })}
      </label>
      <select
        id={id}
        name="role"
        defaultValue={current}
        className={`${inputClass} w-auto`}
        data-testid="role-select"
      >
        {roles.map((role) => (
          <option key={role.value} value={role.value}>
            {role.label}
          </option>
        ))}
      </select>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        data-testid="role-submit"
      >
        {pending ? t("saving") : t("save")}
      </Button>
      <FormError state={state} />
    </form>
  );
}

/** A destructive action behind a confirmation step (`<details>`, no dialog needed). */
function ConfirmForm({
  trigger,
  question,
  submit,
  pendingLabel,
  action,
  hidden,
  testId,
  state,
  pending,
}: {
  readonly trigger: string;
  readonly question: string;
  readonly submit: string;
  readonly pendingLabel: string;
  readonly action: (formData: FormData) => void;
  readonly hidden?: Readonly<Record<string, string>>;
  readonly testId: string;
  readonly state: SimpleFormState;
  readonly pending: boolean;
}) {
  return (
    <details className="group" data-testid={testId}>
      <summary
        className={`inline-flex h-9 cursor-pointer list-none items-center rounded-md border px-3 text-sm font-medium [&::-webkit-details-marker]:hidden ${dangerClass}`}
      >
        {trigger}
      </summary>
      <form action={action} className="mt-2 space-y-2 rounded-md border p-3">
        {Object.entries(hidden ?? {}).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <p className="text-sm">{question}</p>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          className={dangerClass}
          data-testid={`${testId}-confirm`}
        >
          {pending ? pendingLabel : submit}
        </Button>
        <FormError state={state} />
      </form>
    </details>
  );
}

export function RemoveMemberForm({
  slug,
  memberId,
  name,
}: {
  readonly slug: string;
  readonly memberId: string;
  readonly name: string;
}) {
  const locale = useLocale();
  const t = useTranslations("members.list");
  const [state, formAction, pending] = useActionState<SimpleFormState, FormData>(
    submitRemoveMember.bind(null, slug, locale),
    null,
  );
  return (
    <ConfirmForm
      trigger={t("remove")}
      question={t("removeConfirm", { name })}
      submit={t("removeSubmit")}
      pendingLabel={t("removing")}
      action={formAction}
      hidden={{ memberId }}
      testId="remove-member"
      state={state}
      pending={pending}
    />
  );
}

export function RevokeInvitationForm({
  slug,
  invitationId,
  email,
}: {
  readonly slug: string;
  readonly invitationId: string;
  readonly email: string;
}) {
  const locale = useLocale();
  const t = useTranslations("members.pending");
  const [state, formAction, pending] = useActionState<SimpleFormState, FormData>(
    submitRevokeInvitation.bind(null, slug, locale),
    null,
  );
  return (
    <ConfirmForm
      trigger={t("revoke")}
      question={t("revokeConfirm", { email })}
      submit={t("revokeSubmit")}
      pendingLabel={t("revoking")}
      action={formAction}
      hidden={{ invitationId }}
      testId="revoke-invitation"
      state={state}
      pending={pending}
    />
  );
}

export function LeaveWorkspaceForm({ slug }: { readonly slug: string }) {
  const locale = useLocale();
  const t = useTranslations("members.leave");
  const [state, formAction, pending] = useActionState<SimpleFormState, FormData>(
    submitLeaveWorkspace.bind(null, slug, locale),
    null,
  );
  return (
    <ConfirmForm
      trigger={t("submit")}
      question={t("confirm")}
      submit={t("confirmSubmit")}
      pendingLabel={t("leaving")}
      action={formAction}
      testId="leave-workspace"
      state={state}
      pending={pending}
    />
  );
}

import { getFormatter, getTranslations } from "next-intl/server";

import { requireLocale } from "@/i18n/params";
import { isAppError } from "@/server/errors/app-error";
import { getMembersPage, type MembersPage } from "@/server/workspaces/workspace-queries";

import { loadWorkspace } from "../load-workspace";

import {
  InviteForm,
  LeaveWorkspaceForm,
  RemoveMemberForm,
  RevokeInvitationForm,
  RoleForm,
} from "./member-forms";

interface MembersPageProps {
  readonly params: Promise<{ locale: string; workspaceSlug: string }>;
}

/** Members, pending invitations and leaving. Every control is re-authorized on submit. */
export default async function MembersRoute({ params }: MembersPageProps) {
  const { locale: rawLocale, workspaceSlug } = await params;
  const locale = requireLocale(rawLocale);
  const { workspace } = await loadWorkspace(locale, workspaceSlug);
  const t = await getTranslations({ locale, namespace: "members" });
  const tRoles = await getTranslations({ locale, namespace: "workspaces.roles" });
  const format = await getFormatter({ locale });

  let data: MembersPage;
  try {
    data = await getMembersPage(workspace.slug);
  } catch (error) {
    if (!isAppError(error) || error.code !== "FORBIDDEN") throw error;
    return (
      <section className="space-y-3">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground" data-testid="members-forbidden">
          {t("forbidden")}
        </p>
      </section>
    );
  }

  const roleOptions = data.grantableRoles.map((role) => ({ value: role, label: tRoles(role) }));
  const date = (value: Date) => format.dateTime(value, { dateStyle: "medium" });

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </header>

      {data.canInvite ? (
        <section aria-labelledby="invite-title" className="space-y-3 rounded-lg border p-4 sm:p-6">
          <h2 id="invite-title" className="text-lg font-semibold">
            {t("invite.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("invite.description")}</p>
          <InviteForm slug={workspace.slug} roles={roleOptions} />
        </section>
      ) : null}

      <section aria-labelledby="members-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="members-title" className="text-lg font-semibold">
            {t("list.label")}
          </h2>
          <p className="text-sm text-muted-foreground" data-testid="member-count">
            {t("count", { count: data.members.length })}
          </p>
        </div>
        <ul className="divide-y rounded-lg border" data-testid="member-list">
          {data.members.map((member) => (
            <li
              key={member.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid="member-row"
              data-email={member.email}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate font-medium">
                  {member.name}
                  {member.isSelf ? (
                    <span className="ms-2 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                      {t("you")}
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-sm text-muted-foreground" dir="ltr">
                  <bdi>{member.email}</bdi>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("joined", { date: date(member.joinedAt) })}
                </p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {member.canChangeRole ? (
                  <RoleForm
                    slug={workspace.slug}
                    memberId={member.id}
                    name={member.name}
                    current={member.role}
                    roles={
                      roleOptions.some((option) => option.value === member.role)
                        ? roleOptions
                        : [{ value: member.role, label: tRoles(member.role) }, ...roleOptions]
                    }
                  />
                ) : (
                  <span className="rounded-md border px-3 py-1.5 text-sm" data-testid="member-role">
                    {tRoles(member.role)}
                  </span>
                )}
                {member.canRemove ? (
                  <RemoveMemberForm slug={workspace.slug} memberId={member.id} name={member.name} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {data.canInvite ? (
        <section aria-labelledby="pending-title" className="space-y-3">
          <h2 id="pending-title" className="text-lg font-semibold">
            {t("pending.title")}
          </h2>
          {data.invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="pending-empty">
              {t("pending.empty")}
            </p>
          ) : (
            <ul className="divide-y rounded-lg border" data-testid="pending-list">
              {data.invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  data-testid="pending-row"
                  data-email={invitation.email}
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate font-medium" dir="ltr">
                      <bdi>{invitation.email}</bdi>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {tRoles(invitation.role)} ·{" "}
                      {invitation.expired
                        ? t("pending.expired")
                        : t("pending.expires", { date: date(invitation.expiresAt) })}
                    </p>
                    {invitation.invitedBy === null ? null : (
                      <p className="text-xs text-muted-foreground">
                        {t("pending.invitedBy", { name: invitation.invitedBy })}
                      </p>
                    )}
                  </div>
                  {data.grantableRoles.includes(invitation.role) ? (
                    <RevokeInvitationForm
                      slug={workspace.slug}
                      invitationId={invitation.id}
                      email={invitation.email}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section
        aria-labelledby="leave-title"
        className="space-y-3 rounded-lg border border-destructive/40 p-4 sm:p-6"
      >
        <h2 id="leave-title" className="text-lg font-semibold">
          {t("leave.title")}
        </h2>
        {data.isLastOwner ? (
          <p className="text-sm text-muted-foreground" data-testid="leave-last-owner">
            {t("leave.lastOwner")}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("leave.description")}</p>
            <LeaveWorkspaceForm slug={workspace.slug} />
          </>
        )}
      </section>
    </div>
  );
}

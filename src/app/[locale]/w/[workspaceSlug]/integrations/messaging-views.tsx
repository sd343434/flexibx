import { useTranslations } from "next-intl";

import { ActionButton, EntityForm, type FieldSpec } from "@/components/marketing/entity-form";
import { Badge, EmptyState } from "@/components/marketing/page-parts";
import type { IntegrationsPage } from "@/server/ads/ads-queries";
import { formatDeletionTime } from "@/server/videos/retention-policy";
import { CONSENT_SOURCES } from "@/server/whatsapp/contacts";

import {
  submitResolveMessage,
  submitWhatsAppContact,
  submitWhatsAppOptOut,
  submitWhatsAppSend,
} from "./actions";

// WhatsApp messaging: contacts who opted in (masked numbers), recording an opt-in or an
// opt-out, asking to send ONE message to ONE contact (it waits for an owner's or admin's
// approval), and the recorded statuses of recent messages. No lists, no bulk sends.

export function WhatsAppMessaging({
  slug,
  locale,
  timeZone,
  data,
  requestKey,
}: {
  readonly slug: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly data: IntegrationsPage;
  /** Fixed per render, so a double submit asks only once. */
  readonly requestKey: string;
}) {
  const t = useTranslations("integrations.messaging");
  const usable = data.whatsapp.filter((account) => account.usable);
  const accountName = new Map(data.whatsapp.map((account) => [account.id, account.name]));
  const optedIn = data.contacts.filter((contact) => contact.consentStatus === "OPTED_IN");
  const senders = usable.flatMap((account) =>
    (account.snapshot?.phoneNumbers ?? []).map((number) => ({
      value: `${account.id}|${number.id}`,
      label: `${account.name} · ${number.maskedNumber}`,
    })),
  );
  const templates = usable.flatMap((account) =>
    (account.snapshot?.templates ?? [])
      .filter((template) => template.status === "APPROVED")
      .map((template) => ({
        value: `${template.name}|${template.language}`,
        label: `${template.name} (${template.language}) · ${account.name}`,
      })),
  );
  const date = (value: Date) => formatDeletionTime(value, locale, timeZone);

  const contactFields: readonly FieldSpec[] = [
    {
      kind: "select",
      name: "accountId",
      label: t("account"),
      required: true,
      options: usable.map((account) => ({ value: account.id, label: account.name })),
    },
    {
      kind: "text",
      name: "phone",
      label: t("phone"),
      hint: t("phoneHint"),
      dir: "ltr",
      required: true,
      maxLength: 40,
      placeholder: "+9665XXXXXXXX",
    },
    {
      kind: "select",
      name: "consentSource",
      label: t("consentSource"),
      required: true,
      options: CONSENT_SOURCES.map((source) => ({
        value: source,
        label: t(`consentSources.${source}`),
      })),
    },
    { kind: "checkbox", name: "consentConfirmed", label: t("consentConfirmed"), wide: true },
  ];

  const sendFields: readonly FieldSpec[] = [
    { kind: "select", name: "sender", label: t("sender"), required: true, options: senders },
    {
      kind: "select",
      name: "contactId",
      label: t("recipient"),
      required: true,
      options: optedIn.map((contact) => ({
        value: contact.id,
        label: `${contact.maskedNumber} · ${accountName.get(contact.accountId) ?? ""}${
          contact.windowOpen ? ` · ${t("windowOpen")}` : ""
        }`,
      })),
    },
    {
      kind: "select",
      name: "message",
      label: t("message"),
      required: true,
      options: [...templates, { value: "__text__", label: t("freeText") }],
    },
    {
      kind: "textarea",
      name: "parameters",
      label: t("parameters"),
      hint: t("parametersHint"),
      rows: 3,
      maxLength: 2000,
      wide: true,
    },
    {
      kind: "textarea",
      name: "text",
      label: t("text"),
      hint: t("textHint"),
      rows: 3,
      maxLength: 4096,
      wide: true,
    },
  ];

  return (
    <div className="space-y-6">
      <p
        className="text-sm"
        data-testid="whatsapp-sending-flag"
        data-enabled={String(data.sendingEnabled)}
      >
        {data.sendingEnabled ? t("sendingOn") : t("sendingOff")}
      </p>

      <section className="space-y-2" data-testid="whatsapp-contacts">
        <h3 className="text-sm font-semibold">{t("contacts")}</h3>
        <p className="text-xs text-muted-foreground">{t("contactsHint")}</p>
        {data.contacts.length === 0 ? (
          <EmptyState message={t("noContacts")} testId="whatsapp-contacts-empty" />
        ) : (
          <ul className="space-y-2">
            {data.contacts.map((contact) => (
              <li
                key={contact.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                data-testid="whatsapp-contact"
                data-consent={contact.consentStatus}
              >
                <span>
                  <bdi dir="ltr" className="tabular-nums">
                    {contact.maskedNumber}
                  </bdi>{" "}
                  · {accountName.get(contact.accountId) ?? "—"}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={contact.consentStatus === "OPTED_IN" ? "outline" : "muted"}>
                    {t(`consent.${contact.consentStatus as "OPTED_IN"}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t(`consentSources.${contact.consentSource as "other"}`)} ·{" "}
                    {date(contact.consentAt)}
                  </span>
                  {contact.windowOpen ? <Badge tone="outline">{t("windowOpen")}</Badge> : null}
                  {contact.marketingOptedOutAt === null ? null : (
                    <Badge tone="muted" testId="whatsapp-marketing-opted-out">
                      {t("marketingOptedOut")}
                    </Badge>
                  )}
                  {data.canPlan && contact.consentStatus === "OPTED_IN" ? (
                    <ActionButton
                      action={submitWhatsAppOptOut.bind(null, slug, locale, contact.id)}
                      label={t("optOut")}
                      confirm={t("optOutConfirm")}
                      variant="ghost"
                      testId="whatsapp-opt-out"
                    />
                  ) : null}
                </span>
                {contact.history.length === 0 ? null : (
                  <ol
                    className="w-full space-y-0.5 text-xs text-muted-foreground"
                    data-testid="whatsapp-consent-history"
                  >
                    {contact.history.map((event, index) => (
                      <li key={`${event.kind}:${String(index)}`} data-kind={event.kind}>
                        {t(`consentEvents.${event.kind}`)} ·{" "}
                        {t(`consentSources.${event.source as "other"}`)} · {date(event.occurredAt)}
                        {event.actorName === null ? "" : ` · ${event.actorName}`}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.canPlan && usable.length > 0 ? (
          <EntityForm
            action={submitWhatsAppContact.bind(null, slug, locale)}
            fields={contactFields}
            submitLabel={t("addContact")}
            pendingLabel={t("pending")}
            testId="whatsapp-contact-form"
          />
        ) : null}
      </section>

      <section className="space-y-2" data-testid="whatsapp-send">
        <h3 className="text-sm font-semibold">{t("send")}</h3>
        <p className="text-xs text-muted-foreground">{t("sendHint")}</p>
        {!data.sendingEnabled ? null : !data.canSend ? (
          <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>
        ) : senders.length === 0 || optedIn.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="whatsapp-send-unready">
            {t("sendUnready")}
          </p>
        ) : (
          <EntityForm
            action={submitWhatsAppSend.bind(null, slug, locale, requestKey)}
            fields={sendFields}
            submitLabel={t("requestSend")}
            pendingLabel={t("pending")}
            testId="whatsapp-send-form"
          />
        )}
      </section>

      <section className="space-y-2" data-testid="whatsapp-messages">
        <h3 className="text-sm font-semibold">{t("messages")}</h3>
        <p className="text-xs text-muted-foreground">{t("messagesHint")}</p>
        {data.messages.length === 0 ? (
          <EmptyState message={t("noMessages")} testId="whatsapp-messages-empty" />
        ) : (
          <ul className="space-y-2">
            {data.messages.map((message) => (
              <li
                key={message.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                data-testid="whatsapp-message"
                data-status={message.status}
              >
                <span>
                  <bdi dir="ltr" className="tabular-nums">
                    {message.to}
                  </bdi>{" "}
                  ·{" "}
                  {message.kind === "TEMPLATE" ? (
                    <bdi dir="ltr">
                      {message.templateName} ({message.templateLanguage})
                    </bdi>
                  ) : (
                    t("freeText")
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={message.status === "FAILED" ? "muted" : "outline"}>
                    {t(`status.${message.status as "PENDING"}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {date(message.statusAt ?? message.createdAt)}
                  </span>
                  {message.status === "UNCERTAIN" && message.resolvedAt !== null ? (
                    <Badge tone="muted">{t("resolved")}</Badge>
                  ) : null}
                  {message.status === "UNCERTAIN" &&
                  message.resolvedAt === null &&
                  data.canResolve ? (
                    <ActionButton
                      action={submitResolveMessage.bind(null, slug, locale, message.id)}
                      label={t("resolve")}
                      confirm={t("resolveConfirm")}
                      variant="ghost"
                      testId="whatsapp-resolve"
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

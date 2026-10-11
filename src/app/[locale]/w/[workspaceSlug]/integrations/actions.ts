"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  addWhatsAppContactAction,
  optOutWhatsAppContactAction,
  requestWhatsAppSendAction,
  resolveWhatsAppMessageAction,
  selectAccountAction,
  syncWhatsAppAction,
} from "@/server/ads/ads-actions";

import type { MarketingFormState } from "../marketing-actions";

// Form entry points of the Integrations page (WhatsApp accounts). Connect, refresh and
// disconnect are the advertising forms (../ads/actions.ts), which return here too.

const toLocale = (value: string) => (isLocale(value) ? value : DEFAULT_LOCALE);
const integrationsPath = (locale: string, slug: string) =>
  `/${toLocale(locale)}/w/${encodeURIComponent(slug)}/integrations`;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function back(path: string): never {
  revalidatePath(path);
  redirect(path);
}

export async function submitSelectWhatsApp(
  slug: string,
  locale: string,
  accountId: string,
  selected: boolean,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await selectAccountAction({ slug, accountId, selected });
  if (!result.ok) return { error: result.error, values: {} };
  back(integrationsPath(locale, slug));
}

export async function submitSyncWhatsApp(
  slug: string,
  locale: string,
  accountId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await syncWhatsAppAction({ slug, accountId });
  if (!result.ok) return { error: result.error, values: {} };
  back(integrationsPath(locale, slug));
}

export async function submitWhatsAppContact(
  slug: string,
  locale: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    accountId: text(formData, "accountId"),
    phone: text(formData, "phone"),
    consentSource: text(formData, "consentSource"),
  };
  const result = await addWhatsAppContactAction({
    slug,
    ...values,
    consentConfirmed: formData.get("consentConfirmed") === "on",
  });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(integrationsPath(locale, slug));
  return { done: true, at: Date.now() };
}

export async function submitWhatsAppOptOut(
  slug: string,
  locale: string,
  contactId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await optOutWhatsAppContactAction({ slug, contactId });
  if (!result.ok) return { error: result.error, values: {} };
  back(integrationsPath(locale, slug));
}

/** `requestKey` is fixed when the form is rendered: submitting it twice sends nothing twice. */
export async function submitWhatsAppSend(
  slug: string,
  locale: string,
  requestKey: string,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    sender: text(formData, "sender"),
    contactId: text(formData, "contactId"),
    message: text(formData, "message"),
    parameters: text(formData, "parameters"),
    text: text(formData, "text"),
  };
  const [accountId = "", phoneNumberId = ""] = values.sender.split("|");
  const isText = values.message === "__text__";
  const [templateName = "", templateLanguage = ""] = isText ? [] : values.message.split("|");
  const result = await requestWhatsAppSendAction({
    slug,
    accountId,
    phoneNumberId,
    contactId: values.contactId,
    requestKey,
    kind: isText ? "TEXT" : "TEMPLATE",
    ...(isText
      ? { text: values.text }
      : {
          templateName,
          templateLanguage,
          parameters: values.parameters
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
        }),
  });
  if (!result.ok) return { error: result.error, values };
  back(integrationsPath(locale, slug));
}

export async function submitResolveMessage(
  slug: string,
  locale: string,
  messageId: string,
  _previous: MarketingFormState,
  _formData: FormData,
): Promise<MarketingFormState> {
  const result = await resolveWhatsAppMessageAction({ slug, messageId });
  if (!result.ok) return { error: result.error, values: {} };
  back(integrationsPath(locale, slug));
}

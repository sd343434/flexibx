"use server";

import { revalidatePath } from "next/cache";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import {
  changeWriteProviderAction,
  checkStorageConnectionAction,
  saveWasabiSettingsAction,
} from "@/server/admin/storage-admin-actions";
import type { FieldError } from "@/server/errors/app-error";
import type { ConnectionCheck, ProviderWarning } from "@/server/storage/storage-admin";
import type { StorageProviderId } from "@/server/storage/storage";

// Form adapters for the platform admin storage page. Authorization happens in the server
// actions (platform administrator, database-checked); these only shape form state.

export type { StorageProviderId };

const text = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");
const page = (locale: string) => `/${isLocale(locale) ? locale : DEFAULT_LOCALE}/admin/storage`;

export type WasabiFormState =
  | null
  | { readonly status: "saved" | "unchanged" | "locked" }
  | { readonly status: "error"; readonly fields?: readonly FieldError[] };

export async function submitWasabiSettings(
  locale: string,
  _previous: WasabiFormState,
  formData: FormData,
): Promise<WasabiFormState> {
  const result = await saveWasabiSettingsAction({
    region: text(formData.get("region")),
    endpoint: text(formData.get("endpoint")),
    bucket: text(formData.get("bucket")),
  });
  if (!result.ok) {
    const fields = result.error.code === "VALIDATION_FAILED" ? result.error.fields : undefined;
    return { status: "error", ...(fields === undefined ? {} : { fields }) };
  }
  if (result.data.outcome === "saved") revalidatePath(page(locale));
  return { status: result.data.outcome };
}

export type ConnectionFormState =
  | null
  | { readonly provider: StorageProviderId; readonly check: ConnectionCheck }
  | { readonly error: true };

export async function submitConnectionCheck(
  _previous: ConnectionFormState,
  formData: FormData,
): Promise<ConnectionFormState> {
  const result = await checkStorageConnectionAction({ provider: text(formData.get("provider")) });
  return result.ok ? result.data : { error: true };
}

export type WriteProviderFormState =
  | null
  | {
      readonly status: "changed";
      readonly provider: StorageProviderId;
      /** Providers still holding files that failed their check (files stay there). */
      readonly warnings: readonly ProviderWarning[];
    }
  | { readonly status: "unchanged" | "stale" }
  | {
      readonly status: "unavailable";
      readonly provider: StorageProviderId;
      readonly failure: Exclude<ConnectionCheck, { ok: true }>["failure"];
    }
  | { readonly status: "error"; readonly fields?: readonly FieldError[] };

export async function submitWriteProvider(
  locale: string,
  _previous: WriteProviderFormState,
  formData: FormData,
): Promise<WriteProviderFormState> {
  const result = await changeWriteProviderAction({
    target: text(formData.get("target")),
    confirmation: text(formData.get("confirmation")),
  });
  if (!result.ok) {
    const fields = result.error.code === "VALIDATION_FAILED" ? result.error.fields : undefined;
    return { status: "error", ...(fields === undefined ? {} : { fields }) };
  }
  const outcome = result.data;
  switch (outcome.outcome) {
    case "changed":
      revalidatePath(page(locale));
      return { status: "changed", provider: outcome.to, warnings: outcome.warnings };
    case "provider_unavailable":
      return { status: "unavailable", provider: outcome.provider, failure: outcome.failure };
    case "unchanged":
    case "stale":
      return { status: outcome.outcome };
  }
}

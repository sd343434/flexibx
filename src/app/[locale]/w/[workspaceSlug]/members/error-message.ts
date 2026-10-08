import type { useTranslations } from "next-intl";

import type { ActionError } from "./actions";

type Translator = ReturnType<typeof useTranslations<never>>;

/**
 * The message for a rejected action: the first field code with a translation (domain
 * codes such as `last_owner`), otherwise the generic message for the error code.
 */
export function actionErrorMessage(t: Translator, error: ActionError): string {
  for (const field of error.fields ?? []) {
    const key = `validation.${field.code}`;
    if (t.has(key as never)) return t(key as never, field.params as never);
  }
  return t(error.messageKey as never);
}

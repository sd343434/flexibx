import "server-only";

import { getBillingEnv } from "../env";

import type { CreditsConfig } from "./credits";

export interface CreditsSettings extends CreditsConfig {
  /** The AI provider's token prices (USD per million tokens); null = unknown. */
  readonly prices: { readonly inputPerMTok: number | null; readonly outputPerMTok: number | null };
  /** What one credit is sold for, in micro-USD; null = unknown (no margin report). */
  readonly creditValueMicros: number | null;
}

/** This deployment's credits settings (CREDITS_TRIAL_MONTHLY, AI_*_PRICE_*, CREDIT_VALUE_USD). */
export function creditsSettingsFromEnv(): CreditsSettings {
  const env = getBillingEnv();
  return {
    trialPeriodCredits: env.CREDITS_TRIAL_MONTHLY,
    prices: {
      inputPerMTok: env.AI_INPUT_PRICE_USD_PER_MTOK ?? null,
      outputPerMTok: env.AI_OUTPUT_PRICE_USD_PER_MTOK ?? null,
    },
    creditValueMicros:
      env.CREDIT_VALUE_USD === undefined ? null : Math.round(env.CREDIT_VALUE_USD * 1_000_000),
  };
}

import type { AiEnv } from "../env-schema";

import { createFakeProvider } from "./fake-provider";
import { createOpenAiProvider } from "./openai-provider";
import type { AiProvider } from "./provider";

// The one place that turns AI_PROVIDER into a provider, for interactive requests and for
// automation alike. Pure (env passed in) so the selection is unit-tested.

/**
 * Project setting: the model used when OPENAI_MODEL is not set (the same default as the
 * AI reviewer). Not a promise that the model exists: the API rejects unknown models and
 * the request fails as "unavailable" — set OPENAI_MODEL to a model your key can use.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

/** The configured provider, or null when AI is disabled. */
export function providerFromEnv(env: AiEnv, options: { fetch?: typeof fetch } = {}) {
  let provider: AiProvider | null = null;
  if (env.AI_PROVIDER === "fake") provider = createFakeProvider();
  if (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY !== undefined) {
    provider = createOpenAiProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      ...(env.OPENAI_REASONING_EFFORT === undefined
        ? {}
        : { reasoningEffort: env.OPENAI_REASONING_EFFORT }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  return provider;
}

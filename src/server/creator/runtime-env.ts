import { DEFAULT_OPENAI_MODEL } from "../ai/configured-provider";
import { createOpenAiProvider } from "../ai/openai-provider";
import type { CreatorEnv } from "../env-schema";

import { createOpenAiTranscription, createOpenAiTranslation } from "./providers/openai";
import { createSimulatedTranscription, createSimulatedTranslation } from "./providers/simulated";
import type { TranscriptionProvider, TranslationProvider } from "./providers/types";

// Which transcription and translation providers the environment selects. Pure (env and
// fetch passed in) so the selection is unit-tested: `openai` is built only when the
// environment schema accepted it, i.e. with CREATOR_EXTERNAL_PROCESSING=approved and a
// key; constructing it makes no request.

export function providersFromEnv(
  env: CreatorEnv,
  options: { readonly fetch?: typeof fetch } = {},
): {
  readonly transcription: TranscriptionProvider | null;
  readonly translation: TranslationProvider | null;
} {
  if (env.CREATOR_AI_PROVIDER === "simulated") {
    return {
      transcription: createSimulatedTranscription(),
      translation: createSimulatedTranslation(),
    };
  }
  if (
    env.CREATOR_AI_PROVIDER === "openai" &&
    env.CREATOR_EXTERNAL_PROCESSING === "approved" &&
    env.OPENAI_API_KEY !== undefined
  ) {
    const model = env.CREATOR_OPENAI_TRANSLATION_MODEL ?? env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    const ai = createOpenAiProvider({
      apiKey: env.OPENAI_API_KEY,
      model,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return {
      transcription: createOpenAiTranscription({
        apiKey: env.OPENAI_API_KEY,
        transcriptionModel: env.CREATOR_OPENAI_TRANSCRIPTION_MODEL,
        requestTimeoutMs: env.CREATOR_PROVIDER_TIMEOUT_MS,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      translation: createOpenAiTranslation(ai, model),
    };
  }
  return { transcription: null, translation: null };
}

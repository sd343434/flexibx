import "server-only";

import { tmpdir } from "node:os";

import { creditsSettingsFromEnv } from "../billing/config";
import { getDb } from "../db/client";
import { getCreatorEnv } from "../env";
import { logger } from "../logger";
import { getStorageRouter } from "../storage/providers";

import { limitsFromEnv, type CreatorDeps } from "./config";
import { ruleBasedClipSuggester } from "./providers/clip-suggester";
import { providersFromEnv } from "./runtime-env";

// The application's Creator Studio dependencies. CREATOR_AI_PROVIDER=disabled (default)
// leaves transcription and translation off (projects, uploads, analysis, clips and
// exports still work); `simulated` uses the declared simulator (refused in production);
// `openai` sends audio and transcript text to OpenAI — accepted by the environment
// schema only together with CREATOR_EXTERNAL_PROCESSING=approved and OPENAI_API_KEY.

export function getCreatorDeps(): CreatorDeps {
  const env = getCreatorEnv();
  return {
    db: getDb(),
    storage: getStorageRouter(),
    ...providersFromEnv(env),
    clips: ruleBasedClipSuggester,
    tools: {
      ffmpeg: env.CREATOR_FFMPEG_PATH,
      ffprobe: env.CREATOR_FFPROBE_PATH,
      threads: env.CREATOR_FFMPEG_THREADS,
    },
    credits: { trialPeriodCredits: creditsSettingsFromEnv().trialPeriodCredits },
    limits: limitsFromEnv(env),
    workDir: env.CREATOR_WORK_DIR ?? tmpdir(),
    logger,
  };
}

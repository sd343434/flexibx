import "server-only";

import type { AiRuntime } from "../ai/ai-service";
import { providerFromEnv } from "../ai/configured-provider";
import { getDb } from "../db/client";
import { getAiEnv } from "../env";
import { logger } from "../logger";

import type { AdAdapters } from "../ads/adapter";
import {
  adsExecutionEnabled,
  adTokenKey,
  getAdAdapters,
  getWhatsAppAdapter,
  whatsappSendingEnabled,
} from "../ads/registry";
import { readMedia } from "../marketing/media-service";
import { getStorageRouter } from "../storage/providers";

import type { OrchestrationDeps } from "./engine";
import { adActivateWorkflow } from "./workflows/ad-activate";
import { adLaunchWorkflow } from "./workflows/ad-launch";
import {
  contentPlanningWorkflow,
  CONTENT_PLANNING_WORKFLOW,
  type PlanningServices,
} from "./workflows/content-planning";
import { whatsappSendWorkflow, type WhatsAppSendServices } from "./workflows/whatsapp-send";

// The application's orchestration dependencies: the workflows that exist and the
// services their tasks use. The AI provider comes from AI_PROVIDER (disabled by default;
// `fake` is the deterministic local adapter; `openai` calls OpenAI's Responses API).

/** Services every workflow may use (each workflow declares the part it needs). */
export type AppServices = PlanningServices & WhatsAppSendServices;

export const WORKFLOWS = {
  [CONTENT_PLANNING_WORKFLOW]: contentPlanningWorkflow,
  [adLaunchWorkflow.id]: adLaunchWorkflow,
  [adActivateWorkflow.id]: adActivateWorkflow,
  [whatsappSendWorkflow.id]: whatsappSendWorkflow,
} as const;

export function getAiRuntimeForAutomation(): AiRuntime {
  const env = getAiEnv();
  return {
    provider: providerFromEnv(env),
    timeoutMs: env.AI_TIMEOUT_MS,
  };
}

export function getOrchestrationDeps(): OrchestrationDeps<AppServices> & {
  readonly adapters: AdAdapters;
  readonly executionEnabled: boolean;
  readonly tokenKey: string | null;
} {
  return {
    db: getDb(),
    // Resolved on use, so a misconfigured advertising platform never breaks automation.
    get adapters() {
      return getAdAdapters();
    },
    get executionEnabled() {
      return adsExecutionEnabled();
    },
    get tokenKey() {
      return adTokenKey();
    },
    services: {
      ai: getAiRuntimeForAutomation,
      ads: getAdAdapters,
      tokenKey: adTokenKey,
      executionEnabled: adsExecutionEnabled,
      whatsapp: getWhatsAppAdapter,
      whatsappSendingEnabled,
      readMedia: async (ctx, assetId) => {
        try {
          const file = await readMedia(getDb(), getStorageRouter(), ctx, assetId);
          return { body: file.body, contentType: file.contentType, filename: file.filename };
        } catch {
          return null;
        }
      },
    },
    workflows: WORKFLOWS,
    logger,
  };
}

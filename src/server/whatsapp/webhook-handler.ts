import "server-only";

import { getSystemDb } from "../db/client";
import { getAdsEnv, getEnv } from "../env";
import { logger } from "../logger";

import {
  MAX_WEBHOOK_BYTES,
  parseWebhook,
  recordWebhookEvents,
  verifyChallenge,
  verifySignature,
} from "./webhook";

// The WhatsApp webhook endpoint's logic, wired to this deployment's configuration and
// system database client (a webhook carries no session; see recordWebhookEvents).

export interface WebhookReply {
  readonly status: number;
  readonly body: string;
}

/** Meta's subscription check (GET). */
export function answerVerification(params: URLSearchParams): WebhookReply {
  const challenge = verifyChallenge(params, getAdsEnv().WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  return challenge === null ? { status: 403, body: "forbidden" } : { status: 200, body: challenge };
}

/**
 * A notification (POST). Nothing is parsed before the X-Hub-Signature-256 HMAC of the raw
 * body is verified with the app secret; unsigned, oversized or malformed payloads are
 * refused. The body is never logged — only counts.
 */
export async function handleNotification(
  raw: Uint8Array,
  signature: string | null,
): Promise<WebhookReply> {
  const appSecret = getAdsEnv().META_APP_SECRET;
  if (appSecret === undefined) return { status: 503, body: "not configured" };
  if (raw.byteLength > MAX_WEBHOOK_BYTES) return { status: 413, body: "too large" };
  if (!verifySignature(raw, signature, appSecret)) {
    logger.warn({ route: "whatsapp.webhook" }, "WhatsApp webhook signature rejected");
    return { status: 401, body: "invalid signature" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return { status: 400, body: "invalid payload" };
  }
  const events = parseWebhook(payload);
  if (events === null) return { status: 400, body: "invalid payload" };
  const outcome = await recordWebhookEvents(
    getSystemDb(),
    events,
    new Date(),
    getEnv().ENCRYPTION_KEY ?? null,
  );
  logger.info({ route: "whatsapp.webhook", ...outcome }, "WhatsApp webhook processed");
  return { status: 200, body: "ok" };
}

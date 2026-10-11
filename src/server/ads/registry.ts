import "server-only";

import { getAdsEnv, getEnv } from "../env";

import type { AdAdapters } from "./adapter";
import { createMetaAdapter } from "./adapters/meta";
import { createSnapchatAdapter } from "./adapters/snapchat";
import { createTikTokAdapter } from "./adapters/tiktok";
import { createWhatsAppAdapter, type WhatsAppAdapter } from "./adapters/whatsapp";
import type { AdPlatform } from "./model";

// The platforms this deployment can use. Flexibx owns ONE developer app per platform
// (server-side configuration only); every workspace connects its own accounts through
// that app's official authorization flow, and its tokens are stored for that workspace
// alone. A platform is available when its app credentials and ENCRYPTION_KEY are set:
// Meta, Snapchat, TikTok, and WhatsApp (the same Meta app + an Embedded Signup
// configuration). Adding one means writing an adapter (adapters/<platform>.ts) against the
// same AdPlatformAdapter contract and registering it here — nothing above this file changes.

/** External advertising writes (campaign creation, activation): off unless "true". */
export function adsExecutionEnabled(): boolean {
  return getAdsEnv().ADS_EXECUTION_ENABLED === "true";
}

/** Outbound WhatsApp messages: off unless "true". */
export function whatsappSendingEnabled(): boolean {
  return getAdsEnv().WHATSAPP_SENDING_ENABLED === "true";
}

/** The WhatsApp adapter when configured (it also reads numbers and templates). */
export function getWhatsAppAdapter(): WhatsAppAdapter | null {
  const env = getAdsEnv();
  const { META_APP_ID: appId, META_APP_SECRET: appSecret, WHATSAPP_CONFIG_ID: configId } = env;
  if (
    appId === undefined ||
    appSecret === undefined ||
    configId === undefined ||
    getEnv().ENCRYPTION_KEY === undefined
  ) {
    return null;
  }
  return createWhatsAppAdapter({ appId, appSecret, configId, version: env.META_GRAPH_VERSION });
}

export function getAdAdapters(): AdAdapters {
  const env = getAdsEnv();
  const encryption = getEnv().ENCRYPTION_KEY !== undefined;
  const { META_APP_ID: appId, META_APP_SECRET: appSecret } = env;
  const { SNAPCHAT_CLIENT_ID: snapId, SNAPCHAT_CLIENT_SECRET: snapSecret } = env;
  const { TIKTOK_APP_ID: tiktokId, TIKTOK_APP_SECRET: tiktokSecret } = env;
  return {
    META:
      appId !== undefined && appSecret !== undefined && encryption
        ? {
            platform: "META",
            available: true,
            adapter: createMetaAdapter({
              appId,
              appSecret,
              version: env.META_GRAPH_VERSION,
              requestWriteAccess: env.ADS_EXECUTION_ENABLED === "true",
              ...(env.META_CONFIG_ID === undefined ? {} : { configId: env.META_CONFIG_ID }),
            }),
          }
        : { platform: "META", available: false, reason: "not_configured" },
    SNAPCHAT:
      snapId !== undefined && snapSecret !== undefined && encryption
        ? {
            platform: "SNAPCHAT",
            available: true,
            adapter: createSnapchatAdapter({ clientId: snapId, clientSecret: snapSecret }),
          }
        : { platform: "SNAPCHAT", available: false, reason: "not_configured" },
    TIKTOK:
      tiktokId !== undefined && tiktokSecret !== undefined && encryption
        ? {
            platform: "TIKTOK",
            available: true,
            adapter: createTikTokAdapter({
              appId: tiktokId,
              appSecret: tiktokSecret,
              ...(env.TIKTOK_AUTHORIZE_URL === undefined
                ? {}
                : { authorizeUrl: env.TIKTOK_AUTHORIZE_URL }),
            }),
          }
        : { platform: "TIKTOK", available: false, reason: "not_configured" },
    WHATSAPP: ((adapter) =>
      adapter === null
        ? { platform: "WHATSAPP", available: false, reason: "not_configured" }
        : { platform: "WHATSAPP", available: true, adapter })(getWhatsAppAdapter()),
  };
}

/** The OAuth redirect URI registered with Meta. */
export function metaRedirectUri(): string {
  const env = getAdsEnv();
  return (
    env.META_REDIRECT_URI ?? new URL("/api/integrations/meta/callback", getEnv().APP_URL).toString()
  );
}

/** The OAuth redirect URI registered on the Snap OAuth app. */
export function snapchatRedirectUri(): string {
  const env = getAdsEnv();
  return (
    env.SNAPCHAT_REDIRECT_URI ??
    new URL("/api/integrations/snapchat/callback", getEnv().APP_URL).toString()
  );
}

/** The redirect URL registered on the TikTok for Business app. */
export function tiktokRedirectUri(): string {
  const env = getAdsEnv();
  return (
    env.TIKTOK_REDIRECT_URI ??
    new URL("/api/integrations/tiktok/callback", getEnv().APP_URL).toString()
  );
}

/** The redirect URI registered for Embedded Signup (Facebook Login for Business). */
export function whatsappRedirectUri(): string {
  const env = getAdsEnv();
  return (
    env.WHATSAPP_REDIRECT_URI ??
    new URL("/api/integrations/whatsapp/callback", getEnv().APP_URL).toString()
  );
}

/** The registered OAuth redirect of a platform. */
export function redirectUriFor(platform: AdPlatform): string {
  switch (platform) {
    case "META":
      return metaRedirectUri();
    case "SNAPCHAT":
      return snapchatRedirectUri();
    case "TIKTOK":
      return tiktokRedirectUri();
    case "WHATSAPP":
      return whatsappRedirectUri();
  }
}

/** The token encryption key, or null when not configured. */
export function adTokenKey(): string | null {
  return getEnv().ENCRYPTION_KEY ?? null;
}

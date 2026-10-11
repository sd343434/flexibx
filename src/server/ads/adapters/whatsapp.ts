import { createHmac } from "node:crypto";

import { z } from "zod";

import {
  AdPlatformError,
  type AdPlatformAdapter,
  type ExternalAction,
  type OAuthGrant,
} from "../adapter";
import type { AdAccountStatus, UnifiedAdAccount } from "../model";

import { metaFailure } from "./meta";

// WhatsApp Business Platform (Cloud API / Business Management API) through Meta's Graph API.
//
// WhatsApp is a messaging channel, not an ad account: it plugs into the advertising
// connection machinery (single-use OAuth state, encrypted token vault, workspace-scoped
// connection and accounts, audit) but its "accounts" are WhatsApp Business accounts
// (WABAs) and it has no campaigns, insights or launches.
//
// Connection (developers.facebook.com, Embedded Signup + Facebook Login for Business):
// the person goes through Embedded Signup, launched as the Facebook Login for Business
// dialog with Flexibx's configuration id (`config_id`, `response_type=code`,
// `override_default_response_type=true`), and returns with an exchangeable code. The code
// is exchanged server-to-server (/oauth/access_token) for a business token; the WABAs the
// customer shared are the `target_ids` of the `whatsapp_business_management` granular
// scope (/debug_token). Every token call carries `appsecret_proof`.
//
// Reads: WABA details, its business phone numbers (stored masked) and message templates
// (name, language, category, status).
//
// Sending (Cloud API, POST /{phone-number-id}/messages with messaging_product=whatsapp):
// one recipient per call, either an approved template (`type: template`, name + language
// code + body parameters) or, only inside the customer service window, a text message.
// The response carries the message id (wamid); delivery is reported later by webhooks.
// Requires `whatsapp_business_messaging`. Called only by the approved whatsapp_send task.

export const WHATSAPP_REQUIRED_SCOPES = ["whatsapp_business_management"] as const;
export const WHATSAPP_SEND_SCOPE = "whatsapp_business_messaging";

/** What one send carries (the recipient is digits only, without "+"). */
export type WhatsAppOutbound =
  | {
      readonly kind: "TEMPLATE";
      readonly to: string;
      readonly templateName: string;
      readonly language: string;
      readonly parameters: readonly string[];
    }
  | { readonly kind: "TEXT"; readonly to: string; readonly text: string };

/** The Cloud API request body of a send (also shown, masked, for approval). */
export function whatsAppMessageBody(message: WhatsAppOutbound): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: message.to };
  if (message.kind === "TEXT") {
    return { ...base, type: "text", text: { preview_url: false, body: message.text } };
  }
  return {
    ...base,
    type: "template",
    template: {
      name: message.templateName,
      language: { code: message.language },
      ...(message.parameters.length === 0
        ? {}
        : {
            components: [
              {
                type: "body",
                parameters: message.parameters.map((text) => ({ type: "text", text })),
              },
            ],
          }),
    },
  };
}

/** Cloud API error codes that matter for sending (developers.facebook.com error codes). */
export const WHATSAPP_ERRORS = {
  /** More than 24 hours since the customer's last message: only templates may be sent. */
  reEngagement: 131047,
  /** The customer chose to stop receiving marketing messages. */
  marketingOptOut: 131050,
  throughput: 130429,
  spamRate: 131048,
  pairRate: 131056,
} as const;

function sendFailure(code: number | null, httpStatus: number): AdPlatformError {
  if (
    code === WHATSAPP_ERRORS.throughput ||
    code === WHATSAPP_ERRORS.spamRate ||
    code === WHATSAPP_ERRORS.pairRate
  ) {
    return new AdPlatformError("rate_limited", code);
  }
  // Message-level errors (130xxx-139xxx): refused, nothing sent.
  if (code !== null && code >= 130_000 && code < 140_000) {
    return new AdPlatformError("invalid_request", code);
  }
  return metaFailure(code, httpStatus);
}
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 3;

export interface WhatsAppAdapterConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** The Embedded Signup configuration id (Facebook Login for Business). */
  readonly configId: string;
  /** Graph API version, e.g. v26.0 */
  readonly version: string;
  readonly fetch?: typeof fetch;
}

const phoneNumberSchema = z.strictObject({
  id: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  /** The business number with all but its last 4 digits hidden. */
  maskedNumber: z.string().max(40),
  verifiedName: z.string().max(200).nullable(),
  qualityRating: z.enum(["GREEN", "YELLOW", "RED", "UNKNOWN"]),
  verificationStatus: z.string().max(40).nullable(),
  platformType: z.string().max(40).nullable(),
});
const templateSchema = z.strictObject({
  name: z.string().max(512),
  language: z.string().max(20),
  category: z.string().max(40),
  status: z.string().max(40),
});
export const whatsAppSnapshotSchema = z.strictObject({
  phoneNumbers: z.array(phoneNumberSchema).max(50),
  templates: z.array(templateSchema).max(300),
  truncated: z.boolean(),
});
export type WhatsAppBusinessSnapshot = z.infer<typeof whatsAppSnapshotSchema>;
export type WhatsAppPhoneNumber = z.infer<typeof phoneNumberSchema>;
export type WhatsAppTemplate = z.infer<typeof templateSchema>;

export interface WhatsAppAdapter extends AdPlatformAdapter {
  /** Reads one WABA's numbers and templates (GET only). */
  readBusiness(accessToken: string, wabaId: string): Promise<WhatsAppBusinessSnapshot>;
  /**
   * Sends one message from a business number; returns its wamid. Throws AdPlatformError,
   * with `uncertain` when the request may have been accepted (network failure, 5xx).
   */
  sendMessage(
    accessToken: string,
    phoneNumberId: string,
    message: WhatsAppOutbound,
  ): Promise<{ readonly messageId: string }>;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const int = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function cleanId(value: unknown): string | null {
  const id = str(value);
  return id !== null && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** "+999 50 123 4567" → "•••• 4567" (only the last four digits are ever kept). */
export function maskPhoneNumber(value: unknown): string {
  const digits = (str(value) ?? "").replace(/\D/g, "");
  return digits.length < 4 ? "••••" : `•••• ${digits.slice(-4)}`;
}

function quality(value: unknown): WhatsAppPhoneNumber["qualityRating"] {
  return value === "GREEN" || value === "YELLOW" || value === "RED" ? value : "UNKNOWN";
}

function wabaStatus(value: unknown): AdAccountStatus {
  switch (value) {
    case "APPROVED":
      return "ACTIVE";
    case "PENDING":
      return "PENDING";
    case "REJECTED":
      return "DISABLED";
    default:
      return "OTHER";
  }
}

export function createWhatsAppAdapter(config: WhatsAppAdapterConfig): WhatsAppAdapter {
  const http = config.fetch ?? fetch;
  const graph = `https://graph.facebook.com/${config.version}`;
  const proof = (token: string) =>
    createHmac("sha256", config.appSecret).update(token).digest("hex");

  async function call(path: string, params: Record<string, string>, token?: string): Promise<Json> {
    const url = new URL(`${graph}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (token !== undefined) {
      url.searchParams.set("access_token", token);
      url.searchParams.set("appsecret_proof", proof(token));
    }
    let response: Response;
    try {
      response = await http(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new AdPlatformError("provider_error");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || (isRecord(body) && isRecord(body.error))) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : {};
      throw metaFailure(int(error.code), response.status);
    }
    if (!isRecord(body)) throw new AdPlatformError("provider_error");
    return body;
  }

  /** The WABAs this token was granted (`whatsapp_business_management` target ids). */
  async function sharedAccounts(token: string): Promise<{
    wabaIds: string[];
    scopes: string[];
    userId: string | null;
    expiresAt: Date | null;
  }> {
    // debug_token is called with the app's own token (app_id|app_secret), as documented.
    const body = await call("/debug_token", {
      input_token: token,
      access_token: `${config.appId}|${config.appSecret}`,
    });
    const data = isRecord(body.data) ? body.data : {};
    if (data.is_valid === false) throw new AdPlatformError("token_expired");
    const granular = records(data.granular_scopes);
    const management = granular.find((entry) => entry.scope === "whatsapp_business_management");
    const wabaIds = [
      ...new Set(
        (Array.isArray(management?.target_ids) ? management.target_ids : [])
          .map(cleanId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const scopes = (Array.isArray(data.scopes) ? data.scopes : [])
      .map(str)
      .filter((scope): scope is string => scope !== null && /^[a-z_]{1,60}$/.test(scope));
    const expires = int(data.expires_at);
    return {
      wabaIds,
      scopes: [...new Set(scopes)].sort(),
      userId: cleanId(data.user_id),
      // 0 means the business token does not expire.
      expiresAt: expires === null || expires === 0 ? null : new Date(expires * 1000),
    };
  }

  async function edge(path: string, params: Record<string, string>, token: string) {
    const items: Json[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await call(
        path,
        { ...params, limit: "100", ...(after === null ? {} : { after }) },
        token,
      );
      items.push(...records(body.data));
      const paging = isRecord(body.paging) ? body.paging : {};
      const cursors = isRecord(paging.cursors) ? paging.cursors : {};
      after = typeof paging.next === "string" ? str(cursors.after) : null;
      if (after === null) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  return {
    platform: "WHATSAPP",
    capabilities: {
      connect: true,
      listAccounts: true,
      readCampaigns: false,
      readInsights: false,
      launchCampaign: false,
    },
    requiredScopes: WHATSAPP_REQUIRED_SCOPES,
    credential: "access_token",

    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`https://www.facebook.com/${config.version}/dialog/oauth`);
      url.searchParams.set("client_id", config.appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("config_id", config.configId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("override_default_response_type", "true");
      return url.toString();
    },

    async exchangeCode({ code, redirectUri }): Promise<OAuthGrant> {
      const exchanged = await call("/oauth/access_token", {
        client_id: config.appId,
        client_secret: config.appSecret,
        redirect_uri: redirectUri,
        code,
      }).catch((error: unknown) => {
        if (error instanceof AdPlatformError && error.kind === "invalid_request") {
          throw new AdPlatformError("oauth_invalid", error.platformCode);
        }
        throw error;
      });
      const accessToken = str(exchanged.access_token);
      if (accessToken === null || accessToken === "") throw new AdPlatformError("oauth_invalid");
      const shared = await sharedAccounts(accessToken);
      return {
        accessToken,
        expiresAt: shared.expiresAt,
        externalUser: { id: shared.userId ?? "business-integration", name: null },
        grantedScopes: shared.scopes,
      };
    },

    async listAccounts(token): Promise<UnifiedAdAccount[]> {
      const { wabaIds } = await sharedAccounts(token);
      const accounts: UnifiedAdAccount[] = [];
      for (const wabaId of wabaIds.slice(0, 50)) {
        const waba = await call(
          `/${wabaId}`,
          { fields: "id,name,currency,account_review_status" },
          token,
        );
        const currency = str(waba.currency);
        accounts.push({
          externalId: wabaId,
          name: (str(waba.name) ?? wabaId).slice(0, 200),
          // WhatsApp accounts carry no ad currency; XXX is ISO 4217 "no currency".
          currency: currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : "XXX",
          timeZone: null,
          status: wabaStatus(waba.account_review_status),
        });
      }
      return accounts;
    },

    readAccount() {
      // No campaigns or insights on a WhatsApp Business account.
      return Promise.reject(new AdPlatformError("unavailable"));
    },

    describeLaunch(): readonly ExternalAction[] {
      return [];
    },

    async sendMessage(token, phoneNumberId, message) {
      const id = cleanId(phoneNumberId);
      if (id === null || !/^\d{8,15}$/.test(message.to)) {
        throw new AdPlatformError("invalid_request");
      }
      const url = new URL(`${graph}/${id}/messages`);
      url.searchParams.set("appsecret_proof", proof(token));
      let response: Response;
      try {
        response = await http(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(whatsAppMessageBody(message)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
          redirect: "error",
        });
      } catch {
        // It may have reached Meta and been sent.
        throw new AdPlatformError("provider_error", null, true);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || (isRecord(body) && isRecord(body.error))) {
        const error = isRecord(body) && isRecord(body.error) ? body.error : {};
        const failure = sendFailure(int(error.code), response.status);
        if (response.status >= 500 || body === null) {
          throw new AdPlatformError(failure.kind, failure.platformCode, true);
        }
        throw failure;
      }
      const messages = isRecord(body) ? records(body.messages) : [];
      const wamid = str(messages[0]?.id);
      if (wamid === null || !/^[A-Za-z0-9._=:+/-]{1,128}$/.test(wamid)) {
        // Accepted without a readable id: it may well have been sent.
        throw new AdPlatformError("provider_error", null, true);
      }
      return { messageId: wamid };
    },

    async readBusiness(token, wabaId): Promise<WhatsAppBusinessSnapshot> {
      const id = cleanId(wabaId);
      if (id === null) throw new AdPlatformError("invalid_request");
      const [numbers, templates] = await Promise.all([
        edge(
          `/${id}/phone_numbers`,
          {
            fields:
              "id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type",
          },
          token,
        ),
        edge(`/${id}/message_templates`, { fields: "name,language,category,status" }, token),
      ]);
      return whatsAppSnapshotSchema.parse({
        phoneNumbers: numbers.items.slice(0, 50).flatMap((item) => {
          const numberId = cleanId(item.id);
          if (numberId === null) return [];
          return [
            {
              id: numberId,
              maskedNumber: maskPhoneNumber(item.display_phone_number),
              verifiedName: str(item.verified_name)?.slice(0, 200) ?? null,
              qualityRating: quality(item.quality_rating),
              verificationStatus: str(item.code_verification_status)?.slice(0, 40) ?? null,
              platformType: str(item.platform_type)?.slice(0, 40) ?? null,
            },
          ];
        }),
        templates: templates.items.slice(0, 300).flatMap((item) => {
          const name = str(item.name);
          if (name === null) return [];
          return [
            {
              name: name.slice(0, 512),
              language: (str(item.language) ?? "").slice(0, 20),
              category: (str(item.category) ?? "OTHER").slice(0, 40),
              status: (str(item.status) ?? "UNKNOWN").slice(0, 40),
            },
          ];
        }),
        truncated: numbers.truncated || templates.truncated,
      });
    },
  };
}

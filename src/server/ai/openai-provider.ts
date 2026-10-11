import { AiProviderError, type AiProvider, type AiRequest, type AiResponse } from "./provider";

// OpenAI through the Responses API (POST https://api.openai.com/v1/responses), called with
// fetch so no SDK is bundled into the server. Pure (no `server-only`) for unit tests; it is
// only constructed by server code (configured-provider.ts) from AI_PROVIDER=openai.
//
// - The endpoint is pinned; the key is sent only in the Authorization header and never
//   appears in errors or logs. Responses are not stored by OpenAI (`store: false`).
// - The application's rules go in `instructions`, the task (with workspace data fenced) in
//   `input`. Output is requested as a JSON object (`text.format: json_object`) — every
//   prompt already asks for exactly one JSON object — and is still validated by the
//   operation's schema before use.
// - No tools are offered, so the model cannot browse, call functions or run code.
// - Failures map to the normalized kinds: 429 → rate_limited; 408, 409, 5xx, network →
//   unavailable (retried once by runProvider); a refusal → refused; an incomplete or
//   empty answer → invalid_output; anything else (400, 401, 403, 404…) → unavailable,
//   with the HTTP status only in the message.

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const OPENAI_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

/**
 * Reasoning models count their hidden reasoning against `max_output_tokens`; this
 * allowance is added on top of the operation's visible-output budget when a reasoning
 * effort is configured, so the answer is not cut off.
 */
export const REASONING_TOKEN_ALLOWANCE = 4000;

export interface OpenAiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  /** Sent only when set (models without reasoning reject the parameter). */
  readonly reasoningEffort?: OpenAiReasoningEffort;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The visible text of a Responses API answer, or a refusal. */
function readOutput(body: Json): { text: string; refused: boolean } {
  const parts: string[] = [];
  let refused = false;
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!isRecord(item) || item.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (!isRecord(content)) continue;
      if (content.type === "refusal") refused = true;
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return { text: parts.join(""), refused };
}

export function createOpenAiProvider(config: OpenAiProviderConfig): AiProvider {
  const http = config.fetch ?? fetch;
  return {
    name: "openai",
    async generate(request: AiRequest): Promise<AiResponse> {
      const payload = {
        model: config.model,
        instructions: request.system,
        input: request.user,
        store: false,
        max_output_tokens:
          request.maxOutputTokens +
          (config.reasoningEffort === undefined ? 0 : REASONING_TOKEN_ALLOWANCE),
        text: { format: { type: "json_object" } },
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoning: { effort: config.reasoningEffort } }),
      };
      let response: Response;
      try {
        response = await http(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: request.signal,
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        if (request.signal.aborted) throw new AiProviderError("timeout", "Request aborted");
        throw new AiProviderError("unavailable", "OpenAI request failed", { cause: error });
      }
      if (!response.ok) {
        const status = response.status;
        if (status === 429) throw new AiProviderError("rate_limited", "OpenAI rate limit");
        throw new AiProviderError("unavailable", `OpenAI HTTP ${String(status)}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AiProviderError("invalid_output", "OpenAI answer is not JSON");
      }
      if (!isRecord(body)) throw new AiProviderError("invalid_output", "OpenAI answer is empty");
      const { text, refused } = readOutput(body);
      if (refused) throw new AiProviderError("refused", "The model refused the request");
      if (body.status === "incomplete") {
        throw new AiProviderError("invalid_output", "OpenAI answer is incomplete");
      }
      if (text.trim() === "") throw new AiProviderError("invalid_output", "Empty answer");
      const usage = isRecord(body.usage) ? body.usage : {};
      return {
        text,
        provider: "openai",
        model: typeof body.model === "string" ? body.model.slice(0, 100) : config.model,
        usage: { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) },
      };
    },
  };
}

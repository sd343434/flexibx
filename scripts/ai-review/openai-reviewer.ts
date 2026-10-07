// OpenAI implementation of the ReviewerClient interface. This is the ONLY module that
// imports the OpenAI SDK; everything else depends on the interface in review-orchestrator.ts.
//
// - The API key is passed in explicitly (read from OPENAI_API_KEY by the caller) and is
//   never logged: SDK logging is forced off and errors are mapped to fixed messages.
// - Base URL, organization and project are pinned, so environment variables such as
//   OPENAI_BASE_URL cannot redirect requests (and the key) elsewhere.
// - No tools are offered to the model, so it cannot call functions, browse or run code.
// - Responses are requested as strict JSON and are NOT trusted: the orchestrator validates
//   them against the review contract.
import OpenAI from "openai";

import { DECISIONS, CATEGORIES, SEVERITIES } from "./review-schema";
import {
  ATTEMPT_TIMEOUT_MS,
  ReviewerError,
  type ReviewerClient,
  type ReviewerConfig,
  type ReviewerRequest,
} from "./review-orchestrator";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MAX_OUTPUT_TOKENS = 16_000;

/**
 * JSON Schema sent to the API for structured output. Deliberately uses only the basic
 * keywords supported in strict mode; length, count and decision rules are enforced by
 * the local validator, which is the source of truth.
 */
export const REVIEW_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "decision",
    "phase",
    "next_phase",
    "confidence",
    "summary",
    "findings",
    "required_actions",
    "next_prompt",
  ],
  properties: {
    schema_version: { type: "integer", enum: [1] },
    decision: { type: "string", enum: [...DECISIONS] },
    phase: { type: "integer" },
    next_phase: { type: ["integer", "null"] },
    confidence: { type: "number" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "title", "description", "evidence", "blocking"],
        properties: {
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: { type: "string" },
          description: { type: "string" },
          evidence: { type: "string" },
          blocking: { type: "boolean" },
        },
      },
    },
    required_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "blocking"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          blocking: { type: "boolean" },
        },
      },
    },
    next_prompt: { type: ["string", "null"] },
  },
} as const;

/** The subset of the SDK surface this module uses (keeps tests SDK-free). */
export interface ResponsesApi {
  create(
    body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<{ status?: string | null; output_text: string }>;
}

/** Maps any SDK error to a ReviewerError with a FIXED message (provider text is dropped). */
export function mapOpenAIError(error: unknown): ReviewerError {
  if (error instanceof ReviewerError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new ReviewerError("TIMEOUT", "TIMEOUT");
  if (error instanceof OpenAI.APIUserAbortError) return new ReviewerError("TIMEOUT", "ABORTED");
  if (error instanceof OpenAI.APIConnectionError)
    return new ReviewerError("TRANSIENT", "CONNECTION_ERROR");
  if (error instanceof OpenAI.RateLimitError)
    return new ReviewerError("TRANSIENT", "RATE_LIMITED", 429);
  if (error instanceof OpenAI.InternalServerError)
    return new ReviewerError("TRANSIENT", "SERVER_ERROR", error.status);
  if (error instanceof OpenAI.AuthenticationError)
    return new ReviewerError("PERMANENT", "AUTHENTICATION_FAILED", 401);
  if (error instanceof OpenAI.PermissionDeniedError)
    return new ReviewerError("PERMANENT", "PERMISSION_DENIED", 403);
  if (error instanceof OpenAI.NotFoundError)
    return new ReviewerError("PERMANENT", "NOT_FOUND", 404);
  if (error instanceof OpenAI.BadRequestError)
    return new ReviewerError("PERMANENT", "BAD_REQUEST", 400);
  if (error instanceof OpenAI.UnprocessableEntityError)
    return new ReviewerError("PERMANENT", "UNPROCESSABLE", 422);
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const transient = status === 408 || status === 409 || (status !== undefined && status >= 500);
    return new ReviewerError(transient ? "TRANSIENT" : "PERMANENT", "API_ERROR", status);
  }
  return new ReviewerError("PERMANENT", "UNKNOWN");
}

/** Builds a ReviewerClient over an injected Responses API (the real SDK or a test double). */
export function createReviewerClientFromApi(api: ResponsesApi, model: string): ReviewerClient {
  return {
    model,
    async complete(request: ReviewerRequest): Promise<string> {
      let response: { status?: string | null; output_text: string };
      try {
        response = await api.create(
          {
            model,
            instructions: request.instructions,
            input: request.input,
            store: false,
            max_output_tokens: MAX_OUTPUT_TOKENS,
            text: {
              format: {
                type: "json_schema",
                name: "flexibx_ai_review",
                strict: true,
                schema: REVIEW_RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
              },
            },
          },
          { signal: request.signal },
        );
      } catch (error) {
        throw mapOpenAIError(error);
      }
      if (response.status === "incomplete")
        throw new ReviewerError("PERMANENT", "INCOMPLETE_RESPONSE");
      if (response.output_text.trim() === "")
        throw new ReviewerError("PERMANENT", "EMPTY_RESPONSE");
      return response.output_text;
    },
  };
}

/** Hardened SDK options: pinned endpoint, no env-derived org/project, no SDK logging or retries. */
export function buildOpenAIOptions(config: ReviewerConfig) {
  return {
    apiKey: config.apiKey,
    baseURL: OPENAI_BASE_URL,
    organization: null,
    project: null,
    webhookSecret: null,
    timeout: ATTEMPT_TIMEOUT_MS,
    maxRetries: 0, // retries are owned by the orchestrator's bounded policy
    logLevel: "off" as const,
  };
}

/** The production client: official OpenAI SDK with pinned, non-logging configuration. */
export function createOpenAIReviewerClient(config: ReviewerConfig): ReviewerClient {
  return createReviewerClientFromApi(
    new OpenAI(buildOpenAIOptions(config)).responses,
    config.model,
  );
}

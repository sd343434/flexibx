import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenAIOptions,
  createReviewerClientFromApi,
  mapOpenAIError,
  OPENAI_BASE_URL,
  REVIEW_RESPONSE_JSON_SCHEMA,
  type ResponsesApi,
} from "../../scripts/ai-review/openai-reviewer";
import { ATTEMPT_TIMEOUT_MS, ReviewerError } from "../../scripts/ai-review/review-orchestrator";

// No test in this file performs a network request: the SDK is either replaced by a
// fake `ResponsesApi` or only constructed (construction does not contact the API).

/** Obviously fake key, assembled at runtime so secret scanners never see a key-shaped literal. */
const FAKE_KEY = ["sk-test", "FAKE", "0000000000000000000000"].join("-");

type CreateBody = OpenAI.Responses.ResponseCreateParamsNonStreaming;

function fakeApi(result: { status?: string | null; output_text: string } | Error) {
  const calls: { body: CreateBody; signal: AbortSignal | undefined }[] = [];
  const api: ResponsesApi = {
    create: (body, options) => {
      calls.push({ body, signal: options?.signal });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { api, calls };
}

const request = () => ({
  instructions: "fixed instructions",
  input: "<review_input>{}</review_input>",
  signal: new AbortController().signal,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request shape", () => {
  it("sends only the fixed instructions and framed input, with strict JSON output, no tools and no storage", async () => {
    const { api, calls } = fakeApi({ status: "completed", output_text: '{"ok":true}' });
    const client = createReviewerClientFromApi(api, "test-model");
    const req = request();

    expect(await client.complete(req)).toBe('{"ok":true}');
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body;
    expect(body).toMatchObject({
      model: "test-model",
      instructions: "fixed instructions",
      input: "<review_input>{}</review_input>",
      store: false,
      text: { format: { type: "json_schema", name: "flexibx_ai_review", strict: true } },
    });
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "input",
      "instructions",
      "max_output_tokens",
      "model",
      "store",
      "text",
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(calls[0]?.signal).toBe(req.signal);
  });

  it("requests a schema that mirrors the review contract", () => {
    expect(REVIEW_RESPONSE_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...REVIEW_RESPONSE_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(REVIEW_RESPONSE_JSON_SCHEMA.properties).sort(),
    );
    expect(REVIEW_RESPONSE_JSON_SCHEMA.properties.decision.enum).toEqual([
      "APPROVE_NEXT_PHASE",
      "FIX_REQUIRED",
      "BLOCKED",
      "HUMAN_REVIEW_REQUIRED",
    ]);
  });

  it("rejects incomplete and empty responses as permanent errors", async () => {
    const incomplete = createReviewerClientFromApi(
      fakeApi({ status: "incomplete", output_text: "{" }).api,
      "m",
    );
    await expect(incomplete.complete(request())).rejects.toMatchObject({
      kind: "PERMANENT",
      code: "INCOMPLETE_RESPONSE",
    });
    const empty = createReviewerClientFromApi(
      fakeApi({ status: "completed", output_text: "  " }).api,
      "m",
    );
    await expect(empty.complete(request())).rejects.toMatchObject({
      kind: "PERMANENT",
      code: "EMPTY_RESPONSE",
    });
  });
});

describe("error mapping", () => {
  const headers = new Headers();

  it.each([
    [new OpenAI.RateLimitError(429, undefined, "slow down", headers), "TRANSIENT", "RATE_LIMITED"],
    [
      new OpenAI.InternalServerError(503, undefined, "unavailable", headers),
      "TRANSIENT",
      "SERVER_ERROR",
    ],
    [new OpenAI.APIConnectionError({ message: "socket hang up" }), "TRANSIENT", "CONNECTION_ERROR"],
    [new OpenAI.APIConnectionTimeoutError({ message: "timed out" }), "TIMEOUT", "TIMEOUT"],
    [new OpenAI.APIUserAbortError({ message: "aborted" }), "TIMEOUT", "ABORTED"],
    [
      new OpenAI.AuthenticationError(401, undefined, "bad key", headers),
      "PERMANENT",
      "AUTHENTICATION_FAILED",
    ],
    [
      new OpenAI.PermissionDeniedError(403, undefined, "denied", headers),
      "PERMANENT",
      "PERMISSION_DENIED",
    ],
    [new OpenAI.BadRequestError(400, undefined, "bad schema", headers), "PERMANENT", "BAD_REQUEST"],
    [new OpenAI.NotFoundError(404, undefined, "no model", headers), "PERMANENT", "NOT_FOUND"],
    [new Error("random"), "PERMANENT", "UNKNOWN"],
  ] as const)("maps %o", (error, kind, code) => {
    expect(mapOpenAIError(error)).toMatchObject({ kind, code });
  });

  it("never propagates provider error text, which could contain the API key", async () => {
    const leaky = new OpenAI.AuthenticationError(
      401,
      { message: `Incorrect API key provided: ${FAKE_KEY}` },
      `401 Incorrect API key provided: ${FAKE_KEY}`,
      headers,
    );
    const client = createReviewerClientFromApi(fakeApi(leaky).api, "m");
    const error = await client.complete(request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReviewerError);
    expect(String(error)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect((error as ReviewerError).message).toBe(
      "reviewer permanent error: AUTHENTICATION_FAILED (HTTP 401)",
    );
  });
});

describe("SDK configuration", () => {
  it("pins the endpoint, disables SDK logging and SDK retries, and sets a timeout", () => {
    expect(buildOpenAIOptions({ apiKey: FAKE_KEY, model: "m" })).toEqual({
      apiKey: FAKE_KEY,
      baseURL: OPENAI_BASE_URL,
      organization: null,
      project: null,
      webhookSecret: null,
      timeout: ATTEMPT_TIMEOUT_MS,
      maxRetries: 0,
      logLevel: "off",
    });
  });

  it("ignores environment overrides that could redirect the key", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
    vi.stubEnv("OPENAI_ORG_ID", "org-attacker");
    vi.stubEnv("OPENAI_LOG", "debug");
    const sdk = new OpenAI(buildOpenAIOptions({ apiKey: FAKE_KEY, model: "m" }));
    expect(sdk.baseURL).toBe(OPENAI_BASE_URL);
    expect(sdk.organization).toBeNull();
    expect(sdk.maxRetries).toBe(0);
    expect(sdk.logLevel).toBe("off");
  });
});

describe("SDK isolation", () => {
  it("only openai-reviewer.ts imports the OpenAI SDK", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!["node_modules", "generated", ".next"].includes(entry.name)) walk(path);
        } else if (
          /\.(ts|tsx|mts)$/.test(entry.name) &&
          /from ["']openai["']/.test(readFileSync(path, "utf8"))
        ) {
          importers.push(path);
        }
      }
    };
    walk("src");
    walk("scripts");
    walk("prisma");
    expect(importers).toEqual([join("scripts", "ai-review", "openai-reviewer.ts")]);
  });
});

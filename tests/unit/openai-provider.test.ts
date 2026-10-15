import { describe, expect, it } from "vitest";

import { DEFAULT_OPENAI_MODEL, providerFromEnv } from "@/server/ai/configured-provider";
import {
  createOpenAiProvider,
  OPENAI_RESPONSES_URL,
  REASONING_TOKEN_ALLOWANCE,
} from "@/server/ai/openai-provider";
import { AiProviderError, type AiRequest } from "@/server/ai/provider";
import { runProvider } from "@/server/ai/run";
import { parseAiEnv } from "@/server/env-schema";

// The OpenAI provider against a deterministic stand-in for api.openai.com: the pinned
// endpoint, the exact request, output parsing and the failure mapping. No network.

// Assembled from fragments so no key-shaped literal exists in the source (.gitleaks.toml).
const KEY = ["sk", "test", "0123456789abcdefghijklmnop"].join("-");

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function fakeOpenAi(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (input: URL | RequestInfo, init?: RequestInit) => {
    const call = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const answered = (text: string, extra: Record<string, unknown> = {}) =>
  json({
    id: "resp_1",
    model: "gpt-5.5-2026-01-01",
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
    usage: { input_tokens: 812, output_tokens: 240 },
    ...extra,
  });

const request = (signal = new AbortController().signal): AiRequest => ({
  operation: "AD_PLAN",
  language: "ar",
  system: "Return exactly one JSON object.",
  user: "Plan a campaign.",
  maxOutputTokens: 1500,
  signal,
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
};

describe("OpenAI provider", () => {
  it("sends one request to the pinned Responses endpoint, unstored, JSON only, key in the header", async () => {
    const { fetchImpl, calls } = fakeOpenAi(() => answered('{"ok":true}'));
    const provider = createOpenAiProvider({ apiKey: KEY, model: "gpt-5.5", fetch: fetchImpl });
    const response = await provider.generate(request());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(OPENAI_RESPONSES_URL);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call?.body).toEqual({
      model: "gpt-5.5",
      instructions: "Return exactly one JSON object.",
      input: "Plan a campaign.",
      store: false,
      max_output_tokens: 1500,
      text: { format: { type: "json_object" } },
    });
    // The key travels only in the header.
    expect(JSON.stringify(call?.body)).not.toContain(KEY);
    expect(response).toEqual({
      text: '{"ok":true}',
      provider: "openai",
      model: "gpt-5.5-2026-01-01",
      usage: { inputTokens: 812, outputTokens: 240 },
    });
  });

  it("asks for a reasoning effort and room for reasoning only when configured", async () => {
    const { fetchImpl, calls } = fakeOpenAi(() => answered("{}"));
    const provider = createOpenAiProvider({
      apiKey: KEY,
      model: "gpt-5.5",
      reasoningEffort: "low",
      fetch: fetchImpl,
    });
    await provider.generate(request());
    expect(calls[0]?.body).toMatchObject({
      reasoning: { effort: "low" },
      max_output_tokens: 1500 + REASONING_TOKEN_ALLOWANCE,
    });
  });

  it("reports unknown usage as null rather than guessing", async () => {
    const { fetchImpl } = fakeOpenAi(() => answered("{}", { usage: undefined }));
    const provider = createOpenAiProvider({ apiKey: KEY, model: "m", fetch: fetchImpl });
    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it.each([
    [
      "a refusal",
      () =>
        json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
        }),
      "refused",
    ],
    ["an incomplete answer", () => answered('{"cut', { status: "incomplete" }), "invalid_output"],
    ["an empty answer", () => answered("   "), "invalid_output"],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), "invalid_output"],
    ["429", () => json({ error: { message: "slow down" } }, 429), "rate_limited"],
    ["500", () => json({ error: {} }, 500), "unavailable"],
    [
      "401 (bad key)",
      () => json({ error: { message: `Incorrect API key ${KEY}` } }, 401),
      "unavailable",
    ],
    [
      "404 (unknown model)",
      () => json({ error: { message: "model not found" } }, 404),
      "unavailable",
    ],
  ] as const)("maps %s to %s without exposing the key", async (_label, reply, kind) => {
    const { fetchImpl } = fakeOpenAi(reply);
    const provider = createOpenAiProvider({ apiKey: KEY, model: "m", fetch: fetchImpl });
    const error = await failure(provider.generate(request()));
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).kind).toBe(kind);
    expect((error as Error).message).not.toContain(KEY);
  });

  it("treats a network failure as unavailable and an abort as a timeout", async () => {
    const network = createOpenAiProvider({
      apiKey: KEY,
      model: "m",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(((await failure(network.generate(request()))) as AiProviderError).kind).toBe(
      "unavailable",
    );
    const controller = new AbortController();
    controller.abort();
    const aborted = createOpenAiProvider({
      apiKey: KEY,
      model: "m",
      fetch: () => Promise.reject(new DOMException("aborted", "AbortError")),
    });
    expect(
      ((await failure(aborted.generate(request(controller.signal)))) as AiProviderError).kind,
    ).toBe("timeout");
  });

  it("is retried once on a server error and never on a rate limit (runProvider)", async () => {
    let n = 0;
    const flaky = fakeOpenAi(() => (n++ === 0 ? json({}, 503) : answered("{}")));
    const run = await runProvider(
      createOpenAiProvider({ apiKey: KEY, model: "m", fetch: flaky.fetchImpl }),
      { ...request(), signal: undefined } as unknown as Omit<AiRequest, "signal">,
      { timeoutMs: 5000 },
    );
    expect(run.attempts).toBe(2);
    const limited = fakeOpenAi(() => json({}, 429));
    await expect(
      runProvider(
        createOpenAiProvider({ apiKey: KEY, model: "m", fetch: limited.fetchImpl }),
        request() as unknown as Omit<AiRequest, "signal">,
        { timeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ kind: "rate_limited", attempts: 1 });
    expect(limited.calls).toHaveLength(1);
  });
});

describe("AI provider selection", () => {
  it("needs a key for openai and picks the provider from AI_PROVIDER", () => {
    expect(() => parseAiEnv({ AI_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      parseAiEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: KEY, OPENAI_MODEL: "GPT 5" }),
    ).toThrow(/OPENAI_MODEL/);
    expect(() =>
      parseAiEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: KEY, OPENAI_REASONING_EFFORT: "max" }),
    ).toThrow(/OPENAI_REASONING_EFFORT/);

    expect(providerFromEnv(parseAiEnv({}))).toBeNull();
    expect(providerFromEnv(parseAiEnv({ AI_PROVIDER: "fake" }))?.name).toBe("fake");
    expect(providerFromEnv(parseAiEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: KEY }))?.name).toBe(
      "openai",
    );
  });

  it("uses OPENAI_MODEL, else the project default, and the configured reasoning effort", async () => {
    const { fetchImpl, calls } = fakeOpenAi(() => answered("{}"));
    const chosen = providerFromEnv(
      parseAiEnv({
        AI_PROVIDER: "openai",
        OPENAI_API_KEY: KEY,
        OPENAI_MODEL: "gpt-5.5-mini",
        OPENAI_REASONING_EFFORT: "minimal",
      }),
      { fetch: fetchImpl },
    );
    await chosen?.generate(request());
    expect(calls[0]?.body).toMatchObject({
      model: "gpt-5.5-mini",
      reasoning: { effort: "minimal" },
    });
    const fallback = providerFromEnv(parseAiEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: KEY }), {
      fetch: fetchImpl,
    });
    await fallback?.generate(request());
    expect(calls[1]?.body).toMatchObject({ model: DEFAULT_OPENAI_MODEL });
    expect(calls[1]?.body).not.toHaveProperty("reasoning");
  });
});

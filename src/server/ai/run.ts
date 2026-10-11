import {
  AiProviderError,
  isAiProviderError,
  RETRYABLE_FAILURES,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from "./provider";

// One bounded provider call: a hard timeout per attempt (enforced even if a provider
// ignores the abort signal) and at most one retry, only for transient failures (timeout,
// unavailable). Refusals, provider rate limits and invalid output are never retried.

export const MAX_RETRIES = 1;

export interface RunOptions {
  readonly timeoutMs: number;
  readonly maxRetries?: number;
  /** Clock for latency (tests). */
  readonly now?: () => number;
}

export interface RunResult {
  readonly response: AiResponse;
  readonly attempts: number;
  readonly latencyMs: number;
}

export class AiRunError extends AiProviderError {
  readonly attempts: number;
  readonly latencyMs: number;

  constructor(cause: AiProviderError, attempts: number, latencyMs: number) {
    super(cause.kind, cause.message, { cause });
    this.name = "AiRunError";
    this.attempts = attempts;
    this.latencyMs = latencyMs;
  }
}

function normalize(error: unknown): AiProviderError {
  if (isAiProviderError(error)) return error;
  return new AiProviderError("unavailable", "Provider call failed", { cause: error });
}

async function attempt(
  provider: AiProvider,
  request: Omit<AiRequest, "signal">,
  timeoutMs: number,
): Promise<AiResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiProviderError("timeout", `No response within ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      provider.generate({ ...request, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runProvider(
  provider: AiProvider,
  request: Omit<AiRequest, "signal">,
  options: RunOptions,
): Promise<RunResult> {
  const now = options.now ?? Date.now;
  const maxRetries = Math.min(options.maxRetries ?? MAX_RETRIES, MAX_RETRIES);
  const started = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const response = await attempt(provider, request, options.timeoutMs);
      return { response, attempts, latencyMs: Math.max(0, now() - started) };
    } catch (error) {
      const failure = normalize(error);
      if (attempts > maxRetries || !RETRYABLE_FAILURES.has(failure.kind)) {
        throw new AiRunError(failure, attempts, Math.max(0, now() - started));
      }
    }
  }
}

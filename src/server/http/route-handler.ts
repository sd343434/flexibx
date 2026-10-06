import "server-only";

import { randomUUID } from "node:crypto";

import type { z } from "zod";

import { AppError } from "../errors/app-error";
import { errorResponse, toAppError } from "../errors/http";
import { createRequestLogger, type Logger } from "../logger";
import { parseInput } from "../validation/parse";

/** Default request body cap. Uploads go directly to object storage, never through the API. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

type Schema = z.ZodType;
type Output<S> = S extends Schema ? z.output<S> : undefined;

export interface RouteDefinition<Q, B, P, R> {
  /** Stable route name for logs, e.g. `health.get`. */
  readonly name: string;
  readonly query?: Q;
  readonly body?: B;
  readonly params?: P;
  readonly maxBodyBytes?: number;
  readonly handler: (input: RouteInput<Output<Q>, Output<B>, Output<P>>) => Promise<R> | R;
}

export interface RouteInput<Q, B, P> {
  readonly request: Request;
  readonly query: Q;
  readonly body: B;
  readonly params: P;
  readonly requestId: string;
  readonly logger: Logger;
}

export interface RouteContext {
  readonly params: Promise<Record<string, string | string[] | undefined>>;
}

function resolveRequestId(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  return incoming !== null && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", { metadata: { declaredLength, maxBytes } });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", { metadata: { contentType } });
  }

  const raw = await request.text();
  // Content-Length can be absent or wrong (chunked encoding) — check the actual size too.
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", { metadata: { maxBytes } });
  }
  if (raw.trim() === "") return undefined;

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AppError("VALIDATION_FAILED", {
      message: "Malformed JSON body",
      fields: [{ path: "", code: "invalid_format", params: { format: "json" } }],
      cause: error,
    });
  }
}

/**
 * Wraps a Next.js route handler with the platform's cross-cutting concerns:
 * request id, Zod validation of query/body/params, body size limits, unified error
 * responses (no internals leaked), and structured latency logging.
 *
 * Authentication/authorization are added per route in Phase 2 via the tenancy layer.
 */
export function withRoute<
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
  P extends Schema | undefined = undefined,
  R = unknown,
>(definition: RouteDefinition<Q, B, P, R>) {
  return async function routeHandler(request: Request, context?: RouteContext): Promise<Response> {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request);
    const url = new URL(request.url);
    const log = createRequestLogger({ requestId, route: definition.name, method: request.method });

    let response: Response;
    try {
      const query = (
        definition.query === undefined
          ? undefined
          : parseInput(definition.query, Object.fromEntries(url.searchParams), "query")
      ) as Output<Q>;
      const params = (
        definition.params === undefined
          ? undefined
          : parseInput(definition.params, (await context?.params) ?? {}, "params")
      ) as Output<P>;
      const body = (
        definition.body === undefined
          ? undefined
          : parseInput(
              definition.body,
              await readJsonBody(request, definition.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
              "body",
            )
      ) as Output<B>;

      const result = await definition.handler({
        request,
        query,
        body,
        params,
        requestId,
        logger: log,
      });
      response =
        result instanceof Response
          ? result
          : Response.json(result, { headers: { "cache-control": "no-store" } });
      response.headers.set("x-request-id", requestId);
    } catch (error) {
      const appError = toAppError(error);
      if (appError.httpStatus >= 500) {
        // Server faults: full error (redacted) with stack for debugging.
        log.error(
          { err: error, code: appError.code, metadata: appError.metadata },
          `Request failed: ${appError.message}`,
        );
      } else {
        // Client errors are expected: log the code and context, not a stack trace.
        log.warn(
          { code: appError.code, metadata: appError.metadata, fields: appError.fields },
          `Request rejected: ${appError.message}`,
        );
      }
      response = errorResponse(appError, requestId);
    }

    log.info(
      {
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        path: url.pathname,
      },
      "request completed",
    );
    return response;
  };
}

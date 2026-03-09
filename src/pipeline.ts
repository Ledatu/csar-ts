/**
 * Pipeline / Middleware architecture for CSAR interceptors.
 *
 * Each middleware receives a context and a `next()` function that invokes
 * the rest of the chain. This keeps retry logic, circuit breaker checks,
 * header injection, deduplication, and logging cleanly separated.
 *
 * The pipeline is used directly by the Fetch adapter. The Axios adapter
 * uses the same individual step functions adapted to Axios's interceptor model.
 */

import type { CsarConfig, HeadersLike } from "./types.js";
import type { CsarLogger } from "./logger.js";
import {
  CSAR_BACKPRESSURE_STATUS,
  CSAR_HEADER_CLIENT_LIMIT,
  CSAR_STATUS_CIRCUIT_OPEN,
  CSAR_STATUS_CIRCUIT_HALF_OPEN,
} from "./constants.js";
import { extractCsarStatus, extractWaitTime, extractWaitTimeWithSource } from "./extractor.js";
import { CsarBackpressureError, CsarCircuitBrokenError } from "./errors.js";
import { sleep } from "./sleep.js";
import { ClientCircuitBreaker, extractOrigin } from "./circuit-breaker.js";
import { RequestDeduplicator } from "./dedup.js";
import { generateTraceparent } from "./trace.js";

// ── Middleware type ───────────────────────────────────────────────────

/**
 * A fetch middleware receives the input/init and a `next` function.
 * It can modify the request, inspect the response, or short-circuit.
 */
export type FetchMiddleware = (
  input: RequestInfo | URL,
  init: RequestInit,
  next: (input: RequestInfo | URL, init: RequestInit) => Promise<Response>,
) => Promise<Response>;

// ── Pipeline composer ─────────────────────────────────────────────────

/**
 * Composes an array of middlewares into a single fetch-compatible function.
 * Middlewares execute left-to-right (first middleware is outermost).
 */
export function composeFetchPipeline(
  middlewares: FetchMiddleware[],
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const resolvedInit: RequestInit = init ?? {};

    let index = 0;

    function next(
      inp: RequestInfo | URL,
      ini: RequestInit,
    ): Promise<Response> {
      if (index >= middlewares.length) {
        return baseFetch(inp, ini);
      }
      const mw = middlewares[index++];
      return mw(inp, ini, next);
    }

    return next(input, resolvedInit);
  };
}

// ── Individual middleware factories ───────────────────────────────────

/**
 * Injects `X-CSAR-Client-Limit` and trace headers on outgoing requests.
 */
export function createHeadersMiddleware(config: CsarConfig): FetchMiddleware {
  return (input, init, next) => {
    const headers = new Headers(init.headers);

    if (config.clientLimitRps != null) {
      headers.set(CSAR_HEADER_CLIENT_LIMIT, String(config.clientLimitRps));
    }

    if (config.generateTraceId) {
      const { traceId, traceparent } = generateTraceparent();
      if (!headers.has("X-Request-Id")) {
        headers.set("X-Request-Id", traceId);
      }
      if (!headers.has("traceparent")) {
        headers.set("traceparent", traceparent);
      }
    }

    return next(input, { ...init, headers });
  };
}

/**
 * Checks the client-side circuit breaker before sending, and records
 * success/failure after the response.
 */
export function createCircuitBreakerMiddleware(
  cb: ClientCircuitBreaker,
  log: CsarLogger,
): FetchMiddleware {
  return async (input, init, next) => {
    const url = resolveUrl(input);
    const origin = extractOrigin(url);

    // Pre-flight check — throws CsarCircuitBrokenError if open
    cb.check(origin);

    const response = await next(input, init);

    if (response.status >= 500) {
      cb.onFailure(origin);
      log.circuitBreaker(cb.getState(origin), origin);
    } else {
      cb.onSuccess(origin);
    }

    return response;
  };
}

/**
 * Collapses identical in-flight GET requests into a single network call.
 */
export function createDedupMiddleware(
  dedup: RequestDeduplicator,
  log: CsarLogger,
): FetchMiddleware {
  return async (input, init, next) => {
    const url = resolveUrl(input);
    const method = init.method?.toUpperCase() ?? "GET";

    return dedup.execute(url, method, async () => {
      if (method === "GET" && dedup.size > 0) {
        log.dedup(url);
      }
      return next(input, init);
    });
  };
}

/**
 * Handles 503 backpressure responses: classifies the error, extracts
 * wait time, sleeps, and retries. This is the innermost middleware
 * that wraps the actual HTTP call.
 */
export function createRetryMiddleware(
  config: CsarConfig,
  log: CsarLogger,
): FetchMiddleware {
  return async (input, init, next) => {
    const url = resolveUrl(input);
    const signal = init.signal ?? undefined;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await next(input, init);

      if (response.status !== CSAR_BACKPRESSURE_STATUS) {
        // Log informational server wait on success
        log.serverWait(response.headers, url);
        return response;
      }

      attempt++;

      // ── Classify the 503 ──────────────────────────────────────────
      const csarStatus = extractCsarStatus(response.headers);

      // Server circuit breaker — throw immediately
      if (
        csarStatus === CSAR_STATUS_CIRCUIT_OPEN ||
        csarStatus === CSAR_STATUS_CIRCUIT_HALF_OPEN
      ) {
        throw new CsarCircuitBrokenError(
          `Server circuit breaker is ${csarStatus} for ${url}`,
          "server",
        );
      }

      // Fallback: detect circuit breaker from body
      if (!csarStatus) {
        const cloned = response.clone();
        try {
          const body = await cloned.text();
          if (body.includes("circuit breaker open")) {
            throw new CsarCircuitBrokenError(
              `Server circuit breaker open (body) for ${url}`,
              "server",
            );
          }
        } catch (e) {
          if (e instanceof CsarCircuitBrokenError) throw e;
        }
      }

      // ── Throttled — wait and retry ────────────────────────────────
      const { waitMs, source } = extractWaitTimeWithSource(response.headers);

      if (waitMs !== null && waitMs > config.maxWaitMs) {
        throw new CsarBackpressureError(
          `Router requested ${waitMs}ms wait, exceeds maxWaitMs (${config.maxWaitMs})`,
          waitMs,
          attempt,
        );
      }

      if (attempt > config.maxRetries) {
        throw new CsarBackpressureError(
          `Max retries (${config.maxRetries}) exhausted for ${url}`,
          waitMs,
          attempt,
        );
      }

      const delayMs = waitMs ?? 1000;

      log.retry(delayMs, attempt, config.maxRetries, url, source);
      config.onRetry?.(delayMs, attempt, response);

      await sleep(delayMs, signal);
    }
  };
}

// ── Shared helpers (also used by Axios adapter) ──────────────────────

/**
 * Classifies a 503 response and determines the action:
 * - `"circuit_open"`: throw immediately
 * - `"throttled"`: extract wait time and retry
 * - `null`: unknown 503 (treat as throttled)
 */
export interface BackpressureClassification {
  kind: "circuit_open" | "throttled";
  csarStatus: string | null;
  waitMs: number | null;
}

export function classifyBackpressure(
  headers: HeadersLike,
  body?: string,
): BackpressureClassification {
  const csarStatus = extractCsarStatus(headers);

  if (
    csarStatus === CSAR_STATUS_CIRCUIT_OPEN ||
    csarStatus === CSAR_STATUS_CIRCUIT_HALF_OPEN
  ) {
    return { kind: "circuit_open", csarStatus, waitMs: null };
  }

  // Fallback body detection
  if (!csarStatus && body && body.includes("circuit breaker open")) {
    return { kind: "circuit_open", csarStatus: null, waitMs: null };
  }

  return { kind: "throttled", csarStatus, waitMs: extractWaitTime(headers) };
}

// ── Utility ──────────────────────────────────────────────────────────

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

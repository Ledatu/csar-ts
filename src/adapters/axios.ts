import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from "axios";
import type { CsarConfig } from "../types.js";
import {
  CSAR_BACKPRESSURE_STATUS,
  CSAR_HEADER_CLIENT_LIMIT,
} from "../constants.js";
import { CsarBackpressureError, CsarCircuitBrokenError } from "../errors.js";
import { sleep } from "../sleep.js";
import { createLogger } from "../logger.js";
import { ClientCircuitBreaker, extractOrigin } from "../circuit-breaker.js";
import { classifyBackpressure } from "../pipeline.js";
import { generateTraceparent } from "../trace.js";

/** Key stored on `config` to track retry state across interceptor invocations. */
const RETRY_COUNT_KEY = "__csarRetry";

/**
 * Attaches CSAR resilience interceptors to an existing Axios instance.
 *
 * Pipeline (mirroring the middleware architecture):
 *   1. **Request interceptor** — injects `X-CSAR-Client-Limit`, `X-Request-Id`, `traceparent`
 *   2. **Request interceptor** — checks client-side circuit breaker
 *   3. **Response interceptor** — classifies 503, sleeps, retries
 *   4. **Response interceptor** — records CB success/failure
 */
export function applyCsarAxios(
  instance: AxiosInstance,
  config: CsarConfig,
): void {
  const log = createLogger(config.debug ?? false);

  // ── Optional: client-side circuit breaker ──────────────────────────
  const cb = config.circuitBreaker
    ? new ClientCircuitBreaker(config.circuitBreaker)
    : null;

  // ── Step 1: Request interceptor — header injection ────────────────
  instance.interceptors.request.use((reqCfg: InternalAxiosRequestConfig) => {
    // X-CSAR-Client-Limit
    if (config.clientLimitRps != null) {
      reqCfg.headers.set(
        CSAR_HEADER_CLIENT_LIMIT,
        String(config.clientLimitRps),
      );
    }

    // Trace ID / OpenTelemetry
    if (config.generateTraceId) {
      const { traceId, traceparent } = generateTraceparent();
      if (!reqCfg.headers.has("X-Request-Id")) {
        reqCfg.headers.set("X-Request-Id", traceId);
      }
      if (!reqCfg.headers.has("traceparent")) {
        reqCfg.headers.set("traceparent", traceparent);
      }
    }

    return reqCfg;
  });

  // ── Step 2: Request interceptor — client circuit breaker check ────
  if (cb) {
    instance.interceptors.request.use((reqCfg: InternalAxiosRequestConfig) => {
      if (reqCfg.url) {
        const origin = extractOrigin(
          reqCfg.baseURL ? `${reqCfg.baseURL}${reqCfg.url}` : reqCfg.url,
        );
        cb.check(origin); // throws CsarCircuitBrokenError if open
      }
      return reqCfg;
    });
  }

  // ── Step 3: Response interceptor — success path (CB tracking) ─────
  instance.interceptors.response.use((response) => {
    if (cb && response.config.url) {
      const origin = extractOrigin(
        response.config.baseURL
          ? `${response.config.baseURL}${response.config.url}`
          : response.config.url,
      );
      cb.onSuccess(origin);
    }

    // Log server-side wait time on success
    log.serverWait(
      response.headers as Record<string, string>,
      response.config.url ?? "",
    );

    return response;
  });

  // ── Step 4: Response error interceptor — backpressure handling ────
  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    const response = error.response;
    const reqConfig = error.config;

    if (!response || response.status !== CSAR_BACKPRESSURE_STATUS || !reqConfig) {
      // Non-503 or no config — pass through. Track CB failure for 5xx.
      if (cb && response && response.status >= 500 && reqConfig?.url) {
        const origin = extractOrigin(
          reqConfig.baseURL
            ? `${reqConfig.baseURL}${reqConfig.url}`
            : reqConfig.url,
        );
        cb.onFailure(origin);
        log.circuitBreaker(cb.getState(origin), origin);
      }
      throw error;
    }

    // Track attempt count
    const attempt: number =
      ((reqConfig as unknown as Record<string, unknown>)[RETRY_COUNT_KEY] as number ?? 0) + 1;

    // ── Classify the 503 using shared pipeline logic ────────────────
    const body =
      typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data ?? "");

    const classification = classifyBackpressure(
      response.headers as Record<string, string>,
      body,
    );

    // Record CB failure for this 503
    if (cb && reqConfig.url) {
      const origin = extractOrigin(
        reqConfig.baseURL
          ? `${reqConfig.baseURL}${reqConfig.url}`
          : reqConfig.url,
      );
      cb.onFailure(origin);
      log.circuitBreaker(cb.getState(origin), origin);
    }

    // Circuit breaker — throw immediately, no retry
    if (classification.kind === "circuit_open") {
      throw new CsarCircuitBrokenError(
        classification.csarStatus
          ? `Server circuit breaker is ${classification.csarStatus} for ${reqConfig.url}`
          : `Server circuit breaker open (body) for ${reqConfig.url}`,
        "server",
      );
    }

    // ── Throttled — extract wait time and retry ─────────────────────
    const waitMs = classification.waitMs;

    if (waitMs !== null && waitMs > config.maxWaitMs) {
      throw new CsarBackpressureError(
        `Router requested ${waitMs}ms wait, exceeds maxWaitMs (${config.maxWaitMs})`,
        waitMs,
        attempt,
      );
    }

    if (attempt > config.maxRetries) {
      throw new CsarBackpressureError(
        `Max retries (${config.maxRetries}) exhausted for ${reqConfig.url}`,
        waitMs,
        attempt,
      );
    }

    const delayMs = waitMs ?? 1000;

    log.retry(delayMs, attempt, config.maxRetries, reqConfig.url ?? "");
    config.onRetry?.(delayMs, attempt, error);

    const signal = reqConfig.signal as AbortSignal | undefined;
    await sleep(delayMs, signal ?? undefined);

    // Tag the config with the current retry count and re-issue
    (reqConfig as unknown as Record<string, unknown>)[RETRY_COUNT_KEY] = attempt;
    return instance.request(reqConfig);
  });
}

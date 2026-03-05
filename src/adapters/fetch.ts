import type { CsarConfig } from "../types.js";
import { createLogger } from "../logger.js";
import { ClientCircuitBreaker } from "../circuit-breaker.js";
import { RequestDeduplicator } from "../dedup.js";
import {
  composeFetchPipeline,
  createHeadersMiddleware,
  createCircuitBreakerMiddleware,
  createDedupMiddleware,
  createRetryMiddleware,
  type FetchMiddleware,
} from "../pipeline.js";

/**
 * Wraps a standard `fetch` function with CSAR backpressure handling.
 *
 * The returned function is a drop-in replacement for `fetch` that transparently
 * applies a middleware pipeline:
 *
 *   1. **injectCsarHeaders** — `X-CSAR-Client-Limit`, `X-Request-Id`, `traceparent`
 *   2. **checkClientCircuitBreaker** — short-circuits if origin is failing
 *   3. **deduplicateRequest** — collapses identical in-flight GETs
 *   4. **handleRetry** — classifies 503, sleeps, retries
 */
export function withCsarFetch(
  fetchFn: typeof globalThis.fetch,
  config: CsarConfig,
): typeof globalThis.fetch {
  const log = createLogger(config.debug ?? false);

  // ── Build the middleware stack ──────────────────────────────────────
  const middlewares: FetchMiddleware[] = [];

  // 1. Header injection (always first — outermost)
  middlewares.push(createHeadersMiddleware(config));

  // 2. Client-side circuit breaker (optional)
  if (config.circuitBreaker) {
    const cb = new ClientCircuitBreaker(config.circuitBreaker);
    middlewares.push(createCircuitBreakerMiddleware(cb, log));
  }

  // 3. Request deduplication (optional, before retry)
  if (config.dedup) {
    const dedup = new RequestDeduplicator();
    middlewares.push(createDedupMiddleware(dedup, log));
  }

  // 4. Retry handler (always last — innermost, wraps actual fetch)
  middlewares.push(createRetryMiddleware(config, log));

  return composeFetchPipeline(middlewares, fetchFn);
}

import { CSAR_HEADER_WAIT_MS } from "./constants.js";
import type { HeadersLike } from "./types.js";
import { getHeader } from "./extractor.js";

const PREFIX = "[csar-ts]";

/**
 * Internal logger interface used by adapters.
 */
export interface CsarLogger {
  /** Log a retry event. */
  retry(delayMs: number, attempt: number, maxRetries: number, url: string): void;

  /** Log server-side queue time from a successful response. */
  serverWait(headers: HeadersLike, url: string): void;

  /** Log a circuit breaker event. */
  circuitBreaker(state: string, origin: string): void;

  /** Log a request deduplication hit. */
  dedup(url: string): void;

  /** Log an auth-related event (token refresh, 401 retry, etc.). */
  auth?: (message: string) => void;
}

/**
 * Creates a logger. When `enabled` is `false`, all methods are no-ops.
 */
export function createLogger(enabled: boolean): CsarLogger {
  if (!enabled) {
    return {
      retry: noop,
      serverWait: noop,
      circuitBreaker: noop,
      dedup: noop,
      auth: noop,
    };
  }

  return {
    retry(delayMs, attempt, maxRetries, url) {
      console.log(
        `${PREFIX} ⏳ Rate limited. Waiting ${delayMs}ms (Attempt ${attempt}/${maxRetries}) for ${url}`,
      );
    },

    serverWait(headers, url) {
      const raw = getHeader(headers, CSAR_HEADER_WAIT_MS);
      if (raw !== null) {
        console.log(
          `${PREFIX} ℹ️  Server queued request for ${raw}ms before forwarding: ${url}`,
        );
      }
    },

    circuitBreaker(state, origin) {
      console.warn(
        `${PREFIX} ⚡ Circuit breaker ${state} for origin ${origin}`,
      );
    },

    dedup(url) {
      console.log(`${PREFIX} 🔗 Deduplicating in-flight GET: ${url}`);
    },

    auth(message) {
      console.log(`${PREFIX} 🔑 ${message}`);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop() {}

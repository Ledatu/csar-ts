import type { CsarAuthConfig } from "./auth/types.js";

/**
 * Configuration for the CSAR resilience SDK.
 */
export interface CsarConfig {
  /** Maximum time (ms) the client is willing to wait before throwing. */
  maxWaitMs: number;

  /** Number of retry attempts for 503 (backpressure) responses. */
  maxRetries: number;

  /**
   * Client RPS hint injected as `X-CSAR-Client-Limit` on every request.
   * Allows the router to shape traffic proactively.
   */
  clientLimitRps?: number;

  /** Enable debug logging to console. */
  debug?: boolean;

  /**
   * Optional client-side circuit breaker configuration.
   * Tracks consecutive 5xx errors per origin and short-circuits requests
   * when the threshold is exceeded.
   */
  circuitBreaker?: CircuitBreakerConfig;

  /**
   * Enable request deduplication for identical in-flight GET requests.
   * When `true`, concurrent GETs to the same URL+params share a single
   * network call. Disabled by default.
   */
  dedup?: boolean;

  /**
   * When `true`, the SDK generates a unique trace ID and injects it
   * as `X-Request-Id` (and `traceparent` W3C header) on every outgoing
   * request. Enables end-to-end tracing from browser/service to upstream.
   */
  generateTraceId?: boolean;

  /** Callback invoked before each retry sleep. */
  onRetry?: (delayMs: number, attempt: number, error: unknown) => void;

  /**
   * Optional authentication configuration.
   * When provided, the SDK automatically obtains and injects
   * Bearer tokens via the CSAR STS.
   */
  auth?: CsarAuthConfig;
}

/**
 * Client-side circuit breaker settings.
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive 5xx failures before opening the circuit. */
  threshold: number;

  /** Time (ms) the circuit stays open before allowing a test request. */
  resetTimeoutMs: number;
}

/**
 * Normalised header accessor — works with plain objects, Headers, and Axios headers.
 */
export type HeadersLike =
  | Record<string, string | string[] | undefined>
  | Headers
  | { get(name: string): string | null | undefined };

// ── Public API ─────────────────────────────────────────────────────────

// Constants (protocol headers & status values)
export {
  CSAR_HEADER_WAIT_MS,
  CSAR_HEADER_CLIENT_LIMIT,
  CSAR_HEADER_STATUS,
  CSAR_HEADER_RETRY_AFTER,
  CSAR_BACKPRESSURE_STATUS,
  CSAR_STATUS_THROTTLED,
  CSAR_STATUS_CIRCUIT_OPEN,
  CSAR_STATUS_CIRCUIT_HALF_OPEN,
} from "./constants.js";

// Types
export type { CsarConfig, CircuitBreakerConfig, HeadersLike } from "./types.js";

// Errors
export {
  CsarError,
  CsarBackpressureError,
  CsarCircuitBrokenError,
} from "./errors.js";

// Core utilities
export { extractCsarStatus, extractWaitTime, extractWaitTimeWithSource, getHeader } from "./extractor.js";
export type { WaitTimeSource, WaitTimeResult } from "./extractor.js";
export { sleep } from "./sleep.js";

// Adapters
export { applyCsarAxios } from "./adapters/axios.js";
export { applyCsarAxiosAsync } from "./adapters/axios.js";
export { withCsarFetch } from "./adapters/fetch.js";
export { withCsarFetchAsync } from "./adapters/fetch.js";

// Pipeline (middleware architecture)
export {
  composeFetchPipeline,
  createHeadersMiddleware,
  createCircuitBreakerMiddleware,
  createDedupMiddleware,
  createRetryMiddleware,
  classifyBackpressure,
} from "./pipeline.js";
export type { FetchMiddleware, BackpressureClassification } from "./pipeline.js";

// Smart features
export { RequestDeduplicator } from "./dedup.js";
export { ClientCircuitBreaker, extractOrigin } from "./circuit-breaker.js";

// Trace ID generation (OpenTelemetry compatibility)
export { generateRequestId, generateTraceparent } from "./trace.js";

// Logger
export { createLogger } from "./logger.js";
export type { CsarLogger } from "./logger.js";

// Auth
export type { CsarServiceKey, CsarAuthConfig, TokenResponse } from "./auth/types.js";
export { CsarAuthError } from "./auth/errors.js";
export type { CsarAuthErrorCode } from "./auth/errors.js";
export { loadServiceKey } from "./auth/key-loader.js";
export { createAssertion } from "./auth/assertion.js";
export { TokenManager } from "./auth/token-manager.js";
export { createAuthMiddleware } from "./auth/middleware.js";

// High-level client
export { createCsarClient } from "./client.js";
export type { CsarClientConfig, CsarClient } from "./client.js";

// ── CSAR Protocol Headers ──────────────────────────────────────────────

/** Response header: milliseconds the request spent queued in the throttle. */
export const CSAR_HEADER_WAIT_MS = "X-CSAR-Wait-MS";

/** Request header: client-to-router hint — max RPS the client can absorb. */
export const CSAR_HEADER_CLIENT_LIMIT = "X-CSAR-Client-Limit";

/** Response header: machine-readable backpressure state indicator. */
export const CSAR_HEADER_STATUS = "X-CSAR-Status";

/** Standard RFC 7231 response header for retry delay (seconds or HTTP-date). */
export const CSAR_HEADER_RETRY_AFTER = "Retry-After";

/** HTTP status code returned by the CSAR router on backpressure. */
export const CSAR_BACKPRESSURE_STATUS = 503;

// ── X-CSAR-Status Known Values ────────────────────────────────────────

/** Rate limit exceeded — request should be retried after waiting. */
export const CSAR_STATUS_THROTTLED = "throttled";

/** Circuit breaker is open — upstream is considered dead. */
export const CSAR_STATUS_CIRCUIT_OPEN = "circuit_open";

/** Circuit breaker is half-open — limited test traffic allowed. */
export const CSAR_STATUS_CIRCUIT_HALF_OPEN = "circuit_half_open";

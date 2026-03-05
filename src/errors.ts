/**
 * Base error class for all CSAR SDK errors.
 */
export class CsarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsarError";
  }
}

/**
 * Thrown when backpressure (rate limiting) cannot be absorbed:
 * - The router asks to wait longer than `maxWaitMs`, or
 * - All retry attempts have been exhausted.
 */
export class CsarBackpressureError extends CsarError {
  /** Delay the router requested (ms), if known. */
  public readonly requestedWaitMs: number | null;

  /** Which retry attempt triggered this error. */
  public readonly attempt: number;

  constructor(message: string, requestedWaitMs: number | null, attempt: number) {
    super(message);
    this.name = "CsarBackpressureError";
    this.requestedWaitMs = requestedWaitMs;
    this.attempt = attempt;
  }
}

/**
 * Thrown when the circuit breaker is open:
 * - Server-side: `X-CSAR-Status: circuit_open` / `circuit_half_open`, or
 *   response body contains `"circuit breaker open"`.
 * - Client-side: the local circuit breaker tripped after consecutive 5xx errors.
 */
export class CsarCircuitBrokenError extends CsarError {
  /** Where the circuit break was detected. */
  public readonly source: "server" | "client";

  constructor(message: string, source: "server" | "client") {
    super(message);
    this.name = "CsarCircuitBrokenError";
    this.source = source;
  }
}

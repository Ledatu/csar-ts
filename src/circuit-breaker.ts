import type { CircuitBreakerConfig } from "./types.js";
import { CsarCircuitBrokenError } from "./errors.js";

/** Possible states of the client-side circuit breaker. */
type CBState = "closed" | "open" | "half-open";

interface OriginState {
  failures: number;
  state: CBState;
  openedAt: number;
}

/**
 * Client-side circuit breaker that tracks consecutive 5xx errors per origin.
 *
 * - **Closed**: requests pass through normally.
 * - **Open**: after `threshold` consecutive 5xx on the same origin,
 *   all requests are rejected immediately with `CsarCircuitBrokenError`
 *   for `resetTimeoutMs`.
 * - **Half-open**: after the timeout, one test request is allowed through.
 *   If it succeeds the circuit closes; if it fails the circuit re-opens.
 */
export class ClientCircuitBreaker {
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;
  private readonly origins = new Map<string, OriginState>();

  constructor(config: CircuitBreakerConfig) {
    this.threshold = config.threshold;
    this.resetTimeoutMs = config.resetTimeoutMs;
  }

  /**
   * Called before issuing a request. Throws `CsarCircuitBrokenError`
   * if the circuit for this origin is open.
   */
  check(origin: string): void {
    const s = this.origins.get(origin);
    if (!s) return;

    if (s.state === "open") {
      if (Date.now() - s.openedAt >= this.resetTimeoutMs) {
        // Transition to half-open — allow one test request
        s.state = "half-open";
        return;
      }
      throw new CsarCircuitBrokenError(
        `Client circuit breaker open for ${origin}`,
        "client",
      );
    }
    // closed or half-open — let the request through
  }

  /**
   * Called after a successful response (status < 500).
   * Resets the failure counter and closes the circuit.
   */
  onSuccess(origin: string): void {
    const s = this.origins.get(origin);
    if (s) {
      s.failures = 0;
      s.state = "closed";
    }
  }

  /**
   * Called after a 5xx response.
   * Increments the failure counter and may open the circuit.
   */
  onFailure(origin: string): void {
    let s = this.origins.get(origin);
    if (!s) {
      s = { failures: 0, state: "closed", openedAt: 0 };
      this.origins.set(origin, s);
    }

    // Half-open test request failed — re-open immediately
    if (s.state === "half-open") {
      s.state = "open";
      s.openedAt = Date.now();
      return;
    }

    s.failures++;
    if (s.failures >= this.threshold) {
      s.state = "open";
      s.openedAt = Date.now();
    }
  }

  /** Returns the current state for a given origin (for observability). */
  getState(origin: string): CBState {
    return this.origins.get(origin)?.state ?? "closed";
  }
}

/**
 * Extracts the origin (scheme + host) from a URL string.
 */
export function extractOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return url;
  }
}

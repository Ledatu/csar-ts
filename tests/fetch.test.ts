import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withCsarFetch } from "../src/adapters/fetch.js";
import {
  CsarBackpressureError,
  CsarCircuitBrokenError,
} from "../src/errors.js";
import type { CsarConfig } from "../src/types.js";

function makeConfig(overrides: Partial<CsarConfig> = {}): CsarConfig {
  return {
    maxWaitMs: 5000,
    maxRetries: 3,
    ...overrides,
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("withCsarFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through non-503 responses unchanged", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true }, 200)),
    );
    const smartFetch = withCsarFetch(mockFetch, makeConfig());

    const res = await smartFetch("https://api.example.com/data");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 + X-CSAR-Status: throttled + X-CSAR-Wait-MS", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          jsonResponse(
            { error: "service temporarily unavailable" },
            503,
            { "X-CSAR-Status": "throttled", "X-CSAR-Wait-MS": "200" },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }, 200));
    });

    const smartFetch = withCsarFetch(mockFetch, makeConfig());

    const promise = smartFetch("https://api.example.com/data");
    // Advance time to cover the 200ms sleep
    await vi.advanceTimersByTimeAsync(250);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 + Retry-After (no csar headers, fallback)", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          jsonResponse(
            { error: "service temporarily unavailable" },
            503,
            { "Retry-After": "1" },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }, 200));
    });

    const smartFetch = withCsarFetch(mockFetch, makeConfig());

    const promise = smartFetch("https://api.example.com/data");
    await vi.advanceTimersByTimeAsync(1100);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws CsarCircuitBrokenError on X-CSAR-Status: circuit_open", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: "circuit breaker open" },
          503,
          { "X-CSAR-Status": "circuit_open" },
        ),
      ),
    );

    const smartFetch = withCsarFetch(mockFetch, makeConfig());

    await expect(
      smartFetch("https://api.example.com/data"),
    ).rejects.toThrow(CsarCircuitBrokenError);

    // Should NOT retry — only one call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws CsarCircuitBrokenError on body fallback detection", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: "circuit breaker open", route: "GET:/api" },
          503,
        ),
      ),
    );

    const smartFetch = withCsarFetch(mockFetch, makeConfig());

    await expect(
      smartFetch("https://api.example.com/data"),
    ).rejects.toThrow(CsarCircuitBrokenError);
  });

  it("injects X-CSAR-Client-Limit when clientLimitRps is set", async () => {
    const mockFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-CSAR-Client-Limit")).toBe("50");
      return Promise.resolve(jsonResponse({ ok: true }, 200));
    });

    const smartFetch = withCsarFetch(
      mockFetch,
      makeConfig({ clientLimitRps: 50 }),
    );

    await smartFetch("https://api.example.com/data");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws CsarBackpressureError when wait exceeds maxWaitMs", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: "service temporarily unavailable" },
          503,
          { "Retry-After": "60" }, // 60s = 60000ms > maxWaitMs 5000ms
        ),
      ),
    );

    const smartFetch = withCsarFetch(mockFetch, makeConfig({ maxWaitMs: 5000 }));

    await expect(
      smartFetch("https://api.example.com/data"),
    ).rejects.toThrow(CsarBackpressureError);
  });

  it("throws CsarBackpressureError when maxRetries exhausted", async () => {
    vi.useRealTimers(); // Use real timers for this test to avoid async rejection issues

    const mockFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: "service temporarily unavailable" },
          503,
          { "X-CSAR-Wait-MS": "10" }, // very short delay for fast test
        ),
      ),
    );

    const config = makeConfig({ maxRetries: 2, maxWaitMs: 10000 });
    const smartFetch = withCsarFetch(mockFetch, config);

    await expect(
      smartFetch("https://api.example.com/data"),
    ).rejects.toThrow(CsarBackpressureError);
    // 1 initial + 2 retries = 3 calls, then error thrown on attempt 3
    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useFakeTimers(); // restore for other tests
  });

  it("calls onRetry callback before each retry", async () => {
    vi.useRealTimers(); // Use real timers for reliable async flow

    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(
          jsonResponse(
            { error: "throttled" },
            503,
            { "X-CSAR-Wait-MS": "10" },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }, 200));
    });

    const onRetry = vi.fn();
    const smartFetch = withCsarFetch(mockFetch, makeConfig({ onRetry }));

    const res = await smartFetch("https://api.example.com/data");
    expect(res.status).toBe(200);

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(10, 1, expect.anything());
    expect(onRetry).toHaveBeenCalledWith(10, 2, expect.anything());

    vi.useFakeTimers(); // restore
  });

  // ── Client-side circuit breaker wiring ──────────────────────────────

  describe("client circuit breaker", () => {
    it("throws CsarCircuitBrokenError after threshold consecutive 5xx", async () => {
      vi.useRealTimers();

      let callCount = 0;
      const mockFetch = vi.fn(() => {
        callCount++;
        return Promise.resolve(
          jsonResponse({ error: "internal" }, 500),
        );
      });

      const smartFetch = withCsarFetch(
        mockFetch,
        makeConfig({
          circuitBreaker: { threshold: 2, resetTimeoutMs: 10_000 },
        }),
      );

      // First two calls return 500 (non-503, pass through)
      const res1 = await smartFetch("https://api.example.com/data");
      expect(res1.status).toBe(500);
      const res2 = await smartFetch("https://api.example.com/data");
      expect(res2.status).toBe(500);

      // Third call: circuit should now be open
      await expect(
        smartFetch("https://api.example.com/data"),
      ).rejects.toThrow(CsarCircuitBrokenError);

      // The third call should NOT have hit the network
      expect(callCount).toBe(2);

      vi.useFakeTimers();
    });

    it("closes circuit after a successful response", async () => {
      vi.useRealTimers();

      let callCount = 0;
      const mockFetch = vi.fn(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(jsonResponse({ error: "internal" }, 500));
        }
        // After reset timeout, test request succeeds
        return Promise.resolve(jsonResponse({ ok: true }, 200));
      });

      const smartFetch = withCsarFetch(
        mockFetch,
        makeConfig({
          circuitBreaker: { threshold: 2, resetTimeoutMs: 50 },
        }),
      );

      // Trip the circuit
      await smartFetch("https://api.example.com/data");
      await smartFetch("https://api.example.com/data");

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 60));

      // Half-open test request succeeds
      const res = await smartFetch("https://api.example.com/data");
      expect(res.status).toBe(200);

      // Circuit should be closed; next request should pass through
      const res2 = await smartFetch("https://api.example.com/data");
      expect(res2.status).toBe(200);

      vi.useFakeTimers();
    });
  });

  // ── Request deduplication wiring ────────────────────────────────────

  describe("request deduplication", () => {
    it("collapses concurrent identical GET requests into one network call", async () => {
      vi.useRealTimers();

      let resolveGate: () => void;
      const gate = new Promise<void>((r) => {
        resolveGate = r;
      });

      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        await gate;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const smartFetch = withCsarFetch(
        mockFetch,
        makeConfig({ dedup: true }),
      );

      // Fire two concurrent GETs to the same URL
      const p1 = smartFetch("https://api.example.com/data");
      const p2 = smartFetch("https://api.example.com/data");

      // Release the gate
      resolveGate!();

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Only one actual network call should have been made
      expect(callCount).toBe(1);

      vi.useFakeTimers();
    });

    it("does NOT deduplicate POST requests", async () => {
      vi.useRealTimers();

      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const smartFetch = withCsarFetch(
        mockFetch,
        makeConfig({ dedup: true }),
      );

      await Promise.all([
        smartFetch("https://api.example.com/data", { method: "POST" }),
        smartFetch("https://api.example.com/data", { method: "POST" }),
      ]);

      expect(callCount).toBe(2);

      vi.useFakeTimers();
    });
  });

  // ── Trace ID injection ──────────────────────────────────────────────

  describe("generateTraceId", () => {
    it("injects X-Request-Id and traceparent headers", async () => {
      const mockFetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          const h = new Headers(init?.headers);
          expect(h.get("X-Request-Id")).toMatch(/^[0-9a-f]{32}$/);
          expect(h.get("traceparent")).toMatch(
            /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
          );
          return Promise.resolve(jsonResponse({ ok: true }, 200));
        },
      );

      const smartFetch = withCsarFetch(
        mockFetch,
        makeConfig({ generateTraceId: true }),
      );

      await smartFetch("https://api.example.com/data");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not inject trace headers when generateTraceId is not set", async () => {
      const mockFetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          const h = new Headers(init?.headers);
          expect(h.get("X-Request-Id")).toBeNull();
          expect(h.get("traceparent")).toBeNull();
          return Promise.resolve(jsonResponse({ ok: true }, 200));
        },
      );

      const smartFetch = withCsarFetch(mockFetch, makeConfig());
      await smartFetch("https://api.example.com/data");
    });
  });
});

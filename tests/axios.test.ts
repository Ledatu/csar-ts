import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios, { type AxiosError } from "axios";
import { applyCsarAxios } from "../src/adapters/axios.js";
import { CsarBackpressureError, CsarCircuitBrokenError } from "../src/errors.js";
import type { CsarConfig } from "../src/types.js";

function makeConfig(overrides: Partial<CsarConfig> = {}): CsarConfig {
  return {
    maxWaitMs: 5000,
    maxRetries: 3,
    ...overrides,
  };
}

describe("applyCsarAxios", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects X-CSAR-Client-Limit on outgoing requests", async () => {
    const instance = axios.create();
    applyCsarAxios(instance, makeConfig({ clientLimitRps: 100 }));

    // Use a custom adapter to capture the final headers without hitting the network
    let capturedValue: string | undefined;
    instance.defaults.adapter = (config) => {
      capturedValue = config.headers.get("X-CSAR-Client-Limit") as string | undefined;
      return Promise.resolve({
        data: { ok: true },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      });
    };

    await instance.get("https://api.example.com/data");

    expect(capturedValue).toBe("100");
  });

  it("retries on 503 + X-CSAR-Status: throttled", async () => {
    const instance = axios.create();
    applyCsarAxios(instance, makeConfig());

    let callCount = 0;

    // Use axios adapter mock
    instance.interceptors.request.use((config) => {
      callCount++;
      if (callCount === 1) {
        const error = new axios.AxiosError(
          "Service Unavailable",
          "ERR_BAD_RESPONSE",
          config,
          null,
          {
            status: 503,
            statusText: "Service Unavailable",
            headers: {
              "x-csar-status": "throttled",
              "x-csar-wait-ms": "100",
            },
            data: { error: "service temporarily unavailable" },
            config,
          } as never,
        );
        return Promise.reject(error);
      }
      // Second call succeeds by returning a mock adapter response
      config.adapter = () =>
        Promise.resolve({
          data: { ok: true },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        });
      return config;
    });

    const promise = instance.get("https://api.example.com/data");
    await vi.advanceTimersByTimeAsync(150);

    const res = await promise;
    expect(res.data).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("throws CsarCircuitBrokenError on X-CSAR-Status: circuit_open", async () => {
    const instance = axios.create();
    applyCsarAxios(instance, makeConfig());

    instance.interceptors.request.use((config) => {
      const error = new axios.AxiosError(
        "Service Unavailable",
        "ERR_BAD_RESPONSE",
        config,
        null,
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "x-csar-status": "circuit_open" },
          data: { error: "circuit breaker open" },
          config,
        } as never,
      );
      return Promise.reject(error);
    });

    await expect(
      instance.get("https://api.example.com/data"),
    ).rejects.toThrow(CsarCircuitBrokenError);
  });

  it("throws CsarCircuitBrokenError on body fallback", async () => {
    const instance = axios.create();
    applyCsarAxios(instance, makeConfig());

    instance.interceptors.request.use((config) => {
      const error = new axios.AxiosError(
        "Service Unavailable",
        "ERR_BAD_RESPONSE",
        config,
        null,
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: {},
          data: { error: "circuit breaker open", route: "GET:/api" },
          config,
        } as never,
      );
      return Promise.reject(error);
    });

    await expect(
      instance.get("https://api.example.com/data"),
    ).rejects.toThrow(CsarCircuitBrokenError);
  });

  it("throws CsarBackpressureError when wait exceeds maxWaitMs", async () => {
    const instance = axios.create();
    applyCsarAxios(instance, makeConfig({ maxWaitMs: 5000 }));

    instance.interceptors.request.use((config) => {
      const error = new axios.AxiosError(
        "Service Unavailable",
        "ERR_BAD_RESPONSE",
        config,
        null,
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "retry-after": "60" },
          data: { error: "service temporarily unavailable" },
          config,
        } as never,
      );
      return Promise.reject(error);
    });

    await expect(
      instance.get("https://api.example.com/data"),
    ).rejects.toThrow(CsarBackpressureError);
  });

  it("passes through non-503 errors", async () => {
    const instance = axios.create();
    applyCsarAxios(instance, makeConfig());

    instance.interceptors.request.use((config) => {
      const error = new axios.AxiosError(
        "Not Found",
        "ERR_BAD_REQUEST",
        config,
        null,
        {
          status: 404,
          statusText: "Not Found",
          headers: {},
          data: { error: "not found" },
          config,
        } as never,
      );
      return Promise.reject(error);
    });

    await expect(
      instance.get("https://api.example.com/data"),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  // ── Client-side circuit breaker wiring ──────────────────────────────

  describe("client circuit breaker", () => {
    it("throws CsarCircuitBrokenError after threshold consecutive 503s", async () => {
      const instance = axios.create();
      applyCsarAxios(
        instance,
        makeConfig({
          maxRetries: 0, // no retries so each 503 fails immediately
          circuitBreaker: { threshold: 2, resetTimeoutMs: 10_000 },
        }),
      );

      // Custom adapter that always returns 503 with no retry headers
      instance.defaults.adapter = (config) => {
        return Promise.reject(
          new axios.AxiosError(
            "Service Unavailable",
            "ERR_BAD_RESPONSE",
            config as never,
            null,
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: {},
              data: "service unavailable",
              config: config as never,
            } as never,
          ),
        );
      };

      // First two calls: hit the network and fail with CsarBackpressureError
      await expect(
        instance.get("https://api.example.com/data"),
      ).rejects.toThrow(CsarBackpressureError);

      await expect(
        instance.get("https://api.example.com/data"),
      ).rejects.toThrow(CsarBackpressureError);

      // Third call: CB should be open — CsarCircuitBrokenError from client
      await expect(
        instance.get("https://api.example.com/data"),
      ).rejects.toThrow(CsarCircuitBrokenError);
    });
  });

  // ── Trace ID injection ──────────────────────────────────────────────

  describe("generateTraceId", () => {
    it("injects X-Request-Id and traceparent on outgoing requests", async () => {
      const instance = axios.create();
      applyCsarAxios(
        instance,
        makeConfig({ generateTraceId: true }),
      );

      let capturedRequestId: string | undefined;
      let capturedTraceparent: string | undefined;

      instance.defaults.adapter = (config) => {
        capturedRequestId = config.headers.get("X-Request-Id") as string | undefined;
        capturedTraceparent = config.headers.get("traceparent") as string | undefined;
        return Promise.resolve({
          data: { ok: true },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        });
      };

      await instance.get("https://api.example.com/data");

      expect(capturedRequestId).toMatch(/^[0-9a-f]{32}$/);
      expect(capturedTraceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      );
    });

    it("does not inject trace headers when generateTraceId is not set", async () => {
      const instance = axios.create();
      applyCsarAxios(instance, makeConfig());

      let capturedRequestId: string | undefined;
      let capturedTraceparent: string | undefined;

      instance.defaults.adapter = (config) => {
        capturedRequestId = config.headers.get("X-Request-Id") as string | undefined;
        capturedTraceparent = config.headers.get("traceparent") as string | undefined;
        return Promise.resolve({
          data: { ok: true },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        });
      };

      await instance.get("https://api.example.com/data");

      expect(capturedRequestId).toBeUndefined();
      expect(capturedTraceparent).toBeUndefined();
    });
  });
});

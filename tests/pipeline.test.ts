import { describe, it, expect, vi } from "vitest";
import {
  composeFetchPipeline,
  createHeadersMiddleware,
  createRetryMiddleware,
  classifyBackpressure,
  type FetchMiddleware,
} from "../src/pipeline.js";
import type { CsarConfig } from "../src/types.js";

function makeConfig(overrides: Partial<CsarConfig> = {}): CsarConfig {
  return { maxWaitMs: 5000, maxRetries: 3, ...overrides };
}

describe("composeFetchPipeline", () => {
  it("executes middlewares left-to-right, then calls base fetch", async () => {
    const order: string[] = [];

    const mw1: FetchMiddleware = async (input, init, next) => {
      order.push("mw1-before");
      const res = await next(input, init);
      order.push("mw1-after");
      return res;
    };

    const mw2: FetchMiddleware = async (input, init, next) => {
      order.push("mw2-before");
      const res = await next(input, init);
      order.push("mw2-after");
      return res;
    };

    const baseFetch = vi.fn(() => {
      order.push("fetch");
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const pipeline = composeFetchPipeline([mw1, mw2], baseFetch);
    await pipeline("https://example.com", {});

    expect(order).toEqual([
      "mw1-before",
      "mw2-before",
      "fetch",
      "mw2-after",
      "mw1-after",
    ]);
  });

  it("allows middleware to short-circuit (skip next)", async () => {
    const shortCircuit: FetchMiddleware = async () => {
      return new Response("short-circuited", { status: 418 });
    };

    const baseFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const pipeline = composeFetchPipeline([shortCircuit], baseFetch);

    const res = await pipeline("https://example.com", {});
    expect(res.status).toBe(418);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});

describe("createHeadersMiddleware", () => {
  it("injects X-CSAR-Client-Limit", async () => {
    const mw = createHeadersMiddleware(makeConfig({ clientLimitRps: 200 }));
    let captured: Headers | undefined;

    await mw("https://example.com", {}, async (_input, init) => {
      captured = init.headers as Headers;
      return new Response("ok");
    });

    expect(captured?.get("X-CSAR-Client-Limit")).toBe("200");
  });

  it("injects X-Request-Id and traceparent when generateTraceId is true", async () => {
    const mw = createHeadersMiddleware(makeConfig({ generateTraceId: true }));
    let captured: Headers | undefined;

    await mw("https://example.com", {}, async (_input, init) => {
      captured = init.headers as Headers;
      return new Response("ok");
    });

    expect(captured?.get("X-Request-Id")).toMatch(/^[0-9a-f]{32}$/);
    expect(captured?.get("traceparent")).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  it("does not overwrite existing trace headers", async () => {
    const mw = createHeadersMiddleware(makeConfig({ generateTraceId: true }));
    const existingHeaders = new Headers({
      "X-Request-Id": "my-custom-id",
      traceparent: "00-custom-trace-custom-parent-01",
    });
    let captured: Headers | undefined;

    await mw(
      "https://example.com",
      { headers: existingHeaders },
      async (_input, init) => {
        captured = init.headers as Headers;
        return new Response("ok");
      },
    );

    expect(captured?.get("X-Request-Id")).toBe("my-custom-id");
    expect(captured?.get("traceparent")).toBe(
      "00-custom-trace-custom-parent-01",
    );
  });
});

describe("classifyBackpressure", () => {
  it("detects circuit_open from X-CSAR-Status header", () => {
    const headers = new Headers({ "X-CSAR-Status": "circuit_open" });
    const result = classifyBackpressure(headers);
    expect(result.kind).toBe("circuit_open");
    expect(result.csarStatus).toBe("circuit_open");
  });

  it("detects circuit_half_open from X-CSAR-Status header", () => {
    const headers = new Headers({ "X-CSAR-Status": "circuit_half_open" });
    const result = classifyBackpressure(headers);
    expect(result.kind).toBe("circuit_open");
    expect(result.csarStatus).toBe("circuit_half_open");
  });

  it("falls back to body detection for circuit breaker", () => {
    const headers = new Headers();
    const result = classifyBackpressure(
      headers,
      '{"error":"circuit breaker open"}',
    );
    expect(result.kind).toBe("circuit_open");
    expect(result.csarStatus).toBeNull();
  });

  it("classifies as throttled with wait time from X-CSAR-Wait-MS", () => {
    const headers = new Headers({
      "X-CSAR-Status": "throttled",
      "X-CSAR-Wait-MS": "500",
    });
    const result = classifyBackpressure(headers);
    expect(result.kind).toBe("throttled");
    expect(result.waitMs).toBe(500);
  });

  it("classifies as throttled with wait time from Retry-After", () => {
    const headers = new Headers({ "Retry-After": "2" });
    const result = classifyBackpressure(headers);
    expect(result.kind).toBe("throttled");
    expect(result.waitMs).toBe(2000);
  });

  it("classifies unknown 503 as throttled with null wait", () => {
    const headers = new Headers();
    const result = classifyBackpressure(headers);
    expect(result.kind).toBe("throttled");
    expect(result.waitMs).toBeNull();
  });
});

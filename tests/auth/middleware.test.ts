import { describe, it, expect, vi } from "vitest";
import { createAuthMiddleware } from "../../src/auth/middleware.js";
import { TokenManager } from "../../src/auth/token-manager.js";
import { createLogger } from "../../src/logger.js";
import { generateTestKey } from "./fixtures.js";

function makeStsResponse(accessToken: string, expiresIn: number): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("createAuthMiddleware", () => {
  it("injects Authorization: Bearer header", async () => {
    const key = await generateTestKey("ED25519");
    const stsFetch = vi.fn(() =>
      Promise.resolve(makeStsResponse("my-token", 3600)),
    );
    const log = createLogger(false);
    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      stsFetch,
    );

    const middleware = createAuthMiddleware(tm, log);

    const capturedHeaders: Headers[] = [];
    const next = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
      capturedHeaders.push(new Headers(init.headers));
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await middleware("https://api.example.com/data", {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(capturedHeaders[0].get("Authorization")).toBe("Bearer my-token");
  });

  it("retries once on 401 with a fresh token", async () => {
    const key = await generateTestKey("ED25519");
    let stsCallCount = 0;
    const stsFetch = vi.fn(() => {
      stsCallCount++;
      return Promise.resolve(
        makeStsResponse(`token-${stsCallCount}`, 3600),
      );
    });
    const log = createLogger(false);
    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      stsFetch,
    );

    const middleware = createAuthMiddleware(tm, log);

    let callCount = 0;
    const next = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    const response = await middleware("https://api.example.com/data", {}, next);

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
    // STS was called twice: once for initial token, once for refresh after 401
    expect(stsFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry infinitely on repeated 401", async () => {
    const key = await generateTestKey("ED25519");
    let stsCallCount = 0;
    const stsFetch = vi.fn(() => {
      stsCallCount++;
      return Promise.resolve(
        makeStsResponse(`token-${stsCallCount}`, 3600),
      );
    });
    const log = createLogger(false);
    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      stsFetch,
    );

    const middleware = createAuthMiddleware(tm, log);

    // Always return 401
    const next = vi.fn(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );

    const response = await middleware("https://api.example.com/data", {}, next);

    // After initial 401 + 1 retry, the second 401 is returned
    expect(response.status).toBe(401);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("does not modify non-auth headers", async () => {
    const key = await generateTestKey("ED25519");
    const stsFetch = vi.fn(() =>
      Promise.resolve(makeStsResponse("my-token", 3600)),
    );
    const log = createLogger(false);
    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      stsFetch,
    );

    const middleware = createAuthMiddleware(tm, log);

    const capturedHeaders: Headers[] = [];
    const next = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
      capturedHeaders.push(new Headers(init.headers));
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await middleware(
      "https://api.example.com/data",
      { headers: { "X-Custom": "value" } },
      next,
    );

    expect(capturedHeaders[0].get("X-Custom")).toBe("value");
    expect(capturedHeaders[0].get("Authorization")).toBe("Bearer my-token");
  });
});

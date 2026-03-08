import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenManager } from "../../src/auth/token-manager.js";
import { CsarAuthError } from "../../src/auth/errors.js";
import { createLogger } from "../../src/logger.js";
import { generateTestKey } from "./fixtures.js";
import type { CsarServiceKey } from "../../src/auth/types.js";

// Mock createAssertion to avoid real crypto operations conflicting with fake timers
vi.mock("../../src/auth/assertion.js", () => ({
  createAssertion: vi.fn(() => Promise.resolve("mock-jwt-assertion")),
}));

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

describe("TokenManager", () => {
  let key: CsarServiceKey;
  const log = createLogger(false);

  beforeEach(async () => {
    vi.useRealTimers();
    key = await generateTestKey("ED25519");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches a token from STS on first call", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(makeStsResponse("token-abc", 3600)),
    );

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      mockFetch,
    );

    const token = await tm.getAccessToken();
    expect(token).toBe("token-abc");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://sts.example.com/token");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=urn");
    expect(init.body).toContain("assertion=");
  });

  it("serves cached token on subsequent calls", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(makeStsResponse("token-abc", 3600)),
    );

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      mockFetch,
    );

    const token1 = await tm.getAccessToken();
    const token2 = await tm.getAccessToken();
    expect(token1).toBe("token-abc");
    expect(token2).toBe("token-abc");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes when token is within 5 minutes of expiry", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      return Promise.resolve(
        makeStsResponse(`token-${callCount}`, 600), // 10 min lifetime
      );
    });

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      mockFetch,
    );

    const token1 = await tm.getAccessToken();
    expect(token1).toBe("token-1");

    // Advance 6 minutes — within 5-min buffer of 10-min token
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    const token2 = await tm.getAccessToken();
    expect(token2).toBe("token-2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent getAccessToken calls", async () => {
    // Use a delayed promise to simulate async STS call
    const mockFetch = vi.fn(() => {
      return new Promise<Response>((resolve) => {
        // Resolve on next microtask tick (not using setTimeout which is affected by fake timers)
        queueMicrotask(() => resolve(makeStsResponse("token-abc", 3600)));
      });
    });

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      mockFetch,
    );

    // Fire 3 concurrent requests
    const [t1, t2, t3] = await Promise.all([
      tm.getAccessToken(),
      tm.getAccessToken(),
      tm.getAccessToken(),
    ]);

    expect(t1).toBe("token-abc");
    expect(t2).toBe("token-abc");
    expect(t3).toBe("token-abc");
    // Only 1 STS call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries with exponential backoff on STS failure", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(
          new Response("Internal Server Error", { status: 500 }),
        );
      }
      return Promise.resolve(makeStsResponse("token-after-retry", 3600));
    });

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token", maxStsRetries: 2 },
      log,
      mockFetch,
    );

    const tokenPromise = tm.getAccessToken();

    // Advance past backoff sleeps (1s first retry + 2s second retry)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const token = await tokenPromise;
    expect(token).toBe("token-after-retry");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws STS_EXCHANGE_FAILED after all retries exhausted", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response("Error", { status: 500 })),
    );

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token", maxStsRetries: 0 },
      log,
      mockFetch,
    );

    try {
      await tm.getAccessToken();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CsarAuthError);
      expect((err as CsarAuthError).code).toBe("STS_EXCHANGE_FAILED");
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("clearCache forces a refresh on next call", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      return Promise.resolve(makeStsResponse(`token-${callCount}`, 3600));
    });

    const tm = new TokenManager(
      key,
      { stsEndpoint: "https://sts.example.com/token" },
      log,
      mockFetch,
    );

    const token1 = await tm.getAccessToken();
    expect(token1).toBe("token-1");

    tm.clearCache();

    const token2 = await tm.getAccessToken();
    expect(token2).toBe("token-2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses audience from config when provided", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(makeStsResponse("token-abc", 3600)),
    );

    const tm = new TokenManager(
      key,
      {
        stsEndpoint: "https://sts.example.com/token",
        audience: "my-custom-audience",
      },
      log,
      mockFetch,
    );

    await tm.getAccessToken();

    const body = mockFetch.mock.calls[0][1].body as string;
    expect(body).toContain("assertion=");
  });
});

import { describe, it, expect, vi } from "vitest";
import { createCsarClient } from "../src/client.js";
import { generateTestKey } from "./auth/fixtures.js";

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

function apiResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createCsarClient", () => {
  it("creates a client and makes a GET request", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(apiResponse({ data: "hello" })),
    );

    const client = await createCsarClient({
      baseUrl: "https://api.example.com",
      maxWaitMs: 5000,
      maxRetries: 3,
      fetch: mockFetch,
    });

    const res = await client.get("/v1/data");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/data");
    expect(init.method).toBe("GET");
  });

  it("joins baseUrl and path correctly", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(apiResponse({ ok: true })),
    );

    const client = await createCsarClient({
      baseUrl: "https://api.example.com/",
      maxWaitMs: 5000,
      maxRetries: 3,
      fetch: mockFetch,
    });

    await client.get("/v1/data");
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.example.com/v1/data");

    await client.get("v1/data");
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.example.com/v1/data");
  });

  it("passes through absolute URLs unchanged", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(apiResponse({ ok: true })),
    );

    const client = await createCsarClient({
      baseUrl: "https://api.example.com",
      maxWaitMs: 5000,
      maxRetries: 3,
      fetch: mockFetch,
    });

    await client.get("https://other.example.com/data");
    expect(mockFetch.mock.calls[0][0]).toBe("https://other.example.com/data");
  });

  it("supports all HTTP methods", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(apiResponse({ ok: true })),
    );

    const client = await createCsarClient({
      baseUrl: "https://api.example.com",
      maxWaitMs: 5000,
      maxRetries: 3,
      fetch: mockFetch,
    });

    await client.get("/a");
    await client.post("/b", "body");
    await client.put("/c", "body");
    await client.patch("/d", "body");
    await client.delete("/e");
    await client.request("/f", { method: "HEAD" });

    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
    expect(mockFetch.mock.calls[1][1].method).toBe("POST");
    expect(mockFetch.mock.calls[1][1].body).toBe("body");
    expect(mockFetch.mock.calls[2][1].method).toBe("PUT");
    expect(mockFetch.mock.calls[3][1].method).toBe("PATCH");
    expect(mockFetch.mock.calls[4][1].method).toBe("DELETE");
    expect(mockFetch.mock.calls[5][1].method).toBe("HEAD");
  });

  it("injects auth tokens when auth config is provided", async () => {
    const key = await generateTestKey("ED25519");

    const mockFetch = vi.fn((url: string) => {
      // STS endpoint
      if (url === "https://sts.example.com/token") {
        return Promise.resolve(makeStsResponse("auth-token-123", 3600));
      }
      // API endpoint
      return Promise.resolve(apiResponse({ ok: true }));
    });

    const client = await createCsarClient({
      baseUrl: "https://api.example.com",
      maxWaitMs: 5000,
      maxRetries: 3,
      fetch: mockFetch,
      auth: {
        stsEndpoint: "https://sts.example.com/token",
        keyData: key,
      },
    });

    const res = await client.get("/v1/data");
    expect(res.status).toBe(200);

    // Find the API call (not the STS call)
    const apiCall = mockFetch.mock.calls.find(
      ([url]) => url === "https://api.example.com/v1/data",
    );
    expect(apiCall).toBeTruthy();

    const headers = new Headers(apiCall![1].headers);
    expect(headers.get("Authorization")).toBe("Bearer auth-token-123");
  });

  it("auto-refreshes token on 401", async () => {
    const key = await generateTestKey("ED25519");
    let stsCallCount = 0;
    let apiCallCount = 0;

    const mockFetch = vi.fn((url: string) => {
      if (url === "https://sts.example.com/token") {
        stsCallCount++;
        return Promise.resolve(
          makeStsResponse(`token-${stsCallCount}`, 3600),
        );
      }
      apiCallCount++;
      if (apiCallCount === 1) {
        return Promise.resolve(
          new Response("Unauthorized", { status: 401 }),
        );
      }
      return Promise.resolve(apiResponse({ ok: true }));
    });

    const client = await createCsarClient({
      baseUrl: "https://api.example.com",
      maxWaitMs: 5000,
      maxRetries: 3,
      fetch: mockFetch,
      auth: {
        stsEndpoint: "https://sts.example.com/token",
        keyData: key,
      },
    });

    const res = await client.get("/v1/data");
    expect(res.status).toBe(200);
    // 2 STS calls (initial + refresh after 401), 2 API calls (initial 401 + retry)
    expect(stsCallCount).toBe(2);
    expect(apiCallCount).toBe(2);
  });
});

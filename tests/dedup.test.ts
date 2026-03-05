import { describe, it, expect, vi } from "vitest";
import { RequestDeduplicator } from "../src/dedup.js";

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

describe("RequestDeduplicator", () => {
  it("collapses identical in-flight GET requests into one call", async () => {
    const dedup = new RequestDeduplicator();
    const fetchSpy = vi.fn(() => Promise.resolve(makeResponse("ok")));

    const [r1, r2, r3] = await Promise.all([
      dedup.execute("https://api.example.com/items?a=1&b=2", "GET", fetchSpy),
      dedup.execute("https://api.example.com/items?b=2&a=1", "GET", fetchSpy), // same params, different order
      dedup.execute("https://api.example.com/items?a=1&b=2", "GET", fetchSpy),
    ]);

    // Only one actual fetch call
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // All three consumers get a response
    expect(await r1.text()).toBe("ok");
    expect(await r2.text()).toBe("ok");
    expect(await r3.text()).toBe("ok");
  });

  it("does NOT dedup POST requests", async () => {
    const dedup = new RequestDeduplicator();
    const fetchSpy = vi.fn(() => Promise.resolve(makeResponse("created")));

    await Promise.all([
      dedup.execute("https://api.example.com/items", "POST", fetchSpy),
      dedup.execute("https://api.example.com/items", "POST", fetchSpy),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT dedup different URLs", async () => {
    const dedup = new RequestDeduplicator();
    const fetchSpy = vi.fn(() => Promise.resolve(makeResponse("ok")));

    await Promise.all([
      dedup.execute("https://api.example.com/items", "GET", fetchSpy),
      dedup.execute("https://api.example.com/users", "GET", fetchSpy),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("cleans up inflight map after completion", async () => {
    const dedup = new RequestDeduplicator();
    const fetchSpy = vi.fn(() => Promise.resolve(makeResponse("ok")));

    await dedup.execute("https://api.example.com/items", "GET", fetchSpy);
    expect(dedup.size).toBe(0);
  });

  it("cleans up inflight map on error", async () => {
    const dedup = new RequestDeduplicator();
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network failure")));

    await expect(
      dedup.execute("https://api.example.com/items", "GET", fetchSpy),
    ).rejects.toThrow("network failure");

    expect(dedup.size).toBe(0);
  });

  it("propagates errors to all subscribers", async () => {
    const dedup = new RequestDeduplicator();
    const fetchSpy = vi.fn(() => Promise.reject(new Error("boom")));

    const results = await Promise.allSettled([
      dedup.execute("https://api.example.com/items", "GET", fetchSpy),
      dedup.execute("https://api.example.com/items", "GET", fetchSpy),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });
});

describe("RequestDeduplicator.key", () => {
  it("sorts query params for consistent keys", () => {
    const k1 = RequestDeduplicator.key("https://api.example.com/items?b=2&a=1");
    const k2 = RequestDeduplicator.key("https://api.example.com/items?a=1&b=2");
    expect(k1).toBe(k2);
  });
});

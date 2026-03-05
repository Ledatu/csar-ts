import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClientCircuitBreaker, extractOrigin } from "../src/circuit-breaker.js";
import { CsarCircuitBrokenError } from "../src/errors.js";

describe("ClientCircuitBreaker", () => {
  const origin = "https://api.example.com";

  it("starts in closed state", () => {
    const cb = new ClientCircuitBreaker({ threshold: 3, resetTimeoutMs: 5000 });
    expect(cb.getState(origin)).toBe("closed");
  });

  it("opens after reaching failure threshold", () => {
    const cb = new ClientCircuitBreaker({ threshold: 3, resetTimeoutMs: 5000 });
    cb.onFailure(origin);
    cb.onFailure(origin);
    expect(cb.getState(origin)).toBe("closed");

    cb.onFailure(origin);
    expect(cb.getState(origin)).toBe("open");
  });

  it("throws CsarCircuitBrokenError when open", () => {
    const cb = new ClientCircuitBreaker({ threshold: 2, resetTimeoutMs: 5000 });
    cb.onFailure(origin);
    cb.onFailure(origin);

    expect(() => cb.check(origin)).toThrow(CsarCircuitBrokenError);
  });

  it("resets on success", () => {
    const cb = new ClientCircuitBreaker({ threshold: 3, resetTimeoutMs: 5000 });
    cb.onFailure(origin);
    cb.onFailure(origin);
    cb.onSuccess(origin);
    expect(cb.getState(origin)).toBe("closed");

    // Should not open after 1 more failure (counter was reset)
    cb.onFailure(origin);
    expect(cb.getState(origin)).toBe("closed");
  });

  it("transitions to half-open after resetTimeoutMs", () => {
    vi.useFakeTimers();

    const cb = new ClientCircuitBreaker({ threshold: 2, resetTimeoutMs: 5000 });
    cb.onFailure(origin);
    cb.onFailure(origin);
    expect(cb.getState(origin)).toBe("open");

    // Advance time past the reset timeout
    vi.advanceTimersByTime(5001);

    // check() should transition to half-open and NOT throw
    expect(() => cb.check(origin)).not.toThrow();
    expect(cb.getState(origin)).toBe("half-open");

    vi.useRealTimers();
  });

  it("re-opens on failure in half-open state", () => {
    vi.useFakeTimers();

    const cb = new ClientCircuitBreaker({ threshold: 2, resetTimeoutMs: 5000 });
    cb.onFailure(origin);
    cb.onFailure(origin);

    vi.advanceTimersByTime(5001);
    cb.check(origin); // -> half-open

    cb.onFailure(origin);
    expect(cb.getState(origin)).toBe("open");

    vi.useRealTimers();
  });

  it("closes on success in half-open state", () => {
    vi.useFakeTimers();

    const cb = new ClientCircuitBreaker({ threshold: 2, resetTimeoutMs: 5000 });
    cb.onFailure(origin);
    cb.onFailure(origin);

    vi.advanceTimersByTime(5001);
    cb.check(origin); // -> half-open

    cb.onSuccess(origin);
    expect(cb.getState(origin)).toBe("closed");

    vi.useRealTimers();
  });

  it("tracks origins independently", () => {
    const cb = new ClientCircuitBreaker({ threshold: 2, resetTimeoutMs: 5000 });
    const origin2 = "https://other.example.com";

    cb.onFailure(origin);
    cb.onFailure(origin);
    expect(cb.getState(origin)).toBe("open");
    expect(cb.getState(origin2)).toBe("closed");
  });
});

describe("extractOrigin", () => {
  it("extracts origin from a full URL", () => {
    expect(extractOrigin("https://api.example.com/v1/orders?page=1")).toBe(
      "https://api.example.com",
    );
  });

  it("returns the input for invalid URLs", () => {
    expect(extractOrigin("not-a-url")).toBe("not-a-url");
  });
});

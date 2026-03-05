import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractCsarStatus, extractWaitTime, getHeader } from "../src/extractor.js";

// ── getHeader ──────────────────────────────────────────────────────────

describe("getHeader", () => {
  it("reads from a plain object (case-insensitive)", () => {
    const headers = { "x-csar-wait-ms": "123" };
    expect(getHeader(headers, "X-CSAR-Wait-MS")).toBe("123");
  });

  it("reads from a Headers object", () => {
    const headers = new Headers({ "X-CSAR-Wait-MS": "456" });
    expect(getHeader(headers, "X-CSAR-Wait-MS")).toBe("456");
  });

  it("returns null when header is missing", () => {
    expect(getHeader({}, "X-CSAR-Wait-MS")).toBeNull();
  });

  it("returns first element from array value", () => {
    const headers = { "Retry-After": ["5", "10"] };
    expect(getHeader(headers, "Retry-After")).toBe("5");
  });
});

// ── extractCsarStatus ──────────────────────────────────────────────────

describe("extractCsarStatus", () => {
  it("returns 'throttled' for X-CSAR-Status: throttled", () => {
    expect(extractCsarStatus({ "X-CSAR-Status": "throttled" })).toBe("throttled");
  });

  it("returns 'circuit_open' for X-CSAR-Status: circuit_open", () => {
    expect(extractCsarStatus({ "X-CSAR-Status": "circuit_open" })).toBe("circuit_open");
  });

  it("returns 'circuit_half_open' for X-CSAR-Status: circuit_half_open", () => {
    expect(extractCsarStatus({ "X-CSAR-Status": "circuit_half_open" })).toBe("circuit_half_open");
  });

  it("returns null for unknown status value", () => {
    expect(extractCsarStatus({ "X-CSAR-Status": "unknown_value" })).toBeNull();
  });

  it("returns null when header is absent", () => {
    expect(extractCsarStatus({})).toBeNull();
  });

  it("handles case insensitivity in value", () => {
    expect(extractCsarStatus({ "X-CSAR-Status": "THROTTLED" })).toBe("throttled");
  });
});

// ── extractWaitTime ────────────────────────────────────────────────────

describe("extractWaitTime", () => {
  it("returns X-CSAR-Wait-MS as ms (priority 1)", () => {
    const headers = {
      "X-CSAR-Wait-MS": "450",
      "Retry-After": "5",
    };
    // X-CSAR-Wait-MS should take priority
    expect(extractWaitTime(headers)).toBe(450);
  });

  it("returns Retry-After in seconds * 1000 (priority 2)", () => {
    expect(extractWaitTime({ "Retry-After": "5" })).toBe(5000);
  });

  it("parses Retry-After as HTTP-date", () => {
    const futureDate = new Date(Date.now() + 3000).toUTCString();
    const result = extractWaitTime({ "Retry-After": futureDate });
    expect(result).toBeGreaterThan(2000);
    expect(result).toBeLessThanOrEqual(3100);
  });

  it("returns null for Retry-After HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 10000).toUTCString();
    expect(extractWaitTime({ "Retry-After": pastDate })).toBeNull();
  });

  it("returns null when no relevant headers", () => {
    expect(extractWaitTime({})).toBeNull();
  });

  it("returns null for non-positive X-CSAR-Wait-MS", () => {
    expect(extractWaitTime({ "X-CSAR-Wait-MS": "0" })).toBeNull();
    expect(extractWaitTime({ "X-CSAR-Wait-MS": "-1" })).toBeNull();
  });

  it("returns null for non-numeric X-CSAR-Wait-MS", () => {
    expect(extractWaitTime({ "X-CSAR-Wait-MS": "abc" })).toBeNull();
  });
});

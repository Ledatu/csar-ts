import { describe, it, expect } from "vitest";
import { matchResource, matchAction } from "../../src/authz/matcher.js";

describe("matchResource", () => {
  // Exact matches
  it("matches exact paths", () => {
    expect(matchResource("/api/v1/users", "/api/v1/users")).toBe(true);
  });

  it("rejects different exact paths", () => {
    expect(matchResource("/api/v1/users", "/api/v1/posts")).toBe(false);
  });

  it("rejects longer paths on exact pattern", () => {
    expect(matchResource("/api/v1/users", "/api/v1/users/123")).toBe(false);
  });

  it("matches root path", () => {
    expect(matchResource("/", "/")).toBe(true);
  });

  // Single wildcard
  it("single wildcard matches one segment", () => {
    expect(matchResource("/api/v1/users/*", "/api/v1/users/123")).toBe(true);
    expect(matchResource("/api/v1/users/*", "/api/v1/users/abc")).toBe(true);
  });

  it("single wildcard does not match zero segments", () => {
    expect(matchResource("/api/v1/users/*", "/api/v1/users")).toBe(false);
  });

  it("single wildcard does not match multiple segments", () => {
    expect(matchResource("/api/v1/users/*", "/api/v1/users/123/posts")).toBe(false);
  });

  it("single wildcard in middle position", () => {
    expect(matchResource("/api/*/users", "/api/v1/users")).toBe(true);
    expect(matchResource("/api/*/users", "/api/v2/users")).toBe(true);
  });

  it("single wildcard at root", () => {
    expect(matchResource("/*", "/anything")).toBe(true);
    expect(matchResource("/*", "/")).toBe(false);
  });

  // Double wildcard
  it("double wildcard matches zero segments", () => {
    expect(matchResource("/api/**", "/api")).toBe(true);
  });

  it("double wildcard matches one segment", () => {
    expect(matchResource("/api/**", "/api/v1")).toBe(true);
  });

  it("double wildcard matches many segments", () => {
    expect(matchResource("/api/**", "/api/v1/users")).toBe(true);
    expect(matchResource("/api/**", "/api/v1/users/123/posts")).toBe(true);
  });

  it("/** matches everything", () => {
    expect(matchResource("/**", "/")).toBe(true);
    expect(matchResource("/**", "/anything")).toBe(true);
    expect(matchResource("/**", "/a/b/c/d")).toBe(true);
  });

  it("double wildcard with suffix", () => {
    expect(matchResource("/api/**/posts", "/api/posts")).toBe(true);
    expect(matchResource("/api/**/posts", "/api/v1/posts")).toBe(true);
    expect(matchResource("/api/**/posts", "/api/v1/users/posts")).toBe(true);
    expect(matchResource("/api/**/posts", "/api/v1/users/comments")).toBe(false);
  });

  // Mixed wildcards
  it("mixed single and double wildcards", () => {
    expect(matchResource("/api/*/users/**", "/api/v1/users")).toBe(true);
    expect(matchResource("/api/*/users/**", "/api/v1/users/123")).toBe(true);
    expect(matchResource("/api/*/users/**", "/api/v1/users/123/posts")).toBe(true);
    expect(matchResource("/api/*/users/**", "/api/v1/posts")).toBe(false);
  });

  // Edge cases
  it("empty strings match", () => {
    expect(matchResource("", "")).toBe(true);
  });

  it("trailing slash normalization", () => {
    expect(matchResource("/api", "/api/")).toBe(true);
    expect(matchResource("/api/", "/api")).toBe(true);
  });
});

describe("matchAction", () => {
  it("wildcard matches any action", () => {
    expect(matchAction("*", "GET")).toBe(true);
    expect(matchAction("*", "POST")).toBe(true);
    expect(matchAction("*", "DELETE")).toBe(true);
  });

  it("exact match (case-insensitive)", () => {
    expect(matchAction("GET", "GET")).toBe(true);
    expect(matchAction("GET", "get")).toBe(true);
    expect(matchAction("get", "GET")).toBe(true);
  });

  it("rejects different actions", () => {
    expect(matchAction("GET", "POST")).toBe(false);
    expect(matchAction("POST", "GET")).toBe(false);
  });
});

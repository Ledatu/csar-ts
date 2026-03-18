import { describe, it, expect, vi } from "vitest";
import { PermissionManager } from "../../src/authz/permission-manager.js";
import { CsarAuthzError } from "../../src/authz/errors.js";
import { createLogger } from "../../src/logger.js";

const mockPermissionsResponse = {
  subject: "user-123",
  platform: {
    roles: ["platform_admin"],
    permissions: [{ action: "platform.roles.create", resource: "admin" }],
  },
  tenants: {
    "t-1": {
      roles: ["editor"],
      permissions: [
        { action: "GET", resource: "/api/v1/docs/*" },
        { action: "POST", resource: "/api/v1/docs" },
      ],
    },
  },
};

function createMockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(JSON.stringify(response)),
  });
}

describe("PermissionManager", () => {
  const log = createLogger(false);
  const config = {
    permissionsEndpoint: "https://auth.example.com/auth/me/permissions",
    cacheTtlMs: 1000,
    maxRetries: 1,
    staleWhileRevalidate: false,
  };

  it("fetches permissions and returns a scoped snapshot", async () => {
    const mockFetch = createMockFetch(mockPermissionsResponse);
    const manager = new PermissionManager(config, log, mockFetch);

    const snapshot = await manager.getPermissions();

    expect(snapshot.hasRole("platform_admin")).toBe(true);
    expect(snapshot.hasRole("editor")).toBe(true);
    expect(snapshot.can("GET", "/api/v1/docs/123")).toBe(true);
    expect(snapshot.can("DELETE", "/api/v1/docs/123")).toBe(false);

    expect(snapshot.platform).not.toBeNull();
    expect(snapshot.platform!.roles).toEqual(["platform_admin"]);
    expect(snapshot.tenant("t-1")).not.toBeNull();
    expect(snapshot.tenant("t-1")!.roles).toEqual(["editor"]);

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("caches permissions within TTL", async () => {
    const mockFetch = createMockFetch(mockPermissionsResponse);
    const manager = new PermissionManager(config, log, mockFetch);

    await manager.getPermissions();
    await manager.getPermissions();
    await manager.getPermissions();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("refetches after cache expires", async () => {
    const mockFetch = createMockFetch(mockPermissionsResponse);
    const manager = new PermissionManager(
      { ...config, cacheTtlMs: 1 },
      log,
      mockFetch,
    );

    await manager.getPermissions();

    await new Promise((r) => setTimeout(r, 10));

    await manager.getPermissions();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent calls", async () => {
    const mockFetch = createMockFetch(mockPermissionsResponse);
    const manager = new PermissionManager(config, log, mockFetch);

    const [s1, s2, s3] = await Promise.all([
      manager.getPermissions(),
      manager.getPermissions(),
      manager.getPermissions(),
    ]);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
  });

  it("clears cache on clearCache()", async () => {
    const mockFetch = createMockFetch(mockPermissionsResponse);
    const manager = new PermissionManager(config, log, mockFetch);

    await manager.getPermissions();
    manager.clearCache();
    await manager.getPermissions();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws CsarAuthzError on non-OK response", async () => {
    const mockFetch = createMockFetch({ error: "forbidden" }, 403);
    const manager = new PermissionManager(
      { ...config, maxRetries: 0 },
      log,
      mockFetch,
    );

    await expect(manager.getPermissions()).rejects.toThrow(CsarAuthzError);
  });

  it("throws on invalid response shape (missing subject)", async () => {
    const mockFetch = createMockFetch({ invalid: true });
    const manager = new PermissionManager(
      { ...config, maxRetries: 0 },
      log,
      mockFetch,
    );

    await expect(manager.getPermissions()).rejects.toThrow("missing subject");
  });

  it("passes Authorization header when provided", async () => {
    const mockFetch = createMockFetch(mockPermissionsResponse);
    const manager = new PermissionManager(config, log, mockFetch);

    await manager.getPermissions("Bearer tok123");

    expect(mockFetch).toHaveBeenCalledWith(
      config.permissionsEndpoint,
      expect.objectContaining({
        headers: { Authorization: "Bearer tok123" },
      }),
    );
  });

  it("retries on failure then succeeds", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 502,
          text: () => Promise.resolve("Bad Gateway"),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockPermissionsResponse),
      });
    });

    const manager = new PermissionManager(
      { ...config, maxRetries: 1 },
      log,
      mockFetch,
    );

    const snapshot = await manager.getPermissions();
    expect(snapshot.hasRole("editor")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("accepts a response with only platform scope", async () => {
    const resp = { subject: "u", platform: { roles: ["a"], permissions: [] } };
    const mockFetch = createMockFetch(resp);
    const manager = new PermissionManager({ ...config, maxRetries: 0 }, log, mockFetch);

    const snapshot = await manager.getPermissions();
    expect(snapshot.platform).not.toBeNull();
    expect(snapshot.tenantIds).toHaveLength(0);
  });

  it("accepts a response with no scopes", async () => {
    const resp = { subject: "u" };
    const mockFetch = createMockFetch(resp);
    const manager = new PermissionManager({ ...config, maxRetries: 0 }, log, mockFetch);

    const snapshot = await manager.getPermissions();
    expect(snapshot.platform).toBeNull();
    expect(snapshot.allRoles).toHaveLength(0);
  });
});

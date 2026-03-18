import { describe, it, expect } from "vitest";
import { PermissionSnapshot } from "../../src/authz/permission-snapshot.js";
import type { PermissionsApiResponse } from "../../src/authz/types.js";

const multiScopeResponse: PermissionsApiResponse = {
  subject: "user-1",
  platform: {
    roles: ["platform_admin"],
    permissions: [
      { action: "platform.roles.create", resource: "admin" },
      { action: "*", resource: "/api/v1/admin/**" },
    ],
  },
  tenants: {
    "t-123": {
      roles: ["editor", "viewer"],
      permissions: [
        { action: "GET", resource: "/api/v1/documents/*" },
        { action: "POST", resource: "/api/v1/documents" },
        { action: "DELETE", resource: "/api/v1/documents/*" },
      ],
    },
    "t-456": {
      roles: ["viewer"],
      permissions: [
        { action: "GET", resource: "/api/v1/documents/*" },
      ],
    },
  },
};

const snapshot = new PermissionSnapshot(multiScopeResponse);

describe("PermissionSnapshot", () => {
  describe("can() - cross-scope (no scope filter)", () => {
    it("matches platform permission", () => {
      expect(snapshot.can("platform.roles.create", "admin")).toBe(true);
    });

    it("matches tenant permission", () => {
      expect(snapshot.can("GET", "/api/v1/documents/123")).toBe(true);
    });

    it("matches wildcard action in platform scope", () => {
      expect(snapshot.can("PUT", "/api/v1/admin/settings")).toBe(true);
    });

    it("returns false for unmatched action/resource", () => {
      expect(snapshot.can("PUT", "/api/v1/documents/123")).toBe(false);
    });
  });

  describe("can() - scoped", () => {
    it("matches within platform scope", () => {
      expect(snapshot.can("platform.roles.create", "admin", "platform")).toBe(true);
    });

    it("rejects tenant permission when scoped to platform", () => {
      expect(snapshot.can("GET", "/api/v1/documents/123", "platform")).toBe(false);
    });

    it("matches within a specific tenant", () => {
      expect(snapshot.can("GET", "/api/v1/documents/123", "tenant", "t-123")).toBe(true);
    });

    it("rejects when tenant has no matching permission", () => {
      expect(snapshot.can("DELETE", "/api/v1/documents/123", "tenant", "t-456")).toBe(false);
    });

    it("returns false for unknown tenant", () => {
      expect(snapshot.can("GET", "/api/v1/documents/123", "tenant", "t-999")).toBe(false);
    });
  });

  describe("hasRole()", () => {
    it("finds role across all scopes", () => {
      expect(snapshot.hasRole("platform_admin")).toBe(true);
      expect(snapshot.hasRole("editor")).toBe(true);
    });

    it("returns false for unassigned role", () => {
      expect(snapshot.hasRole("superadmin")).toBe(false);
    });

    it("scoped to platform", () => {
      expect(snapshot.hasRole("platform_admin", "platform")).toBe(true);
      expect(snapshot.hasRole("editor", "platform")).toBe(false);
    });

    it("scoped to tenant", () => {
      expect(snapshot.hasRole("editor", "tenant", "t-123")).toBe(true);
      expect(snapshot.hasRole("editor", "tenant", "t-456")).toBe(false);
    });
  });

  describe("hasAnyRole()", () => {
    it("returns true if any role matches across scopes", () => {
      expect(snapshot.hasAnyRole(["superadmin", "editor"])).toBe(true);
    });

    it("returns false if no role matches", () => {
      expect(snapshot.hasAnyRole(["superadmin", "root"])).toBe(false);
    });

    it("scoped check", () => {
      expect(snapshot.hasAnyRole(["editor"], "tenant", "t-123")).toBe(true);
      expect(snapshot.hasAnyRole(["editor"], "tenant", "t-456")).toBe(false);
    });
  });

  describe("hasAllRoles()", () => {
    it("returns true if all roles exist in one scope", () => {
      expect(snapshot.hasAllRoles(["editor", "viewer"], "tenant", "t-123")).toBe(true);
    });

    it("returns false if roles are split across scopes", () => {
      expect(snapshot.hasAllRoles(["platform_admin", "editor"], "platform")).toBe(false);
    });

    it("cross-scope: finds a single scope with all roles", () => {
      expect(snapshot.hasAllRoles(["editor", "viewer"])).toBe(true);
    });

    it("cross-scope: fails when no single scope has all roles", () => {
      expect(snapshot.hasAllRoles(["platform_admin", "editor"])).toBe(false);
    });
  });

  describe("scope accessors", () => {
    it("platform returns platform scope", () => {
      expect(snapshot.platform).not.toBeNull();
      expect(snapshot.platform!.roles).toContain("platform_admin");
    });

    it("tenant() returns specific tenant", () => {
      const t = snapshot.tenant("t-123");
      expect(t).not.toBeNull();
      expect(t!.roles).toContain("editor");
    });

    it("tenant() returns null for unknown tenant", () => {
      expect(snapshot.tenant("t-999")).toBeNull();
    });

    it("tenantIds returns all tenant IDs", () => {
      expect(snapshot.tenantIds).toEqual(expect.arrayContaining(["t-123", "t-456"]));
      expect(snapshot.tenantIds).toHaveLength(2);
    });
  });

  describe("flat union accessors", () => {
    it("allRoles returns deduplicated union across scopes", () => {
      const roles = snapshot.allRoles;
      expect(roles).toContain("platform_admin");
      expect(roles).toContain("editor");
      expect(roles).toContain("viewer");
      expect(new Set(roles).size).toBe(roles.length);
    });

    it("allPermissions returns deduplicated union", () => {
      const perms = snapshot.allPermissions;
      expect(perms.length).toBeGreaterThanOrEqual(4);
      const keys = perms.map((p) => `${p.action}:${p.resource}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe("empty/partial responses", () => {
    it("handles response with no scopes", () => {
      const empty = new PermissionSnapshot({ subject: "u", });
      expect(empty.platform).toBeNull();
      expect(empty.tenantIds).toHaveLength(0);
      expect(empty.allRoles).toHaveLength(0);
      expect(empty.can("GET", "/anything")).toBe(false);
    });

    it("handles platform-only response", () => {
      const s = new PermissionSnapshot({
        subject: "u",
        platform: { roles: ["admin"], permissions: [{ action: "GET", resource: "/*" }] },
      });
      expect(s.platform).not.toBeNull();
      expect(s.tenantIds).toHaveLength(0);
      expect(s.can("GET", "/foo")).toBe(true);
    });
  });
});

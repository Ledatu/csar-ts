import type { Permission, ScopedPermissions, PermissionsApiResponse } from "./types.js";
import { matchResource, matchAction } from "./matcher.js";

/**
 * An immutable, scope-aware snapshot of a user's roles and permissions.
 *
 * Provides convenient helpers for checking access without additional network
 * calls. The server is always the source of truth -- this snapshot is for UI
 * rendering decisions (show/hide, enable/disable).
 *
 * Methods that accept optional `scopeType` / `scopeId` params restrict the
 * check to that scope. When omitted they check across all scopes.
 *
 * @example
 * ```ts
 * const perms = await client.permissions();
 *
 * // Check across all scopes (simple product UI gating)
 * if (perms.can("DELETE", "/api/v1/documents/123")) { ... }
 *
 * // Check within a specific tenant scope (admin UI)
 * if (perms.can("tenant.members.read", "admin", "tenant", "t-123")) { ... }
 * ```
 */
export class PermissionSnapshot {
  private readonly _platform: ScopedPermissions | null;
  private readonly _tenants: ReadonlyMap<string, ScopedPermissions>;

  constructor(response: PermissionsApiResponse) {
    this._platform = response.platform
      ? freeze(response.platform)
      : null;

    const tenants = new Map<string, ScopedPermissions>();
    if (response.tenants) {
      for (const [id, sp] of Object.entries(response.tenants)) {
        tenants.set(id, freeze(sp));
      }
    }
    this._tenants = tenants;
  }

  /**
   * Returns true if any permission grants the given action on the given
   * resource. Uses the same URL pattern matching as the server.
   *
   * When `scopeType` is provided the check is restricted to that scope;
   * otherwise all scopes are searched.
   */
  can(action: string, resource: string, scopeType?: string, scopeId?: string): boolean {
    for (const sp of this.scopesFor(scopeType, scopeId)) {
      if (sp.permissions.some(
        (p) => matchAction(p.action, action) && matchResource(p.resource, resource),
      )) {
        return true;
      }
    }
    return false;
  }

  /** Returns true if the user has the given role (exact match). */
  hasRole(role: string, scopeType?: string, scopeId?: string): boolean {
    for (const sp of this.scopesFor(scopeType, scopeId)) {
      if (sp.roles.includes(role)) return true;
    }
    return false;
  }

  /** Returns true if the user has at least one of the given roles. */
  hasAnyRole(roles: string[], scopeType?: string, scopeId?: string): boolean {
    for (const sp of this.scopesFor(scopeType, scopeId)) {
      if (roles.some((r) => sp.roles.includes(r))) return true;
    }
    return false;
  }

  /** Returns true if the user has all of the given roles (within a single scope when scoped). */
  hasAllRoles(roles: string[], scopeType?: string, scopeId?: string): boolean {
    for (const sp of this.scopesFor(scopeType, scopeId)) {
      if (roles.every((r) => sp.roles.includes(r))) return true;
    }
    return false;
  }

  /** Platform-scope permissions, or null if the user has no platform assignments. */
  get platform(): ScopedPermissions | null {
    return this._platform;
  }

  /** Returns permissions for a specific tenant, or null. */
  tenant(tenantId: string): ScopedPermissions | null {
    return this._tenants.get(tenantId) ?? null;
  }

  /** All tenant IDs the user has assignments in. */
  get tenantIds(): readonly string[] {
    return [...this._tenants.keys()];
  }

  /** All effective roles across every scope (flat union, deduplicated). */
  get allRoles(): readonly string[] {
    const set = new Set<string>();
    for (const sp of this.allScopes()) {
      for (const r of sp.roles) set.add(r);
    }
    return [...set];
  }

  /** All effective permissions across every scope (flat union, deduplicated by action:resource). */
  get allPermissions(): readonly Permission[] {
    const seen = new Set<string>();
    const result: Permission[] = [];
    for (const sp of this.allScopes()) {
      for (const p of sp.permissions) {
        const key = `${p.action}:${p.resource}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(p);
        }
      }
    }
    return result;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private *allScopes(): Iterable<ScopedPermissions> {
    if (this._platform) yield this._platform;
    for (const sp of this._tenants.values()) yield sp;
  }

  private *scopesFor(scopeType?: string, scopeId?: string): Iterable<ScopedPermissions> {
    if (scopeType === undefined) {
      yield* this.allScopes();
      return;
    }
    if (scopeType === "platform" && this._platform) {
      yield this._platform;
    } else if (scopeType === "tenant" && scopeId !== undefined) {
      const sp = this._tenants.get(scopeId);
      if (sp) yield sp;
    }
  }
}

function freeze(sp: ScopedPermissions): ScopedPermissions {
  return {
    roles: Object.freeze([...sp.roles]) as string[],
    permissions: Object.freeze(sp.permissions.map((p) => ({ ...p }))) as Permission[],
  };
}

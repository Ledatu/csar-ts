/**
 * Configuration for the authorization/permissions module.
 */
export interface AuthzConfig {
  /** URL of the permissions endpoint, e.g. "https://auth.example.com/auth/me/permissions". */
  permissionsEndpoint: string;

  /** Cache TTL in milliseconds. Defaults to 60000 (1 minute). */
  cacheTtlMs?: number;

  /** Max retries for permissions endpoint calls. Defaults to 2. */
  maxRetries?: number;

  /**
   * When true, serves stale cached permissions while refreshing in the background.
   * Defaults to true.
   */
  staleWhileRevalidate?: boolean;
}

/**
 * A single permission entry: an allowed action on a resource pattern.
 */
export interface Permission {
  action: string;
  resource: string;
}

/**
 * Roles and permissions within a single scope (platform or one tenant).
 */
export interface ScopedPermissions {
  roles: string[];
  permissions: Permission[];
}

/**
 * Raw response from the GET /auth/me/permissions endpoint.
 * Keys are omitted when the user has no assignments in that scope category.
 */
export interface PermissionsApiResponse {
  subject: string;
  platform?: ScopedPermissions;
  tenants?: Record<string, ScopedPermissions>;
}

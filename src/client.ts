import type { CsarConfig } from "./types.js";
import type { AuthzConfig } from "./authz/types.js";
import { createLogger } from "./logger.js";
import { loadServiceKey } from "./auth/key-loader.js";
import { TokenManager } from "./auth/token-manager.js";
import { createAuthMiddleware } from "./auth/middleware.js";
import {
  composeFetchPipeline,
  createHeadersMiddleware,
  createCircuitBreakerMiddleware,
  createDedupMiddleware,
  createRetryMiddleware,
  type FetchMiddleware,
} from "./pipeline.js";
import { ClientCircuitBreaker } from "./circuit-breaker.js";
import { RequestDeduplicator } from "./dedup.js";
import { PermissionManager } from "./authz/permission-manager.js";
import type { PermissionSnapshot } from "./authz/permission-snapshot.js";

/**
 * Configuration for the high-level CSAR client.
 */
export interface CsarClientConfig extends CsarConfig {
  /** Base URL prepended to all request paths. */
  baseUrl: string;

  /** Custom fetch function (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;

  /**
   * Optional authorization configuration for client-side RBAC.
   * When provided, the client exposes a `permissions()` method
   * that returns a cached PermissionSnapshot with `can()`, `hasRole()`, etc.
   */
  authz?: AuthzConfig;
}

/**
 * High-level HTTP client with automatic CSAR resilience and auth.
 */
export interface CsarClient {
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: BodyInit | null, init?: RequestInit): Promise<Response>;
  put(path: string, body?: BodyInit | null, init?: RequestInit): Promise<Response>;
  patch(path: string, body?: BodyInit | null, init?: RequestInit): Promise<Response>;
  delete(path: string, init?: RequestInit): Promise<Response>;
  request(path: string, init?: RequestInit): Promise<Response>;

  /**
   * Returns the authenticated user's permission snapshot.
   * Available only when `authz` config is provided.
   *
   * @example
   * ```ts
   * const perms = await client.permissions();
   * if (perms.can("DELETE", "/api/v1/documents/123")) {
   *   // show delete button
   * }
   * ```
   */
  permissions(): Promise<PermissionSnapshot>;
}

/**
 * Creates a high-level HTTP client with CSAR resilience and optional
 * STS authentication and RBAC baked in.
 *
 * @example
 * ```ts
 * const client = await createCsarClient({
 *   baseUrl: 'https://api.my-service.internal',
 *   maxWaitMs: 5000,
 *   maxRetries: 3,
 *   auth: {
 *     stsEndpoint: 'https://csar-authn.run/sts/token',
 *     keyFile: './authorized_key.json',
 *     accessTokenAudience: 'balance-service',
 *   },
 *   authz: {
 *     permissionsEndpoint: 'https://csar-authn.run/auth/me/permissions',
 *   },
 * });
 *
 * const perms = await client.permissions();
 * if (perms.can('DELETE', '/api/v1/data/123')) {
 *   await client.delete('/v1/data/123');
 * }
 * ```
 */
export async function createCsarClient(
  config: CsarClientConfig,
): Promise<CsarClient> {
  const baseFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  const log = createLogger(config.debug ?? false);

  const middlewares: FetchMiddleware[] = [];

  // 0. Auth middleware (outermost — STS calls use raw baseFetch)
  if (config.auth) {
    const key = await loadServiceKey(config.auth);
    const tokenManager = new TokenManager(key, config.auth, log, baseFetch);
    middlewares.push(createAuthMiddleware(tokenManager, log));
  }

  // 1. Header injection
  middlewares.push(createHeadersMiddleware(config));

  // 2. Client-side circuit breaker (optional)
  if (config.circuitBreaker) {
    const cb = new ClientCircuitBreaker(config.circuitBreaker);
    middlewares.push(createCircuitBreakerMiddleware(cb, log));
  }

  // 3. Request deduplication (optional)
  if (config.dedup) {
    const dedup = new RequestDeduplicator();
    middlewares.push(createDedupMiddleware(dedup, log));
  }

  // 4. Retry handler (innermost)
  middlewares.push(createRetryMiddleware(config, log));

  const pipeline = composeFetchPipeline(middlewares, baseFetch);

  // Permission manager (optional).
  let permissionManager: PermissionManager | null = null;
  if (config.authz) {
    permissionManager = new PermissionManager(config.authz, log, pipeline);
  }

  function resolveUrl(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const base = config.baseUrl.endsWith("/")
      ? config.baseUrl.slice(0, -1)
      : config.baseUrl;
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${base}${p}`;
  }

  return {
    request(path, init = {}) {
      return pipeline(resolveUrl(path), init);
    },
    get(path, init = {}) {
      return pipeline(resolveUrl(path), { ...init, method: "GET" });
    },
    post(path, body, init = {}) {
      return pipeline(resolveUrl(path), { ...init, method: "POST", body });
    },
    put(path, body, init = {}) {
      return pipeline(resolveUrl(path), { ...init, method: "PUT", body });
    },
    patch(path, body, init = {}) {
      return pipeline(resolveUrl(path), { ...init, method: "PATCH", body });
    },
    delete(path, init = {}) {
      return pipeline(resolveUrl(path), { ...init, method: "DELETE" });
    },
    async permissions() {
      if (!permissionManager) {
        throw new Error(
          "Permissions not configured. Provide an `authz` config to createCsarClient().",
        );
      }
      return permissionManager.getPermissions();
    },
  };
}

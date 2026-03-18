import type { AuthzConfig, PermissionsApiResponse } from "./types.js";
import type { CsarLogger } from "../logger.js";
import { PermissionSnapshot } from "./permission-snapshot.js";
import { CsarAuthzError } from "./errors.js";
import { sleep } from "../sleep.js";

/**
 * Manages fetching, caching, and refreshing of user permissions.
 *
 * Follows the same patterns as TokenManager:
 * - In-memory caching with configurable TTL
 * - Deduplication of concurrent fetch calls
 * - Stale-while-revalidate support
 * - Exponential backoff on failures
 */
export class PermissionManager {
  private cached: { snapshot: PermissionSnapshot; fetchedAt: number } | null =
    null;
  private refreshing: Promise<PermissionSnapshot> | null = null;

  private readonly config: Required<
    Pick<AuthzConfig, "cacheTtlMs" | "maxRetries" | "staleWhileRevalidate">
  > &
    AuthzConfig;
  private readonly log: CsarLogger;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    config: AuthzConfig,
    log: CsarLogger,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.config = {
      cacheTtlMs: 60_000,
      maxRetries: 2,
      staleWhileRevalidate: true,
      ...config,
    };
    this.log = log;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Returns a PermissionSnapshot for the authenticated user.
   *
   * - Serves from cache if fresh.
   * - If stale and `staleWhileRevalidate` is true, returns stale data
   *   and refreshes in the background.
   * - Deduplicates concurrent calls.
   *
   * The caller must include an Authorization header by using this
   * after the auth middleware has injected the Bearer token.
   */
  async getPermissions(authHeader?: string): Promise<PermissionSnapshot> {
    const now = Date.now();

    // Fresh cache hit.
    if (
      this.cached &&
      now - this.cached.fetchedAt < this.config.cacheTtlMs
    ) {
      return this.cached.snapshot;
    }

    // Stale cache — serve stale while refreshing in background.
    if (this.cached && this.config.staleWhileRevalidate) {
      if (!this.refreshing) {
        this.refreshing = this.doFetch(authHeader).finally(() => {
          this.refreshing = null;
        });
      }
      return this.cached.snapshot;
    }

    // No cache or stale-while-revalidate disabled — must fetch.
    if (this.refreshing) {
      return this.refreshing;
    }

    this.refreshing = this.doFetch(authHeader);
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** Clears the cached permissions, forcing a fresh fetch on the next call. */
  clearCache(): void {
    this.cached = null;
  }

  private async doFetch(
    authHeader?: string,
  ): Promise<PermissionSnapshot> {
    const maxRetries = this.config.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = {};
        if (authHeader) {
          headers["Authorization"] = authHeader;
        }

        const response = await this.fetchFn(this.config.permissionsEndpoint, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const safeBody =
            body.length > 200 ? body.slice(0, 200) + "…" : body;
          throw new CsarAuthzError(
            `Permissions endpoint returned ${response.status}: ${safeBody}`,
            "PERMISSIONS_FETCH_FAILED",
          );
        }

        const data = (await response.json()) as PermissionsApiResponse;

        if (typeof data.subject !== "string") {
          throw new CsarAuthzError(
            "Permissions endpoint returned invalid data (missing subject)",
            "PERMISSIONS_PARSE_ERROR",
          );
        }

        const snapshot = new PermissionSnapshot(data);
        this.cached = { snapshot, fetchedAt: Date.now() };
        return snapshot;
      } catch (err) {
        lastError = err as Error;
        this.log.auth?.(
          `Permissions fetch failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`,
        );

        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
          await sleep(backoffMs);
        }
      }
    }

    // If we have stale data, return it as a fallback.
    if (this.cached) {
      this.log.auth?.(
        "All permission fetch attempts failed, returning stale data",
      );
      return this.cached.snapshot;
    }

    if (lastError instanceof CsarAuthzError) throw lastError;
    throw new CsarAuthzError(
      `Permissions fetch failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
      "PERMISSIONS_FETCH_FAILED",
    );
  }
}

import type { CsarServiceKey, CsarAuthConfig, CachedToken, TokenResponse } from "./types.js";
import type { CsarLogger } from "../logger.js";
import { createAssertion } from "./assertion.js";
import { CsarAuthError } from "./errors.js";
import { sleep } from "../sleep.js";

/** Refresh the token when less than 5 minutes remain. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Manages the lifecycle of STS access tokens:
 * - In-memory caching
 * - Proactive refresh before expiry
 * - Deduplication of concurrent refresh calls
 * - Exponential backoff on STS failures
 */
export class TokenManager {
  private cached: CachedToken | null = null;
  private refreshing: Promise<string> | null = null;

  private readonly key: CsarServiceKey;
  private readonly config: CsarAuthConfig;
  private readonly log: CsarLogger;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    key: CsarServiceKey,
    config: CsarAuthConfig,
    log: CsarLogger,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.key = key;
    this.config = config;
    this.log = log;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Returns a valid access token.
   * Serves from cache when possible, otherwise refreshes.
   */
  async getAccessToken(): Promise<string> {
    if (
      this.cached &&
      Date.now() < this.cached.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.cached.accessToken;
    }

    // Deduplicate concurrent refresh calls
    if (this.refreshing) {
      return this.refreshing;
    }

    this.refreshing = this.refresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** Clears the cached token, forcing a refresh on the next call. */
  clearCache(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const audience = this.config.audience ?? this.config.stsEndpoint;
    const maxRetries = this.config.maxStsRetries ?? 2;

    this.log.auth?.("Token expired or missing, exchanging new assertion…");

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const assertion = await createAssertion(this.key, audience);

        const response = await this.fetchFn(this.config.stsEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }).toString(),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          // Truncate to avoid leaking sensitive server details in error messages
          const safeBody = body.length > 200 ? body.slice(0, 200) + "…" : body;
          throw new CsarAuthError(
            `STS returned ${response.status}: ${safeBody}`,
            "STS_EXCHANGE_FAILED",
          );
        }

        const data = (await response.json()) as Record<string, unknown>;

        if (
          typeof data.access_token !== "string" ||
          !data.access_token ||
          typeof data.expires_in !== "number" ||
          !isFinite(data.expires_in) ||
          data.expires_in <= 0
        ) {
          throw new CsarAuthError(
            "STS returned an invalid token response (missing access_token or expires_in)",
            "STS_EXCHANGE_FAILED",
          );
        }

        this.cached = {
          accessToken: data.access_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };

        return data.access_token;
      } catch (err) {
        lastError = err as Error;
        this.cached = null;

        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
          this.log.auth?.(
            `STS exchange failed, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(backoffMs);
        }
      }
    }

    if (lastError instanceof CsarAuthError) throw lastError;
    throw new CsarAuthError(
      `STS token exchange failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
      "STS_EXCHANGE_FAILED",
    );
  }
}

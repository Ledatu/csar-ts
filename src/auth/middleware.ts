import type { FetchMiddleware } from "../pipeline.js";
import type { TokenManager } from "./token-manager.js";
import type { CsarLogger } from "../logger.js";
import { CSAR_HEADER_AUTHORIZATION } from "../constants.js";

/**
 * Creates a fetch middleware that injects
 * `X-Csar-Authorization: Bearer <token>`.
 *
 * Any caller-supplied `Authorization` header is left untouched — the router
 * proxies it to the upstream, so the two credentials must not collide.
 *
 * On 401 responses the token cache is cleared, a fresh token is obtained,
 * and the request is retried exactly once to prevent infinite loops.
 */
export function createAuthMiddleware(
  tokenManager: TokenManager,
  log: CsarLogger,
): FetchMiddleware {
  return async (input, init, next) => {
    const token = await tokenManager.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set(CSAR_HEADER_AUTHORIZATION, `Bearer ${token}`);

    const response = await next(input, { ...init, headers });

    if (response.status === 401) {
      log.auth?.("Received 401, refreshing token and retrying…");
      tokenManager.clearCache();
      const freshToken = await tokenManager.getAccessToken();
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set(CSAR_HEADER_AUTHORIZATION, `Bearer ${freshToken}`);
      return next(input, { ...init, headers: retryHeaders });
    }

    return response;
  };
}

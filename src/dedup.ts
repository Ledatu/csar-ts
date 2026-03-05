/**
 * Request deduplication / collapsing for identical in-flight GET requests.
 *
 * If a GET request to the same URL + params is already in flight,
 * new callers subscribe to the existing Promise instead of creating
 * a new network request.
 */
export class RequestDeduplicator {
  private readonly inflight = new Map<string, Promise<Response>>();

  /**
   * Generates a dedup key from the request URL.
   * Normalises query parameters by sorting them alphabetically.
   */
  static key(url: string): string {
    try {
      const u = new URL(url);
      u.searchParams.sort();
      return `GET:${u.origin}${u.pathname}?${u.searchParams.toString()}`;
    } catch {
      return `GET:${url}`;
    }
  }

  /**
   * Wraps a fetch call with deduplication.
   *
   * - Only collapses GET requests.
   * - If a matching request is already in-flight, returns the same Promise.
   * - The response is cloned for each subscriber so that body streams
   *   remain independently consumable.
   *
   * @param url  The request URL.
   * @param method  The HTTP method (only `"GET"` is deduplicated).
   * @param executeFn  A function that performs the actual fetch.
   * @returns The response.
   */
  async execute(
    url: string,
    method: string,
    executeFn: () => Promise<Response>,
  ): Promise<Response> {
    // Only collapse GET requests
    if (method.toUpperCase() !== "GET") {
      return executeFn();
    }

    const dedupKey = RequestDeduplicator.key(url);

    const existing = this.inflight.get(dedupKey);
    if (existing) {
      // Clone so each consumer gets their own readable body stream
      const res = await existing;
      return res.clone();
    }

    const promise = executeFn().then(
      (res) => {
        // Keep a cloned copy so the original can still be returned
        // and subsequent subscribers get independent clones.
        return res;
      },
      (err) => {
        this.inflight.delete(dedupKey);
        throw err;
      },
    );

    this.inflight.set(dedupKey, promise);

    try {
      const response = await promise;
      this.inflight.delete(dedupKey);
      // Return a clone — the stored promise already resolved with the original
      return response.clone();
    } catch (err) {
      this.inflight.delete(dedupKey);
      throw err;
    }
  }

  /** Number of currently in-flight deduplicated requests. */
  get size(): number {
    return this.inflight.size;
  }
}

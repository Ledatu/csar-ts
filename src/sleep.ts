/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * If an `AbortSignal` is provided and it aborts during the wait,
 * the promise rejects immediately with `DOMException('Aborted')`
 * and the internal timer is cleared (no memory leak).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Already aborted — bail out immediately
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }

    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

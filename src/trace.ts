/**
 * Generates a random hex string of the given byte length.
 */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(arr);
  } else {
    // Fallback for environments without Web Crypto
    for (let i = 0; i < bytes; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a unique request/trace ID (32 hex chars).
 */
export function generateRequestId(): string {
  return randomHex(16);
}

/**
 * Generates a W3C `traceparent` header value.
 * Format: `00-<trace-id>-<parent-id>-01`
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
export function generateTraceparent(): { traceId: string; traceparent: string } {
  const traceId = randomHex(16);
  const parentId = randomHex(8);
  return {
    traceId,
    traceparent: `00-${traceId}-${parentId}-01`,
  };
}

import {
  CSAR_HEADER_STATUS,
  CSAR_HEADER_WAIT_MS,
  CSAR_HEADER_RETRY_AFTER,
  CSAR_STATUS_THROTTLED,
  CSAR_STATUS_CIRCUIT_OPEN,
  CSAR_STATUS_CIRCUIT_HALF_OPEN,
} from "./constants.js";
import type { HeadersLike } from "./types.js";

// ── Header access helper ──────────────────────────────────────────────

/**
 * Reads a single header value from any header-like object
 * (plain object, `Headers`, Axios headers, etc.).
 */
export function getHeader(headers: HeadersLike, name: string): string | null {
  if (!headers) return null;

  // Standard Headers / Axios headers — has `.get()`
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(name);
    return val ?? null;
  }

  // Plain record — try exact case then case-insensitive
  const rec = headers as Record<string, string | string[] | undefined>;
  const lowerName = name.toLowerCase();

  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === lowerName) {
      const v = rec[key];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    }
  }

  return null;
}

// ── Status extractor ──────────────────────────────────────────────────

const KNOWN_STATUSES = new Set([
  CSAR_STATUS_THROTTLED,
  CSAR_STATUS_CIRCUIT_OPEN,
  CSAR_STATUS_CIRCUIT_HALF_OPEN,
]);

/**
 * Reads the `X-CSAR-Status` response header.
 * Returns one of the known status strings or `null`.
 */
export function extractCsarStatus(headers: HeadersLike): string | null {
  const raw = getHeader(headers, CSAR_HEADER_STATUS);
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  return KNOWN_STATUSES.has(trimmed) ? trimmed : null;
}

// ── Wait-time extractor ───────────────────────────────────────────────

/**
 * Determines how long to wait (in milliseconds) from response headers.
 *
 * Priority:
 *   1. `X-CSAR-Wait-MS` — native csar header, value in ms.
 *   2. `Retry-After`    — RFC 7231, seconds (integer) or HTTP-date.
 *
 * Returns `null` if neither header yields a valid positive number.
 */
export function extractWaitTime(headers: HeadersLike): number | null {
  // Priority 1: X-CSAR-Wait-MS (milliseconds)
  const waitMs = getHeader(headers, CSAR_HEADER_WAIT_MS);
  if (waitMs !== null) {
    const ms = parseInt(waitMs, 10);
    if (!isNaN(ms) && ms > 0) return ms;
  }

  // Priority 2: Retry-After (seconds or HTTP-date)
  const retryAfter = getHeader(headers, CSAR_HEADER_RETRY_AFTER);
  if (retryAfter !== null) {
    return parseRetryAfter(retryAfter);
  }

  return null;
}

/**
 * Parses an RFC 7231 `Retry-After` value.
 * Accepts either:
 *   - An integer number of seconds (e.g. `"120"`)
 *   - An HTTP-date (e.g. `"Fri, 31 Dec 1999 23:59:59 GMT"`)
 *
 * Returns milliseconds to wait, or `null` on parse failure / non-positive result.
 */
function parseRetryAfter(value: string): number | null {
  const trimmed = value.trim();

  // Try integer seconds first
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds) && String(seconds) === trimmed && seconds > 0) {
    return seconds * 1000;
  }

  // Try HTTP-date
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const deltaMs = date.getTime() - Date.now();
    return deltaMs > 0 ? deltaMs : null;
  }

  return null;
}

# csar-ts

> Smart resilience SDK for the [CSAR API Router](https://github.com/ledatu/csar) — transparent backpressure handling, circuit breaking, and request deduplication for Axios and Fetch.

[![npm version](https://img.shields.io/npm/v/csar-ts.svg)](https://www.npmjs.com/package/csar-ts)
[![license](https://img.shields.io/npm/l/csar-ts.svg)](./LICENSE)

---

## What is CSAR?

[CSAR](https://github.com/ledatu/csar) is a high-performance API gateway and router that implements cooperative rate limiting (backpressure). Instead of silently dropping requests, CSAR responds with `503` and tells the client *exactly* how long to wait, so traffic can be absorbed gracefully rather than lost.

This SDK wires up that protocol transparently so your application code never has to think about it.

---

## Features

- **Transparent backpressure** — automatically retries `503` responses with the wait time the router specifies (`X-CSAR-Wait-MS` / `Retry-After`)
- **Server circuit breaker detection** — reads `X-CSAR-Status: circuit_open` and throws immediately instead of retrying
- **Client-side circuit breaker** — tracks consecutive 5xx errors per origin and short-circuits locally before hitting the network
- **Request deduplication** — collapses identical in-flight `GET` requests into a single network call
- **`X-CSAR-Client-Limit` injection** — advertises your client's RPS capacity to the router for proactive shaping
- **OpenTelemetry-compatible tracing** — generates `X-Request-Id` and W3C `traceparent` headers per request
- **Composable middleware pipeline** — clean, testable architecture for the Fetch adapter; same logic reused in Axios interceptors
- **Dual ESM / CJS build** — works in Node.js, Bun, browsers, and edge runtimes
- **Zero required dependencies** — Axios is a peer dep (optional); no other runtime deps

---

## Installation

```bash
# npm
npm install csar-ts

# bun
bun install csar-ts
```

If you use the Axios adapter, install Axios alongside it:

```bash
bun install axios csar-ts
```

---

## Quick Start

### Fetch

```typescript
import { withCsarFetch } from "csar-ts";

const fetch = withCsarFetch(globalThis.fetch, {
  maxWaitMs: 5000,   // give up if router asks to wait more than 5s
  maxRetries: 3,     // retry up to 3 times on 503
  clientLimitRps: 50, // tell the router our max throughput
  debug: true,
});

// Use exactly like the native fetch API — backpressure is handled automatically
const res = await fetch("https://api.example.com/data");
```

### Axios

```typescript
import axios from "axios";
import { applyCsarAxios } from "csar-ts";

const instance = axios.create({ baseURL: "https://api.example.com" });

applyCsarAxios(instance, {
  maxWaitMs: 5000,
  maxRetries: 3,
  clientLimitRps: 50,
  debug: true,
});

// Use instance normally — interceptors handle everything
const { data } = await instance.get("/data");
```

---

## Configuration

```typescript
interface CsarConfig {
  /** Maximum ms the client is willing to wait before throwing. Required. */
  maxWaitMs: number;

  /** Number of retry attempts on 503. Required. */
  maxRetries: number;

  /**
   * Client RPS hint sent as `X-CSAR-Client-Limit` on every request.
   * Allows the router to shape traffic proactively.
   */
  clientLimitRps?: number;

  /** Enable debug logging to console. */
  debug?: boolean;

  /** Client-side circuit breaker settings. */
  circuitBreaker?: {
    /** Consecutive 5xx failures before the local circuit opens. */
    threshold: number;
    /** Ms the circuit stays open before allowing a probe request. */
    resetTimeoutMs: number;
  };

  /**
   * Collapse identical in-flight GET requests into one network call.
   * All callers receive the same response object. Default: false.
   */
  dedup?: boolean;

  /**
   * Generate and inject `X-Request-Id` + W3C `traceparent` on every request.
   * Enables end-to-end tracing from client to upstream service.
   */
  generateTraceId?: boolean;

  /** Called just before each retry sleep. */
  onRetry?: (delayMs: number, attempt: number, error: unknown) => void;
}
```

---

## CSAR Protocol Headers

| Header | Direction | Description |
|---|---|---|
| `X-CSAR-Wait-MS` | Response | Milliseconds the request spent queued in the throttle |
| `X-CSAR-Status` | Response | Machine-readable state: `throttled`, `circuit_open`, `circuit_half_open` |
| `X-CSAR-Client-Limit` | Request | Client's self-reported max RPS capacity |
| `Retry-After` | Response | Standard RFC 7231 fallback (seconds) if `X-CSAR-Wait-MS` is absent |

A `503` response means backpressure. The SDK classifies it by priority:

1. `X-CSAR-Status: circuit_open` / `circuit_half_open` → throw `CsarCircuitBrokenError` immediately
2. `X-CSAR-Status: throttled` → wait `X-CSAR-Wait-MS` ms, then retry
3. No `X-CSAR-Status` header → check `X-CSAR-Wait-MS`, fall back to `Retry-After`, fall back to 1 s
4. Response body contains `"circuit breaker open"` → throw `CsarCircuitBrokenError` (legacy fallback)

---

## Error Handling

```typescript
import { CsarBackpressureError, CsarCircuitBrokenError } from "csar-ts";

try {
  const res = await fetch("https://api.example.com/data");
} catch (err) {
  if (err instanceof CsarCircuitBrokenError) {
    // Source tells you who tripped the circuit
    console.error(`Circuit broken (${err.source}):`, err.message);
    // err.source === "server" — X-CSAR-Status said circuit_open
    // err.source === "client" — local CB tripped after N consecutive 5xx
  }

  if (err instanceof CsarBackpressureError) {
    // maxWaitMs exceeded or maxRetries exhausted
    console.error(
      `Backpressure unabsorbed after ${err.attempt} attempts`,
      `(router requested ${err.requestedWaitMs}ms)`,
    );
  }
}
```

---

## Advanced: Full Config Example

```typescript
import { withCsarFetch, CsarBackpressureError, CsarCircuitBrokenError } from "csar-ts";

const fetch = withCsarFetch(globalThis.fetch, {
  maxWaitMs: 8000,
  maxRetries: 5,
  clientLimitRps: 100,
  debug: process.env.NODE_ENV !== "production",

  // Client-side circuit breaker — trips after 3 consecutive 5xx per origin
  circuitBreaker: {
    threshold: 3,
    resetTimeoutMs: 30_000, // try again after 30s
  },

  // Collapse duplicate in-flight GETs (great for dashboard polling)
  dedup: true,

  // Inject X-Request-Id + traceparent for distributed tracing
  generateTraceId: true,

  // Log every retry to your monitoring pipeline
  onRetry: (delayMs, attempt, error) => {
    console.warn(`[csar] retry #${attempt} in ${delayMs}ms`, error);
  },
});
```

---

## Advanced: Custom Middleware Pipeline

The Fetch adapter is built on a composable middleware system you can extend:

```typescript
import {
  composeFetchPipeline,
  createHeadersMiddleware,
  createCircuitBreakerMiddleware,
  createDedupMiddleware,
  createRetryMiddleware,
  createLogger,
  type FetchMiddleware,
  type CsarConfig,
} from "csar-ts";

const config: CsarConfig = { maxWaitMs: 5000, maxRetries: 3 };
const log = createLogger(true);

// Add your own middleware
const authMiddleware: FetchMiddleware = (input, init, next) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${getToken()}`);
  return next(input, { ...init, headers });
};

const fetch = composeFetchPipeline(
  [
    createHeadersMiddleware(config),
    authMiddleware,                          // ← your custom step
    createDedupMiddleware(config, log),
    createCircuitBreakerMiddleware(config, log),
    createRetryMiddleware(config, log),
  ],
  globalThis.fetch,
);
```

---

## How It Fits Together

```
Your App
   │
   ▼
withCsarFetch / applyCsarAxios
   │
   ├── Headers middleware   (X-CSAR-Client-Limit, X-Request-Id, traceparent)
   ├── Dedup middleware     (collapse identical in-flight GETs)
   ├── Client CB middleware (pre-flight check, post-response tracking)
   └── Retry middleware     (503 → classify → wait → retry)
                                 │
                                 ▼
                    CSAR API Gateway  (github.com/ledatu/csar)
                                 │
                                 ▼
                           Your upstream
```

---

## Building & Testing

```bash
# Build ESM + CJS + .d.ts
npm run build

# Run tests (74 tests, vitest)
npm test

# Type-check only
npm run lint
```

---

## Related

- **[ledatu/csar](https://github.com/ledatu/csar)** — router source code

---

## License

MIT

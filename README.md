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
- **Built-in STS authentication** — loads service keys, signs JWT assertions, exchanges them for access tokens, injects them as `X-Csar-Authorization`, and retries once on `401`
- **High-level CSAR client** — `createCsarClient()` gives you a base-URL-aware client with resilience and auth built in
- **Composable middleware pipeline** — clean, testable architecture for the Fetch adapter; same logic reused in Axios interceptors
- **Async auth-ready adapters** — `withCsarFetchAsync()` and `applyCsarAxiosAsync()` enable auth-aware setup
- **Dual ESM / CJS build** — works in Node.js, Bun, browsers, and edge runtimes
- **Minimal runtime dependencies** — Axios stays an optional peer dep; `jose` powers JWT signing for STS auth

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

### Fetch + STS Auth

```typescript
import { withCsarFetchAsync } from "csar-ts";

const fetch = await withCsarFetchAsync(globalThis.fetch, {
  maxWaitMs: 5000,
  maxRetries: 3,
  auth: {
    stsEndpoint: "https://auth.example.com/sts/token",
    keyFile: "./authorized_key.json",
    accessTokenAudience: "orders-service",
  },
});

const res = await fetch("https://api.example.com/orders");
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

### Axios + STS Auth

```typescript
import axios from "axios";
import { applyCsarAxiosAsync } from "csar-ts";

const instance = axios.create({ baseURL: "https://api.example.com" });

await applyCsarAxiosAsync(instance, {
  maxWaitMs: 5000,
  maxRetries: 3,
  auth: {
    stsEndpoint: "https://auth.example.com/sts/token",
    keyData: serviceKey,
  },
});

const { data } = await instance.get("/orders");
```

### High-Level Client

```typescript
import { createCsarClient } from "csar-ts";

const client = await createCsarClient({
  baseUrl: "https://api.example.com",
  maxWaitMs: 5000,
  maxRetries: 3,
  auth: {
    stsEndpoint: "https://auth.example.com/sts/token",
    keyFile: "./authorized_key.json",
  },
});

const res = await client.get("/v1/data");
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

  /**
   * Optional STS authentication.
   * When provided, async adapters and `createCsarClient()` automatically
   * obtain access tokens and inject them as `X-Csar-Authorization: Bearer …`.
   */
  auth?: {
    /** URL of the Security Token Service endpoint. */
    stsEndpoint: string;
    /** Path to `authorized_key.json` (Node.js only). */
    keyFile?: string;
    /** In-memory key object for edge/browser/server runtimes. */
    keyData?: CsarServiceKey;
    /** Audience for the JWT assertion. Defaults to `stsEndpoint`. */
    stsAudience?: string;
    /** Audience for the requested access token (sent as form field to STS). */
    accessTokenAudience?: string;
    /** @deprecated Use `stsAudience` instead. */
    audience?: string;
    /** Retry count for failed token exchanges. Default: 2. */
    maxStsRetries?: number;
  };

  /** Called just before each retry sleep. */
  onRetry?: (delayMs: number, attempt: number, error: unknown) => void;
}
```

`auth.keyFile` is Node.js-only. In browsers, edge runtimes, or any environment where reading from disk is unavailable, pass `auth.keyData` instead.

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
import {
  CsarBackpressureError,
  CsarCircuitBrokenError,
  CsarAuthError,
} from "csar-ts";

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

  if (err instanceof CsarAuthError) {
    console.error(`Auth failed [${err.code}]`, err.message);
  }
}
```

---

## Authentication Flow

When `auth` is configured, the SDK:

1. Loads and validates the service key from `keyFile` or `keyData`
2. Signs a short-lived JWT assertion using `EdDSA` or `RS256`
3. Exchanges that assertion with the CSAR STS for an access token
4. Caches the token in memory and refreshes it before expiry
5. Injects it as `X-Csar-Authorization: Bearer <token>` on every request
6. Retries once on `401` after forcing a token refresh

### Why `X-Csar-Authorization` and not `Authorization`

The access token authenticates the *hop to the CSAR router*, not the upstream
service. On routes without a credential-injection profile the router proxies
`Authorization` through to the upstream verbatim, so the two must not share a
header — that separation is what lets a service pass its own third-party
credential (a marketplace API key, say) through the router while still
authenticating itself to CSAR. The router strips `X-Csar-Authorization` before
proxying, so the internal token never reaches an upstream.

The SDK therefore never touches `Authorization`; anything you set there is
forwarded untouched. This matches `csar-core/stsclient` on the Go side.

---

## Advanced: Full Config Example

```typescript
import {
  withCsarFetchAsync,
  CsarBackpressureError,
  CsarCircuitBrokenError,
} from "csar-ts";

const fetch = await withCsarFetchAsync(globalThis.fetch, {
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

  // Obtain Bearer tokens from the CSAR STS
  auth: {
    stsEndpoint: "https://auth.example.com/sts/token",
    keyFile: "./authorized_key.json",
    accessTokenAudience: "payments-service",
    maxStsRetries: 2,
  },

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

// Add your own middleware. `Authorization` here is the credential the router
// proxies to the upstream — CSAR's own token lives in `X-Csar-Authorization`
// and is handled by the built-in auth middleware.
const upstreamCredentialMiddleware: FetchMiddleware = (input, init, next) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${getUpstreamApiKey()}`);
  return next(input, { ...init, headers });
};

const fetch = composeFetchPipeline(
  [
    createHeadersMiddleware(config),
    upstreamCredentialMiddleware,            // ← your custom step
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

# Run tests
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

## Node HTTP maintenance (`csar-ts/server-drain`)

The isolated `server-drain` entry is for Node HTTP/HTTPS servers (Node18.2+).
The existing browser entry does not statically link the server helper or its
Node built-ins; its existing lazy Node file-key loader remains unchanged. Express4
applications can instrument their public registration methods without reading
Express's internal router stack:

```typescript
import { createServerDrain } from "csar-ts/server-drain";

const drain = createServerDrain({ service: "orders" });
app.use(drain.admission); // FIRST: before body parsing, auth, and routes.
drain.instrumentRegistration(app);
const router = drain.instrumentRegistration(express.Router());
router.route("/orders").post(async (req, res) => {
  const order = await saveOrder(req.body);
  void drain.task("order-cache", () => refreshCache(order)).catch(reportError);
  res.json(order);
});
app.use(router);
const server = https.createServer(tlsOptions, app);
const listen = () => new Promise<void>(resolve => server.listen(port, resolve));
drain.attachServer(server, { resume: listen });
await drain.startControl(`/run/orders-drain/worker-${process.pid}.sock`);
await listen(); // A failed control startup must never open the business listener.
```

Create one controller per worker; share that same instance with every nested
Router factory and cache helper. Instrument **every** Router and Route
registration site, including mounted routers. Instrumentation only covers
registrations performed afterward. `handler(fn)` and `handlers(nestedArray)`
are available for explicit registration. Public `.use`, HTTP methods, `.all`,
`.param` and `.route(...).get/...` preserve arrays, parameter callbacks, the
single-argument `app.get(setting)` getter, and error-handler arity4. Install the
admission middleware before instrumentation/other middleware. An unadmitted
wrapped callback refuses to execute. This utility cannot detect omitted router
factories without a reviewed source inventory.

Admission is checked once per request. Previously admitted asynchronous
middleware and downstream handlers can finish during maintenance. Each actual
returned handler promise stays counted after `next()`, response finish, or
client abort. Callback-style middleware remains counted until `next()` or a
successfully finished terminal response **and** its returned promise, if any,
settles. An abort alone cannot settle a deferred callback. A callback that
starts additional work after `next()`/terminal finish must explicitly register
that work; neither Express nor this helper can infer arbitrary detached timers.

`task(label, factory)` counts work from launch to settlement. Pass a static,
non-secret label and a factory, never an already-running promise. New background
factories are refused before invocation during maintenance. Tasks belonging to
still-active admitted handlers/tasks can continue; stale async contexts cannot
start new work after that request's handlers/tasks/transports all settle.
Handle rejected task promises. The helper neither cancels business work nor
changes marketplace, database, or AMQP delivery semantics.

`drain(epoch, timeoutMs)` closes admission before calling each original
server's `close()` and `closeIdleConnections()`. It reports complete only when
all listeners have closed and all request, handler, and task counts are zero.
Timeouts (1–300000ms) leave maintenance active and work running. They never kill
processes or automatically resume. An explicit `resume(epoch)` requires the
same settled epoch and invokes the supplied original listener callbacks;
listener failure keeps maintenance active. A failed partial resume needs
operator inspection. No signal handlers or process exits are installed.

The control directory must already exist, belong to the current effective UID,
and have mode0700 with no symlink ancestors. Each exclusive Unix socket is
mode0600; existing sockets/files are refused and never deleted as stale evidence.
In PM2 cluster mode `exclusive:true` keeps the control listener in its worker,
so Linux `SO_PEERCRED` identifies the worker rather than the PM2 daemon. Send one
newline-terminated JSON command (maximum4096bytes):

```json
{"v":1,"command":"status"}
{"v":1,"command":"drain","epoch":"migration-window-0001","timeout_ms":30000}
{"v":1,"command":"resume","epoch":"migration-window-0001"}
```

Status returns `v`, `service`, actual `pid`, `uid`, `linux_start_ticks` (decimal
string, null off Linux), actual `entry_sha256`, numeric Unix `observed_at`,
`epoch`, `phase`, `admission_closed`, `active_requests`, `active_handlers`,
`active_tasks`, `servers[{listening,closed,error}]`, `failures`, `epoch_failures`,
`rejections`, `epoch_rejections`, and `counters_saturated`. PM2's `pm_exec_path`
selects its loaded entry; ordinary processes use `argv[1]`. A production observer
must independently match that path/hash to the running PM2 process, Linux
PID/start ticks and Unix peer UID/PID. This helper does not accept a claimed
identity, hash, idle state, or success flag from control clients.

Failure counts include returned handler rejection/throw/`next(error)`, rejected
tasks, and completed HTTP5xx responses. Epoch counts baseline historical errors
at the start of maintenance; rejection counts distinguish refused admission and
new background factories. Counters saturate at2147483647 and expose saturation.
A safe migration observer refuses new epoch failures or saturated counters until
reviewed. A drained state proves **quiescence**, not successful or consistent WB
side effects. Swallowed errors, semantic response failures, preexisting ordinary
AMQP channel guarantees, and unknown external outcomes require their own review.

The first deployment into an uninstrumented worker is a separate operational
gate: zero sockets or a normal rolling restart cannot prove a client-aborted
handler's external mutation completed. Keep exact old bundles and resolve that
ambiguity before restarting old workers. Installing this library is not a
cutover, admission-fence, process-restart, or writer-fence authorization.


Package checks run with `npm run lint`, `npm test`, `npm run build`, then
`npm pack --ignore-scripts --pack-destination <artifact-dir>` and
`npm run check:package -- <artifact-dir>/csar-ts-2.1.0.tgz`. The workflow also
runs `tests/server/native-drill.py` in pinned Node18.20.4 (production runtime)
and Node20.19.5 Linux images, using
real PM2 cluster6.0.14 workers, the actual packed helper, TLS and kernel Unix
peer credentials. Docker Desktop fixtures must put Unix sockets on a native
Linux volume/container filesystem rather than a Mac bind mount. Only the
non-secret proof and public package/checksum are CI artifacts.

Publication remains manual: merge reviewed source, attach the tested package
and SHA256SUMS to its GitHub release using ghCLI, and have consumers pin both
asset and checksum. No npm-registry credentials or production deployment are
part of this workflow.

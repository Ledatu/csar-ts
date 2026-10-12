/** Node-only HTTP admission and asynchronous business-work drain. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, chmodSync } from "node:fs";
import { Server as NetServer, createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { METHODS, IncomingMessage, ServerResponse } from "node:http";

export type Next = (error?: unknown) => void;
// Express callbacks have several public overloads, including param callbacks.
// Preserve their original inferred type rather than imposing an Express version.
type Callback = (...args: any[]) => unknown;
type ServerLike = {
  readonly listening: boolean;
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
};
type RequestWork = { transportDone: boolean; handlers: number; tasks: number };
type BoundServer = { server: ServerLike; resume: () => Promise<void>; closed: boolean; error: boolean };
export type DrainStatus = {
  v: 1;
  service: string;
  pid: number;
  uid: number | null;
  linux_start_ticks: string | null;
  entry_sha256: string;
  observed_at: number;
  epoch: string | null;
  phase: "serving" | "draining" | "drained";
  admission_closed: boolean;
  active_requests: number;
  active_handlers: number;
  active_tasks: number;
  servers: { listening: boolean; closed: boolean; error: boolean }[];
  failures: { handler: number; task: number; response_5xx: number };
  epoch_failures: { handler: number; task: number; response_5xx: number } | null;
  rejections: { admission: number; background: number };
  epoch_rejections: { admission: number; background: number } | null;
  counters_saturated: boolean;
};
export type DrainResult = { complete: boolean; status: DrainStatus };

function processIdentity() {
  // PM2 loads the app through ProcessContainer; argv[1] can name that loader.
  // Its source-owned pm_exec_path is independently checked by the operator observer.
  const entry = process.env.pm_exec_path || process.argv[1];
  if (!entry) throw new Error("A file-backed process entry is required");
  let ticks: string | null = null;
  if (process.platform === "linux") {
    const stat = readFileSync("/proc/self/stat", "utf8");
    ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    if (!/^\d+$/.test(ticks)) throw new Error("Process start identity unavailable");
  }
  return {
    pid: process.pid,
    uid: process.geteuid?.() ?? null,
    linux_start_ticks: ticks,
    entry_sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
  };
}

function parseCommand(input: string): Record<string, unknown> {
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object command required");
  const keys = new Set<string>();
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\"") {
      let end = i + 1;
      while (end < input.length) {
        if (input[end] === "\\") { end += 2; continue; }
        if (input[end] === "\"") break;
        end++;
      }
      const token = input.slice(i, end + 1);
      let next = end + 1;
      while (/\s/.test(input[next] ?? "") && next < input.length) next++;
      if (depth === 1 && input[next] === ":") {
        const key: string = JSON.parse(token);
        if (keys.has(key)) throw new Error("Duplicate command key");
        keys.add(key);
      }
      i = end;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return value as Record<string, unknown>;
}

function validEpoch(epoch: string) {
  if (typeof epoch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(epoch)) throw new Error("Invalid maintenance epoch");
}

/** Each worker must create its own controller and exclusive Unix control socket. */
export function createServerDrain(options: { service: string }) {
  if (typeof options.service !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(options.service)) throw new Error("Invalid service name");
  const identity = processIdentity();
  const work = new WeakMap<IncomingMessage, RequestWork>();
  const context = new AsyncLocalStorage<RequestWork>();
  const wrappers = new WeakMap<Callback, { regular?: Callback; parameter?: Callback }>();
  const registrations = new WeakSet<object>();
  const servers: BoundServer[] = [];
  let closed = false;
  let epoch: string | null = null;
  let requests = 0;
  let handlers = 0;
  let tasks = 0;
  let control: NetServer | undefined;
  let resuming = false;
  const failures = { handler: 0, task: 0, response_5xx: 0 };
  const rejections = { admission: 0, background: 0 };
  let failureBaseline = { ...failures };
  let rejectionBaseline = { ...rejections };
  let saturated = false;
  function increment(counts: Record<string, number>, key: string) {
    if (counts[key] >= 2_147_483_647) saturated = true;
    else counts[key]++;
  }

  function status(): DrainStatus {
    const settled = closed && servers.length > 0 && servers.every(s => s.closed && !s.server.listening && !s.error)
      && requests === 0 && handlers === 0 && tasks === 0;
    return {
      v: 1, service: options.service, ...identity, observed_at: Date.now() / 1000, epoch,
      phase: closed ? (settled ? "drained" : "draining") : "serving",
      admission_closed: closed, active_requests: requests, active_handlers: handlers, active_tasks: tasks,
      servers: servers.map(s => ({ listening: s.server.listening, closed: s.closed, error: s.error })),
      failures: { ...failures },
      epoch_failures: epoch === null ? null : { handler: failures.handler - failureBaseline.handler, task: failures.task - failureBaseline.task, response_5xx: failures.response_5xx - failureBaseline.response_5xx },
      rejections: { ...rejections },
      epoch_rejections: epoch === null ? null : { admission: rejections.admission - rejectionBaseline.admission, background: rejections.background - rejectionBaseline.background },
      counters_saturated: saturated,
    };
  }

  /** Install first, before body parsers, auth, routes, and registration wrappers. */
  function admission(req: IncomingMessage, res: ServerResponse, next: Next) {
    if (work.has(req)) { next(); return; } // Accepted nested continuations keep their admission.
    if (closed) {
      increment(rejections, "admission");
      res.statusCode = 503;
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "5");
      res.end("Service maintenance\n");
      return;
    }
    const token: RequestWork = { transportDone: false, handlers: 0, tasks: 0 };
    work.set(req, token);
    requests++;
    const transportDone = () => {
      if (token.transportDone) return;
      token.transportDone = true;
      requests--;
      res.removeListener("finish", transportDone);
      res.removeListener("close", transportDone);
    };
    res.once("finish", () => { if (res.statusCode >= 500) increment(failures, "response_5xx"); });
    res.once("finish", transportDone);
    res.once("close", transportDone);
    context.run(token, next);
  }

  /** Track the callback's actual returned promise and deferred next independently. */
  function handler<T extends Callback>(original: T, parameter = false): T {
    if (original === admission) return original;
    const slot = parameter ? "parameter" : "regular";
    const existing = wrappers.get(original)?.[slot];
    if (existing) return existing as T;
    function invoke(args: any[], isError: boolean) {
      const req: IncomingMessage = args[isError ? 1 : 0];
      const res: ServerResponse = args[isError ? 2 : 1];
      const nextIndex = isError ? 3 : 2;
      const next: Next = args[nextIndex];
      const token = work.get(req);
      if (!token) { next(new Error("Server drain admission middleware is missing")); return; }
      handlers++; token.handlers++;
      let returned = false;
      let promiseDone = false;
      let callbackDone = original.length < 3;
      let done = false;
      const finish = () => {
        if (done || !returned || !promiseDone || !callbackDone) return;
        done = true;
        res.removeListener("finish", terminalFinish);
        handlers--; token.handlers--;
      };
      const terminalFinish = () => { callbackDone = true; finish(); };
      // A callback-style terminal response completes its callback protocol.
      // A client abort does not: a future deferred next() can still run business work.
      if (!callbackDone) res.once("finish", terminalFinish);
      args[nextIndex] = (error?: unknown) => {
        if (error && error !== "route" && error !== "router") increment(failures, "handler");
        callbackDone = true;
        try { context.run(token, () => next(error)); } finally { finish(); }
      };
      try {
        const result = context.run(token, () => original(...args));
        returned = true;
        if (res.writableFinished) callbackDone = true;
        // Assimilate thenables before completion; next() may have run synchronously.
        if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
          Promise.resolve(result).then(
            () => { promiseDone = true; finish(); },
            error => { increment(failures, "handler"); promiseDone = true; callbackDone = true; try { next(error); } finally { finish(); } },
          );
        } else { promiseDone = true; finish(); }
      } catch (error) {
        increment(failures, "handler");
        returned = true; promiseDone = true; callbackDone = true;
        try { next(error); } finally { finish(); }
      }
    }
    const wrapped: Callback = !parameter && original.length === 4
      ? function (error, req, res, next) { invoke([error, req, res, next], true); }
      : function (req, res, next, ...extra) { invoke([req, res, next, ...extra], false); };
    wrappers.set(original, { ...wrappers.get(original), [slot]: wrapped });
    wrappers.set(wrapped, { regular: wrapped, parameter: wrapped });
    return wrapped as T;
  }

  /** Preserve Express's nested handler arrays and non-handler path arguments. */
  function handlersOf<T>(value: T, parameter = false): T {
    if (Array.isArray(value)) return value.map(v => handlersOf(v, parameter)) as T;
    return (typeof value === "function" ? handler(value as Callback, parameter) : value) as T;
  }

  /** Instrument only documented registration methods; call for every Router factory. */
  function instrumentRegistration<T extends object>(router: T): T {
    if (registrations.has(router)) return router;
    registrations.add(router);
    const target = router as Record<string, unknown>;
    for (const method of new Set([...METHODS.map(m => m.toLowerCase()), "all", "use", "param"])) {
      const original = target[method];
      if (typeof original !== "function") continue;
      target[method] = function (this: unknown, ...args: unknown[]) {
        // app.get(setting) is a getter, not a route registration.
        if (method === "get" && args.length === 1 && typeof args[0] === "string") return original.apply(this, args);
        return original.apply(this, args.map(v => handlersOf(v, method === "param")));
      };
    }
    const route = target.route;
    if (typeof route === "function") target.route = function (this: unknown, ...args: unknown[]) {
      return instrumentRegistration(route.apply(this, args));
    };
    return router;
  }

  /** Start work only inside this factory; never pass an already-running promise. */
  function task<T>(label: string, factory: () => T | PromiseLike<T>): Promise<Awaited<T>> {
    if (typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(label)) return Promise.reject(new Error("Invalid task label"));
    const token = context.getStore();
    if (closed && (!token || (token.transportDone && token.handlers === 0 && token.tasks === 0))) {
      increment(rejections, "background");
      return Promise.reject(new Error("New background work refused during maintenance"));
    }
    tasks++; if (token) token.tasks++;
    let result: T | PromiseLike<T>;
    try { result = factory(); } catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).catch(error => { increment(failures, "task"); throw error; })
      .finally(() => { tasks--; if (token) token.tasks--; }) as Promise<Awaited<T>>;
  }

  function attachServer(server: ServerLike, settings: { resume: () => Promise<void> }) {
    if (closed || servers.some(s => s.server === server)) throw new Error("Cannot attach this server");
    servers.push({ server, resume: settings.resume, closed: false, error: false });
  }

  async function drain(nextEpoch: string, timeoutMs: number): Promise<DrainResult> {
    validEpoch(nextEpoch);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Invalid drain timeout");
    if (!servers.length) throw new Error("No HTTP server attached");
    if (closed && epoch !== nextEpoch) throw new Error("A different maintenance epoch is active");
    if (!closed) {
      if (servers.some(bound => !bound.server.listening)) throw new Error("All original listeners must be ready before first drain");
      failureBaseline = { ...failures }; rejectionBaseline = { ...rejections };
      closed = true; epoch = nextEpoch;
      for (const bound of servers) {
        try {
          bound.server.close(error => {
            bound.error = Boolean(error); bound.closed = !error;
          });
          bound.server.closeIdleConnections?.();
        } catch { bound.error = true; }
      }
    }
    const deadline = performance.now() + timeoutMs;
    while (status().phase !== "drained" && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))));
    }
    const snapshot = status();
    return { complete: snapshot.phase === "drained", status: snapshot };
  }

  async function resume(expectedEpoch: string): Promise<DrainStatus> {
    validEpoch(expectedEpoch);
    if (resuming || !closed || epoch !== expectedEpoch || status().phase !== "drained") throw new Error("Only a settled matching epoch may resume");
    // Retain maintenance admission until every original listener is restored.
    resuming = true;
    try {
      for (const bound of servers) {
        await bound.resume();
        if (!bound.server.listening) throw new Error("Server resume did not restore its listener");
        bound.closed = false;
      }
      closed = false;
      return status();
    } finally { resuming = false; }
  }

  async function startControl(socketPath: string): Promise<void> {
    if (control || !socketPath.startsWith("/") || resolve(socketPath) !== socketPath) throw new Error("Invalid exclusive control path");
    const directory = dirname(socketPath);
    const meta = lstatSync(directory);
    if (!meta.isDirectory() || meta.isSymbolicLink() || meta.uid !== identity.uid || (meta.mode & 0o777) !== 0o700) {
      throw new Error("Control directory must be owned and private (0700)");
    }
    for (let p = directory; p !== dirname(p); p = dirname(p)) {
      if (lstatSync(p).isSymbolicLink()) throw new Error("Symlinked control ancestor refused");
    }
    const listener = createNetServer(socket => {
      socket.setTimeout(5000, () => socket.destroy());
      let bytes = 0;
      let input = "";
      let answered = false;
      socket.on("data", async chunk => {
        if (answered) { socket.destroy(); return; }
        bytes += chunk.length;
        if (bytes > 4096) { socket.destroy(); return; }
        input += chunk.toString("utf8");
        if (!input.includes("\n")) return;
        answered = true;
        try {
          if (!input.endsWith("\n") || input.indexOf("\n") !== input.length - 1) throw new Error("One bounded command required");
          const command = parseCommand(input.trim());
          if (command.v !== 1) throw new Error("Unsupported protocol");
          let result: DrainStatus | DrainResult;
          if (command.command === "status" && Object.keys(command).sort().join() === "command,v") result = status();
          else if (command.command === "drain" && Object.keys(command).sort().join() === "command,epoch,timeout_ms,v") {
            socket.setTimeout(Math.min(305_000, Number(command.timeout_ms) + 5000), () => socket.destroy());
            result = await drain(command.epoch as string, command.timeout_ms as number);
          } else if (command.command === "resume" && Object.keys(command).sort().join() === "command,epoch,v") result = await resume(command.epoch as string);
          else throw new Error("Invalid command");
          socket.end(JSON.stringify(result) + "\n");
        } catch { socket.end(JSON.stringify({ v: 1, error: "Control command refused" }) + "\n"); }
      });
      socket.on("error", () => { /* The command never controls business work by disconnecting. */ });
    });
    await new Promise<void>((ok, fail) => {
      listener.once("error", fail);
      listener.listen({ path: socketPath, exclusive: true }, () => {
        try { chmodSync(socketPath, 0o600); } catch (error) { listener.close(); fail(error); return; }
        listener.removeListener("error", fail); ok();
      });
    });
    control = listener;
  }

  async function closeControl(): Promise<void> {
    if (!control) return;
    const listener = control;
    await new Promise<void>((ok, fail) => listener.close(error => error ? fail(error) : ok()));
    control = undefined;
  }

  return { admission, handler, handlers: handlersOf, instrumentRegistration, task, attachServer, status, drain, resume, startControl, closeControl };
}
export type ServerDrain = ReturnType<typeof createServerDrain>;

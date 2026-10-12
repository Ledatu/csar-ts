import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createServer, get, Server } from "node:http";
import { createServer as createHttpsServer, get as getHttps } from "node:https";
import { connect } from "node:net";
import { mkdtempSync, chmodSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServerDrain, type ServerDrain } from "../../src/server/drain";
const require = createRequire(import.meta.url);
const express = require("express");
const epoch = "test-window-0001";
const running: { server: Server; drain: ServerDrain }[] = [];
const directories: string[] = [];
let tlsDirectory: string;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}
async function eventually(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= end) throw new Error("Condition did not settle");
    await new Promise(ok => setTimeout(ok, 5));
  }
}
async function fixture(setup: (app: any, drain: ServerDrain) => void, tls = false) {
  const drain = createServerDrain({ service: "test-server" });
  const app = express();
  app.use(drain.admission);
  drain.instrumentRegistration(app);
  setup(app, drain);
  const server = tls ? createHttpsServer({ key: readFileSync(join(tlsDirectory, "key.pem")), cert: readFileSync(join(tlsDirectory, "cert.pem")) }, app) : createServer(app);
  const listen = () => new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  await listen();
  drain.attachServer(server, { resume: listen });
  running.push({ server, drain });
  const address = server.address() as { port: number };
  const request = (path = "/") => new Promise<string>((ok, fail) => {
    const call = tls ? getHttps : get;
    call({ hostname: "127.0.0.1", port: address.port, path, agent: false, rejectUnauthorized: false }, res => {
      let body = ""; res.on("data", data => { body += data; }); res.on("end", () => ok(body));
    }).on("error", fail);
  });
  return { server, drain, request, port: address.port };
}
beforeAll(() => {
  tlsDirectory = mkdtempSync(join(tmpdir(), "csar-drain-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tlsDirectory, "key.pem"), "-out", join(tlsDirectory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
});
afterAll(() => rmSync(tlsDirectory, { recursive: true, force: true }));
afterEach(async () => {
  for (const { server, drain } of running.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(ok => server.close(() => ok()));
    await drain.closeControl();
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("HTTP business work drain", () => {
  it("keeps a returned promise active after response.finish over real TLS", async () => {
    const held = deferred();
    const f = await fixture(app => app.get("/", async (_req: any, res: any) => { res.send("done"); await held.promise; }), true);
    expect(await f.request()).toBe("done");
    expect(f.drain.status().active_requests).toBe(0);
    const first = await f.drain.drain(epoch, 25);
    expect(first.complete).toBe(false);
    expect(first.status.active_handlers).toBe(1);
    expect(first.status.admission_closed).toBe(true);
    held.resolve();
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("does not settle synchronous next() before seeing the returned held promise", async () => {
    const held = deferred();
    const f = await fixture(app => {
      app.use(async (_req: any, _res: any, next: any) => { next(); await held.promise; });
      app.get("/", (_req: any, res: any) => res.end("ok"));
    });
    expect(await f.request()).toBe("ok");
    expect((await f.drain.drain(epoch, 20)).status.active_handlers).toBe(1);
    held.resolve();
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("allows accepted deferred middleware and tasks to finish after admission closes", async () => {
    const entered = deferred(), continueRequest = deferred(), taskHeld = deferred();
    const f = await fixture((app, drain) => {
      app.use(async (_req: any, _res: any, next: any) => { entered.resolve(); await continueRequest.promise; await drain.task("accepted-cache", () => taskHeld.promise); next(); });
      app.get("/", (_req: any, res: any) => res.end("continued"));
    });
    const response = f.request(); await entered.promise;
    const waiting = f.drain.drain(epoch, 40);
    continueRequest.resolve();
    await eventually(() => f.drain.status().active_tasks === 1);
    expect((await waiting).complete).toBe(false);
    taskHeld.resolve(); expect(await response).toBe("continued");
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("client abort cannot complete an outstanding WB-like async handler", async () => {
    const entered = deferred(), wbMutation = deferred();
    const f = await fixture(app => app.post("/", async (_req: any, res: any) => { entered.resolve(); await wbMutation.promise; res.end("done"); }));
    const { request } = await import("node:http");
    const client = request({ host: "127.0.0.1", port: f.port, method: "POST", agent: false });
    client.on("error", () => {}); client.end(); await entered.promise; client.destroy();
    await eventually(() => f.drain.status().active_requests === 0);
    expect((await f.drain.drain(epoch, 25)).status.active_handlers).toBe(1);
    wbMutation.resolve();
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("callback-style deferred next stays incomplete on client abort", async () => {
    const entered = deferred(); let laterNext!: () => void;
    const f = await fixture(app => {
      app.use((_req: any, _res: any, next: any) => { laterNext = next; entered.resolve(); });
      app.get("/", (_req: any, res: any) => res.end("done"));
    });
    const client = get({ host: "127.0.0.1", port: f.port, agent: false });
    client.on("error", () => {}); await entered.promise; client.destroy();
    expect((await f.drain.drain(epoch, 25)).complete).toBe(false);
    laterNext();
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("tracks explicit detached post-response work; new background factories never start", async () => {
    const taskHeld = deferred();
    const f = await fixture((app, drain) => app.get("/", (_req: any, res: any) => { void drain.task("cache-fill", () => taskHeld.promise); res.end("ok"); }));
    expect(await f.request()).toBe("ok");
    expect((await f.drain.drain(epoch, 25)).status.active_tasks).toBe(1);
    const factory = vi.fn(); await expect(f.drain.task("forbidden", factory)).rejects.toThrow("refused");
    expect(factory).not.toHaveBeenCalled(); taskHeld.resolve();
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("preserves nested arrays, nested routers, route methods, params and error arity", async () => {
    const f = await fixture((app, drain) => {
      app.set("custom-setting", "kept"); expect(app.get("custom-setting")).toBe("kept");
      const router = drain.instrumentRegistration(express.Router());
      router.param("id", (_req: any, res: any, next: any, value: string) => { res.locals.value = value; next(); });
      router.route("/:id").get([[(_req: any, _res: any, next: any) => next()]], async (_req: any, res: any) => { throw new Error(res.locals.value); });
      const errorHandler = (_error: Error, _req: any, res: any, _next: any) => res.end("caught");
      expect(drain.handler(errorHandler).length).toBe(4);
      router.use(errorHandler); app.use("/nested", router);
    });
    expect(await f.request("/nested/42")).toBe("caught");
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("timeout never kills work or resumes; explicit same-epoch resume restores original listener", async () => {
    const held = deferred();
    const f = await fixture(app => app.get("/", async (_req: any, res: any) => { res.end("ok"); await held.promise; }));
    await f.request(); expect((await f.drain.drain(epoch, 20)).complete).toBe(false);
    await expect(f.drain.resume(epoch)).rejects.toThrow("settled");
    await expect(f.drain.drain("another-window", 20)).rejects.toThrow("different");
    held.resolve(); expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
    await expect(f.drain.resume("another-window")).rejects.toThrow("matching");
    expect((await f.drain.resume(epoch)).phase).toBe("serving");
    expect((await f.drain.drain("next-window-0002", 1000)).complete).toBe(true);
  });

  it("tracks route().get with a single asynchronous callback", async () => {
    const held = deferred();
    const f = await fixture(app => app.route("/").get(async (_req: any, res: any) => { res.end("ok"); await held.promise; }));
    expect(await f.request()).toBe("ok");
    expect((await f.drain.drain(epoch, 25)).status.active_handlers).toBe(1);
    held.resolve(); expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("keeps streaming transports active after their synchronous handler returns", async () => {
    let end!: () => void;
    const f = await fixture(app => app.get("/", (_req: any, res: any) => { res.write("stream"); end = () => res.end("done"); }));
    const response = f.request(); await eventually(() => Boolean(end));
    expect((await f.drain.drain(epoch, 25)).status.active_requests).toBe(1);
    end(); expect(await response).toBe("streamdone");
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("reports epoch failures separately from historical failures and from quiescence", async () => {
    let rejectTask!: (error: Error) => void;
    const f = await fixture(app => app.get("/", (_req: any, res: any) => res.status(500).end("old failure")));
    await f.request(); expect(f.drain.status().failures.response_5xx).toBe(1);
    const task = f.drain.task("pending-business", () => new Promise((_ok, fail) => { rejectTask = fail; })).catch(() => {});
    expect((await f.drain.drain(epoch, 20)).complete).toBe(false);
    rejectTask(new Error("unspecified failure")); await task;
    const completed = await f.drain.drain(epoch, 1000);
    expect(completed.complete).toBe(true); // Quiescence is not a success/outcome assertion.
    expect(completed.status.epoch_failures).toEqual({ handler: 0, task: 1, response_5xx: 0 });
  });

  it("refuses pipelined requests after maintenance while the admitted request finishes", async () => {
    const entered = deferred(), release = deferred(); let calls = 0;
    const f = await fixture((app, drain) => app.get("/", async (_req: any, res: any) => {
      calls++; void drain.drain(epoch, 20); entered.resolve(); await release.promise; res.end("accepted");
    }));
    const socket = connect(f.port, "127.0.0.1"); let output = "";
    const finished = new Promise<void>((ok, fail) => { socket.on("data", chunk => { output += chunk; }); socket.on("end", ok); socket.on("error", fail); });
    socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    await entered.promise; await eventually(() => f.drain.status().rejections.admission === 1);
    expect(calls).toBe(1); release.resolve(); await finished;
    expect(output).toContain("503"); expect(output).toContain("accepted");
    expect((await f.drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("rejects unadmitted handler execution and refuses missing listener proof", async () => {
    const drain = createServerDrain({ service: "unattached" });
    await expect(drain.drain(epoch, 10)).rejects.toThrow("No HTTP server");
    const handler = vi.fn(), next = vi.fn();
    drain.handler(handler)({} as any, {} as any, next);
    expect(handler).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

function command(path: string, payload: unknown, raw = false) {
  return new Promise<any>((ok, fail) => {
    const socket = connect(path); let result = "";
    socket.on("connect", () => socket.write((raw ? String(payload) : JSON.stringify(payload)) + "\n"));
    socket.on("data", chunk => { result += chunk; });
    socket.on("end", () => { try { ok(JSON.parse(result)); } catch (error) { fail(error); } });
    socket.on("error", fail);
  });
}
describe("exclusive private worker control", () => {
  it("serves actual identity/status and bounded epoch commands on a0600 socket", async () => {
    const f = await fixture(app => app.get("/", (_req: any, res: any) => res.end("ok")));
    const directory = mkdtempSync(join(tmpdir(), "csar-drain-control-")); directories.push(directory); chmodSync(directory, 0o700);
    // macOS /var is a symlink; use its canonical path like a production controller.
    const { realpathSync } = await import("node:fs"); const path = join(realpathSync(directory), "worker.sock");
    await f.drain.startControl(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const initial = await command(path, { v: 1, command: "status" });
    expect(initial.pid).toBe(process.pid); expect(initial.uid).toBe(process.geteuid?.());
    expect(initial.entry_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.observed_at).toBeGreaterThan(Date.now() / 1000 - 5);
    expect(initial.phase).toBe("serving");
    expect((await command(path, { v: 1, command: "drain", epoch, timeout_ms: 1000 })).complete).toBe(true);
    expect((await command(path, { v: 1, command: "status" })).phase).toBe("drained");
    expect((await command(path, { v: 1, command: "resume", epoch })).phase).toBe("serving");
    expect(await command(path, { v: 1, command: "drain", epoch: null, timeout_ms: 1 })).toHaveProperty("error");
    expect(await command(path, { v: 1, command: "status", claimed_idle: true })).toHaveProperty("error");
    expect(await command(path, '{"v":1,"command":"status","command":"status"}', true)).toHaveProperty("error");
    expect(await command(path, '{"v":1,"command":"status","\\u0076":1}', true)).toHaveProperty("error");
  });

  it("refuses early drain before initial listen without changing admission", async () => {
    const drain = createServerDrain({ service: "startup" });
    const server = createServer((_req, res) => res.end("ready"));
    const listen = () => new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
    drain.attachServer(server, { resume: listen }); running.push({ server, drain });
    const directory = mkdtempSync(join(tmpdir(), "csar-drain-startup-")); directories.push(directory); chmodSync(directory, 0o700);
    const { realpathSync } = await import("node:fs"); const path = join(realpathSync(directory), "worker.sock");
    await drain.startControl(path);
    const before = await command(path, { v: 1, command: "status" });
    expect(before.servers[0].listening).toBe(false);
    expect(await command(path, { v: 1, command: "drain", epoch, timeout_ms: 20 })).toHaveProperty("error");
    expect(drain.status().admission_closed).toBe(false); expect(drain.status().epoch).toBeNull();
    await listen(); expect((await drain.drain(epoch, 1000)).complete).toBe(true);
  });

  it("refuses broad directories and existing sockets/files without deleting evidence", async () => {
    const f = await fixture(() => {});
    const directory = mkdtempSync(join(tmpdir(), "csar-drain-broad-")); directories.push(directory);
    const { realpathSync } = await import("node:fs"); const path = join(realpathSync(directory), "worker.sock");
    chmodSync(directory, 0o755); await expect(f.drain.startControl(path)).rejects.toThrow("0700");
    chmodSync(directory, 0o700); writeFileSync(path, "retained");
    await expect(f.drain.startControl(path)).rejects.toThrow(); expect(readFileSync(path, "utf8")).toBe("retained");
  });
});

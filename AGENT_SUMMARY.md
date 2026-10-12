# csar-ts

- Browser/client SDK entry: Axios/Fetch resilience, STS, authorization snapshots;
  optional Axios peer and jose runtime dependency. Existing entry stays separate
  from server utilities and contains no Node server-drain imports.
- Node-only `csar-ts/server-drain`: public Express4 registration wrappers,
  per-request admission, actual returned-promise/callback/task lifetimes,
  explicit maintenance epoch and listener close/resume, exclusive private Unix
  control. No DB/marketplace/AMQP logic, signal exit, forced cancellation or
  automatic resume. One instance per worker shared by all nested routers.
- Operational proof requires reviewed registration/detached-task coverage and
  independent Linux PID/start/socket-peer/source identity. `phase=drained` means
  no pending work; epoch failures/saturation still require review. First rollout
  of instrumentation into old uninstrumented workers is independently gated.
- Build exports dual ESM/CJS with declaration pairs. Run `npm run lint`,
  `npm test`, `npm run build`, package/browser-isolation checks and the real Linux
  PM2/TLS/Unix-peer fixture for server-drain changes. Local Vitest uses actual
  HTTP/TLS/Unix sockets; native acceptance consumes the packed artifact.
- Version2.1.0 adds the isolated subpath without changing existing client APIs.
  Source/release publication follows ghCLI workflow; no automatic npm or
  production rollout is configured here.

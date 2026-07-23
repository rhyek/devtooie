# Control API

> Part of the [devtooie](../README.md) documentation.

While a session runs, devtooie exposes a localhost-only HTTP API — mostly useful
for coding agents (via the [agent skill](../README.md#agent-skill)), but open to any tooling.
Its port is picked at startup and written (with the pid, the session's `logDir`, and the
current `logFile`) to `node_modules/.devtooie/running.json` — read the `port` field there.
`logFile` is kept pointing at the latest file across in-session log rotation. Pin a fixed
port with `apiPort` in `devtooie.config.ts`.

- `GET /query/status` — a single snapshot of the running session:

  ```jsonc
  {
    "pid": 12345,
    "configPath": "/abs/devtooie.config.ts",     // the devtooie.config.* it was started with
    "logFile": "/abs/.../node_modules/.devtooie/logs/1784784120727.log", // current logfile (rotation-aware)
    "packages": { "web": "running", "api": "building" }, // per-package status; null until the build finishes
    "config": { /* … */ }                         // the resolved config; null until the build finishes
  }
  ```

  `pid`, `configPath`, and `logFile` are present immediately — even while the session
  is still building — so the endpoint never blocks on the build. `packages` and `config`
  are `null` until the process manager attaches, then populated. `config` is fully
  **resolved** (defaults applied, `command` normalized to `{ name, watches, builds, cleans }`)
  as loaded at startup — restart devtooie to pick up edits. `logFile` tracks in-session
  log rotation, so it's always the file currently being written.

- `POST /command/restart/<name>` / `POST /command/rebuild/<name>` — restart
  or rebuild-then-restart a package (`202` if accepted, `404` for an unknown package).
- `POST /command/quit` — graceful shutdown (same as Ctrl+C).

This is what lets a second `devtooie` invocation hand off from a running one, what
[`devtooie logs`](cli.md#devtooie-logs) locates the current logfile with, and what an
external tool (or the agent skill) uses to drive a session headlessly.

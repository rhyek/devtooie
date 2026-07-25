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
- `POST /command/quit` — graceful shutdown (same as Ctrl+C). **Blocks** until the session's
  packages are torn down and their ports freed, then returns `200` (see
  [Graceful shutdown](#graceful-shutdown)) — so once the request returns, the ports are clear.
  It can take up to ~15s if a package is slow to exit.

This is what lets a second `devtooie` invocation hand off from a running one, what
[`devtooie logs`](cli.md#devtooie-logs) locates the current logfile with, and what an
external tool (or the agent skill) uses to drive a session headlessly.

## Graceful shutdown

Ctrl+C and `POST /command/quit` funnel through the same graceful shutdown, so the teardown is
identical however it's triggered. Each package is given a chance to exit cleanly before it's
forced, in three phases:

1. **`SIGTERM`** to every package's **process group** — the package and anything it spawned (a
   package manager, a nested dev server) all receive it together. This is a package's cue to run
   its own cleanup and exit.
2. **Grace period** — devtooie waits up to **10 seconds** for each package to exit on its own.
3. **`SIGKILL`** to the process group of any package still alive when the grace period elapses.

The whole sequence is bounded by a safety net (~15s) so a wedged child can't hang the exit. Once
every package is down (ports freed), the control server closes and the process exits. A **second**
Ctrl+C (or a repeat `POST /command/quit`) while a shutdown is already in progress skips the grace
and `SIGKILL`s everything immediately.

A **blocking `POST /command/quit`** is acknowledged at the end of phase 3 — packages down and ports
freed, just before the control server closes — so a caller that awaits the response knows the ports
are clear the moment it returns. This is what lets a newer `devtooie` invocation hand off cleanly
from a running one: it issues the quit, waits for that ack, then binds the ports itself (force-killing
the old process only if it overruns its graceful window).

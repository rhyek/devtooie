# Control API

> Part of the [devtooie](../README.md) documentation.

While a session runs, devtooie exposes a localhost-only HTTP API — mostly useful
for coding agents (via the [agent skill](../README.md#agent-skill)), but open to any tooling.
Its port is picked at startup and written (with the pid, the session's `logDir`, and the
current `logFile`) to `node_modules/.devtooie/running.json` — read the `port` field there.
`logFile` is kept pointing at the latest file across in-session log rotation. Pin a fixed
port with `apiPort` in `devtooie.config.ts`. The file is not removed when a session ends, so
it says where a session _would_ answer, not that one is running — query the port to find out.

- `GET /query/status` — a single snapshot of the running session:

  ```jsonc
  {
    "pid": 12345,
    "configPath": "/abs/devtooie.config.ts", // the devtooie.config.* it was started with
    "startedByAgent": false, // was this session launched by a coding agent?
    "logFile": "/abs/.../node_modules/.devtooie/logs/1784784120727.log", // current logfile (rotation-aware)
    "packages": { "web": "running", "api": "waiting" }, // running | stopped | waiting | restarting | rebuilding; null until the build finishes
    "config": {/* … */}, // the resolved config; null until the build finishes
    "devReverseProxy": {
      // the session's dev reverse proxy, or null when the config declares none
      "port": 4000,
      "rootDomain": "myproject.example.test",
      "routes": [{ "host": "web.myproject.example.test", "package": "web", "port": 3000 }],
    },
  }
  ```

  `pid`, `configPath`, `startedByAgent`, and `logFile` are present immediately — even while
  the session is still building — so the endpoint never blocks on the build.
  `startedByAgent` reports whether the session was launched by a coding agent rather than by
  a person, detected from the environment variables agents set (`CLAUDECODE`, `CURSOR_AGENT`,
  `AGENT`, and friends); it decides whether a starting session may quit this one without
  asking — see [Taking over a running session](./cli.md#taking-over-a-running-session).
  Instances older than 0.7.0 omit the field, which reads as `false`. `packages` and `config`
  are `null` until the process manager attaches, then populated. `config` is fully
  **resolved** (defaults applied, `command` normalized to `{ name, watches, builds, cleans }`)
  as loaded at startup — restart devtooie to pick up edits. `logFile` tracks in-session
  log rotation, so it's always the file currently being written. The same resolved `config`,
  without a session, is what [`devtooie show-config`](./cli.md#devtooie-show-config) prints.
  `devReverseProxy` is present
  from the start (the proxy binds before anything else) and lists every hostname it routes —
  see [Dev reverse proxy](./dev-reverse-proxy.md).

- `POST /command/restart/<name>` / `POST /command/rebuild/<name>` — restart
  or rebuild-then-restart a package (`202` if accepted, `404` for an unknown package).
- `POST /command/quit` — graceful shutdown (same as Ctrl+C). **Blocks** until the session's
  packages are torn down and their ports freed, then returns `200` (see
  [Graceful shutdown](#graceful-shutdown)) — so once the request returns, the ports are clear.
  It can take up to ~15s if a package is slow to exit.

This is what lets a second `devtooie` invocation hand off from a running one — once that
takeover is authorized, see [Taking over a running session](cli.md#taking-over-a-running-session)
— what [`devtooie logs`](cli.md#devtooie-logs) locates the current logfile with, and what an
external tool (or the agent skill) uses to drive a session headlessly.

## Graceful shutdown

Ctrl+C, `POST /command/quit`, and the termination signals **`SIGHUP`**, `SIGINT` and `SIGTERM` all
funnel through the same graceful shutdown, so the teardown is identical however it's triggered.
`SIGHUP` matters most in practice: it's what a closing terminal window, a killed tmux pane, or a
dropped SSH connection delivers, and it must tear packages down rather than leave them running
without a parent. Each package is given a chance to exit cleanly before it's forced, in three
phases:

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

### Orphan cleanup at startup

`SIGKILL` can't be trapped, so a devtooie killed outright (or lost to a crashed terminal) leaves its
packages running, reparented to PID 1. To keep those from accumulating one generation per lost
session, devtooie records the processes it spawns in `node_modules/.devtooie/running.json` and, on
the next start, reaps whatever is still running.

Records are matched as **process groups**, not single pids. Packages are spawned detached, so each
recorded pid is also its group id — and the group outlives its leader. A dev command that wraps the
real worker (`env-cmd -- tsx watch …`, a package manager, any `foo -- bar` shim) exits as soon as it
has spawned, leaving the worker running in that group with no parent. Checking whether the recorded
pid is still alive would skip exactly those. Before anything is signalled, at least one live member
of the group must still be running in the directory the record was written with, so a recycled
number can't take an unrelated process with it, and a group containing devtooie itself is never
touched.

This sweep reaches packages that never bind a port, which the port check below cannot.

devtooie also frees its configured dev ports at startup, but only from processes belonging to **this
workspace**. A configured port is a claim on a number, not ownership of it: if another project (or
any other program) is listening there, devtooie reports it and leaves it running, and the package
that wanted the port fails to bind as it normally would.

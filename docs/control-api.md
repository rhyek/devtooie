# Control API

> Part of the [devtooie](../README.md) documentation.

While a session runs, devtooie exposes a localhost-only HTTP API — mostly useful
for coding agents (via the [agent skill](../README.md#agent-skill)), but open to any tooling.
Its port is picked at startup and written (with the pid and the session's
`logDir`) to `node_modules/.devtooie/running.json` — read the `port` field there.
Pin a fixed one with `apiPort` in `devtooie.config.ts`.

- `GET /query/pid` — the running session's PID **and the absolute path to the
  `devtooie.config.*` it was started with** (`{ pid, configPath }`).
- `GET /query/status[/<name>]` / `GET /query/packages[?status=...]` — package
  status.
- `GET /query/config` — the whole **resolved** config (defaults applied,
  `command` normalized to `{ name, watches, builds, cleans }`), as loaded at startup
  (restart devtooie to pick up edits).
- `POST /command/restart/<name>` / `POST /command/rebuild/<name>` — restart
  or rebuild-then-restart a package.
- `POST /command/quit` — graceful shutdown (same as Ctrl+C).

This is what lets a second `devtooie` invocation hand off from a running one, and
what an external tool (or the agent skill) uses to drive a session headlessly.

# Changelog

## 0.5.1 (2026-07-23)

- **`POST /command/quit` now blocks until shutdown is safe, and the shutdown grace is longer.** Each package gets up to 10s (was 3s) to exit on `SIGTERM` before it's `SIGKILL`ed, and a quit request holds its response until every package is down and its ports are freed — so a newer `devtooie` invocation handing off from a running one only starts once the old session's ports are actually clear. See [docs/control-api.md](docs/control-api.md#graceful-shutdown).
- **Session footer shows the working directory and git branch** — `cwd: <dir>` and, in a git repo, `git: <branch>` on one line above the logfile.
- **Multi-line values in a structured log stay aligned and grouped.** A property whose value spans several lines (a message body, a stack trace) no longer drops its continuation lines flush against the left edge — they line up under where the value starts. Relatedly, a formatted entry is now held together explicitly rather than by inferring it from indentation, so a multi-line result from any `logs.formatter` filters and replays as one entry even if it isn't indented.
- **`fields.custom` accepts a callback**, so a formatter can decide which properties to rename or hide from the log entry itself — e.g. hiding a field only on one kind of event: `custom: (log) => (log.context === 'message-ingest' ? { at: { show: false } } : {})`. See [docs/logging.md](docs/logging.md#the-logging-helpers).
- **devtooie's own log lines are labelled and structured.** Its system notices no longer sit in an empty prefix slot — they're tagged `[devtooie]` (and control-API commands `[dt:control]`), both in a distinct gold. Both channels are now structured logs, so a control command records the variables it was called with as indented properties (e.g. `[INFO] restart` above `package: backend`). See [docs/logging.md](docs/logging.md#devtooies-own-log-lines).
- **Fixed a blank gap above the package selector and build screens** — these pre-run phases now fill the viewport like the running session, so they anchor to the top instead of appearing below a large empty space.

## 0.5.0 (2026-07-23)

- **New `devtooie logs` subcommand** — print the current session's logfile, `-f/--follow` to stream it live, or `--path` to print just its path; resolves the logfile from the running instance (falling back to the last recorded one), read-only so it never disturbs the session. See [docs/cli.md](docs/cli.md#devtooie-logs).
- **Control API: one `GET /query/status` snapshot.** The separate `GET /query/pid`, `/query/packages`, and `/query/config` endpoints are replaced by a single `GET /query/status` that returns the pid, config path, per-package status, resolved config, and the current logfile together. `node_modules/.devtooie/running.json` now also records the active `logFile` (kept current across in-session log rotation). See [docs/control-api.md](docs/control-api.md). _(Breaking: the three old query endpoints are removed.)_
- **Fixed a memory leak in long-running sessions.** The interactive session's memory grew with uptime and could eventually exhaust memory and crash after many hours (even while idle) — it now stays flat, so a session is safe to leave running indefinitely.

## 0.4.0

- **Reworked terminal UI.** The interactive session now runs as a fullscreen app, for far more solid rendering: it reflows cleanly on terminal resize (no more gaps or a misplaced footer), has much less jitter during normal operation, and stays smooth however fast logs stream. History now scrolls **in-app** (mouse wheel or keyboard) instead of through the terminal's own scrollback, and log text is selectable and copyable.
- **New `devtooie cmd` subcommand** (replaces `devtooie env`) — run a one-off command with a package's exact environment without starting a session. See [docs/cli.md](docs/cli.md#devtooie-cmd). _(Breaking: `devtooie env` removed.)_
- **Every command now works from any subdirectory** — devtooie walks up to the nearest `devtooie.config.*`, switches to it, and loads its workspace-scope `.env` first, so a subdirectory behaves the same as the repo root.
- **Session logfiles** — a run's log is now `<timestamp>.log` (under `node_modules/.devtooie/logs/`, or `--log-dir`).
- **Structured-log formatting, by default.** Every package's JSON logs (Go `slog`, pino, winston, …) are auto-formatted for dev as a colored `[LEVEL] message` with indented properties — non-JSON passes through untouched. Override or customize per package via `logs.formatter` (with the exported `logging` helpers), and opt into on-screen timestamps with `logs.timestamps`. See [docs/logging.md](docs/logging.md).

## 0.3.1

- Docs restructured: the README is now a slim landing page that links to focused topic docs under `docs/` (`configuration.md`, `package-lifecycle.md`, `cli.md`, `control-api.md`), and the installed agent skill now loads a single consolidated guide, `docs/agents.md` (replacing `docs/usage-guide.md`).
- `.env.development.pre` is no longer loaded by default. The default `.env` files are now `.env`, `.env.development`, and `.env.local`; re-add any other name (including `.env.development.pre`) via `defineConfig({ env: { files } })` if you relied on it.
- Docs: the Features list now highlights that per-package logs are **filterable** in the terminal UI — the `f` hotkey narrows the combined stream to a package name or search term — instead of just noting the colored name prefix.

## 0.3.0

- Session logs are no longer truncated on startup. Each run writes a **fresh, timestamped** logfile — `dev-<timestamp>.log` under `node_modules/.devtooie/logs/` — so previous sessions' logs are always preserved.
- Replaced `--logfile <path>` with `--log-dir <dir>`: choose the directory devtooie writes its timestamped session log into (defaults to `node_modules/.devtooie/logs/`).
- The terminal-UI `t` hotkey now **rotates** the log (stops writing to the current file and starts a fresh timestamped one, leaving the old file intact) instead of truncating it in place.
- `running.json` now records the session's `logDir`, so tooling and agents can locate the current session's logs even when it was started with `--log-dir`.

## 0.2.1

- Docs: corrected the `devtooie.config.ts` example — devtooie doesn't watch your source or restart a package for you; after editing its code you (or an agent, via the control API) restart it.
- Tidied the terminal-UI screenshot.

## 0.2.0

- Flat, typed per-package config: options like `command`, `port`, `deps`, and `healthcheck` now sit directly on the package (the `run` nesting is gone), backed by a Zod schema with editor hover docs.
- TypeScript project references & live shared libraries: build-time deps are inferred from your tsconfig `references` and built first, and a shared lib with a watching `dev` script re-emits on edit so consumers pick it up live.
- Language-agnostic packages (drive Go/Rust/… via a `Makefile`) plus lifecycle-aware `command` flags (`watches`/`builds`/`cleans`) that tell you whether to restart or rebuild after a code edit, and a per-package log `color`.

## 0.1.0

- Initial release: `defineConfig` library + `devtooie` CLI (dependency-aware local dev orchestration, TUI + plain runners, control API, `devtooie init`, agent skill).
- Per-package `.env` loading: workspace- and package-scoped `.env` files are resolved (configurable via `env.files`), injected into each package's process, watched for changes (auto-restart), and exposed standalone via `devtooie env`.
- Control API port is now chosen at startup from `14000`–`14099` and recorded in `node_modules/.devtooie/running.json`; session handoff uses that file plus a config-path check so instances of different workspaces don't shut each other down. Pin a fixed port with `apiPort` if needed.
- Clean rebuild (the `b` hotkey / control-API rebuild endpoint) now falls back to running `clean` then `build` in sequence when a package has no combined `build:clean` script/target — so Makefile-driven (non-Node) packages, which can't name a `build:clean` target, are rebuildable too.
- A package's `run.port` is injected into its process as the `PORT` env var (between the inherited environment and the package's `.env` files, so an explicit `.env` `PORT` still wins).
- `devtooie init` gained a `-y`/`--yes` flag for a non-interactive run (accepts the defaults — scaffold the config + install the agent skill — without prompting).
- `devtooie init` now reconciles a root `tsconfig.json` (creating one, or adding `devtooie.config.ts` to `include` + `"node"` to a `types` array) so `process.env.*` in the config doesn't show a spurious TS2591 error in editors. Idempotent; existing settings are preserved (comments included).

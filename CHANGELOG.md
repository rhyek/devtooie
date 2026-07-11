# Changelog

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

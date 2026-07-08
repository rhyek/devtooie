# Changelog

## 0.1.0

- Initial release: `defineConfig` library + `devtooie` CLI (dependency-aware local dev orchestration, TUI + plain runners, control API, `devtooie init`, agent skill).
- Per-package `.env` loading: workspace- and package-scoped `.env` files are resolved (configurable via `env.files`), injected into each package's process, watched for changes (auto-restart), and exposed standalone via `devtooie env`.
- Control API port is now chosen at startup from `14000`–`14099` and recorded in `node_modules/.devtooie/running.json`; session handoff uses that file plus a config-path check so instances of different workspaces don't shut each other down. Pin a fixed port with `apiPort` if needed.
- Clean rebuild (the `b` hotkey / control-API rebuild endpoint) now falls back to running `clean` then `build` in sequence when a package has no combined `build:clean` script/target — so Makefile-driven (non-Node) packages, which can't name a `build:clean` target, are rebuildable too.
- A package's `run.port` is injected into its process as the `PORT` env var (between the inherited environment and the package's `.env` files, so an explicit `.env` `PORT` still wins).
- `devtooie init` gained a `-y`/`--yes` flag for a non-interactive run (accepts the defaults — scaffold the config + install the agent skill — without prompting).
- `devtooie init` now reconciles a root `tsconfig.json` (creating one, or adding `devtooie.config.ts` to `include` + `"node"` to a `types` array) so `process.env.*` in the config doesn't show a spurious TS2591 error in editors. Idempotent; existing settings are preserved (comments included).

# Changelog

## 0.1.0

- Initial release: `defineConfig` library + `devtooie` CLI (dependency-aware local dev orchestration, TUI + plain runners, control API, `devtooie init`, agent skill).
- Per-package `.env` loading: workspace- and package-scoped `.env` files are resolved (configurable via `env.files`), injected into each package's process, watched for changes (auto-restart), and exposed standalone via `devtooie env`.
- Control API port is now chosen at startup from `14000`–`14099` and recorded in `node_modules/.devtooie/running.json`; session handoff uses that file plus a config-path check so instances of different workspaces don't shut each other down. Pin a fixed port with `apiPort` if needed.

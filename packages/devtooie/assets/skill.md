---
name: devtooie
description: Use when running, building, or restarting a local dev package through devtooie; when asked to add, configure, or onboard a package into devtooie; or when debugging a running package by reading its logs.
---

# devtooie

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. This
skill teaches an agent how to drive it headlessly, control a running session over its
HTTP API, onboard a new package into it, and read a running session's logs for debugging.

## 1. Invoke headlessly

Never launch devtooie's interactive TUI from an agent — there is no TTY to drive it.
Always pass `--plain` together with an explicit `-p <package>` (repeatable) so no
interactive selector is shown:

```sh
devtooie --plain -p <package> [-p <other-package> ...]
```

- **Build instead of run**: add `--build` (alias for `--phase build`) to build the
  selected package(s) and their dependencies, then exit — no long-running processes.
- **Force a clean rebuild**: add `--rebuild` — clears `dist/` for the whole build set
  first, then builds.
- **Stop a session you started**: send `SIGINT`/`SIGTERM` to the process (graceful
  shutdown), or use the control API's `POST /command/quit` (see below) if you no
  longer hold the process directly.

## 2. Drive a running session via the control API

A running devtooie session (whether started by you or a human) exposes a localhost
HTTP control API. Its port is **not** a devtooie CLI flag — read it from the project
config file `devtooie.config.ts` at the repo root: the `apiPort` field passed to
`defineConfig` (default `4099` if absent):

```ts
export default defineConfig({ apiPort: 4099, packages: [/* … */] });
```

Endpoints (all plain HTTP, no auth — localhost-only):

- `POST /command/restart/<name>` — restart one package in place.
- `POST /command/rebuild/<name>` — stop, run `build:clean`, then start. Prefer this
  over `restart` whenever the package's build output (not just its source) changed.
- `POST /command/quit` — gracefully shut down the whole session.
- `GET /query/status` — status of every package. `GET /query/status/<name>` — one
  package.
- `GET /query/packages?status=<status>` — list package names filtered by status.

Do not hardcode package names. Discover them either from a running session
(`GET /query/status`) or by asking devtooie directly:

```sh
devtooie resolvedeps -p <package>
```

which prints that package's build/dev/runtime dependency names as JSON.

## 3. Onboard a package into devtooie

When asked to add, configure, or onboard one of the user's packages into devtooie:

1. **Ensure the package has the npm scripts devtooie drives.** For a Node package (it
   has a `package.json`), it needs `dev`, `build`, `clean`, and `build:clean`, where
   `build:clean` runs `clean` then `build`. devtooie's rebuild command runs
   `build:clean`, and its "rebuildable" detection (the `b` hotkey in the interactive
   UI, and the control API's rebuild endpoint) keys off that script's presence — so
   don't skip it. A non-Node package is driven the same way through a `Makefile` with
   equivalent targets instead of npm scripts.
2. **Rename equivalent existing scripts rather than duplicate them.** If the package
   already has a script that does the same job under a different name, rename it
   (and fix any references to the old name) instead of adding a second script that
   does the same thing:
   - `start:dev` or `serve` → rename to `dev`
   - `compile` or `tsc` → rename to `build`
   - a script that runs `rimraf dist` (or equivalent) → rename to `clean`
3. **Add the package to `devtooie.config.ts`.** Append a new entry to the `packages`
   array passed to `defineConfig`:
   ```ts
   { name: 'my-pkg', types: ['backend'], run: { port: 3001 } }
   ```
   Infer `types` (`backend` / `browser` / `lib`) and a `run` block (`port`,
   `healthcheck`, `deps`) from what the package actually is. Keep `name` consistent
   with how the package should be referred to elsewhere (control API paths, `-p` flags,
   etc). The type augmentation at the bottom of `devtooie.config.ts` references the
   config's own `packages`, so the new name is recognized with no extra codegen step.

## 4. Read running-package logs for debugging

A running devtooie session streams the combined stdout/stderr of every package it
runs into a single logfile at the fixed, literal path:

```
node_modules/.devtooie/devlog.txt
```

To debug a package's runtime behavior — crashes, stack traces, request logs — read,
tail, or grep that file directly, e.g.:

```sh
tail -n 200 node_modules/.devtooie/devlog.txt
grep -i error node_modules/.devtooie/devlog.txt
```

**This skill always reads logs from that exact path, regardless of any `--logfile`
override.** The `--logfile` flag only changes where the *running* devtooie session
writes its combined log — it does not change where this skill looks. So if you are
the one starting the session (per §1), do **not** pass `--logfile`, otherwise the
logs you need to debug with will end up somewhere other than the path above.

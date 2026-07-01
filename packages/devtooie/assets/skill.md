---
name: devtooie
description: Use when running, building, or restarting a local dev service through devtooie; when asked to add, configure, or onboard an app or service into devtooie; or when debugging a running service by reading its logs.
---

# devtooie

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. This
skill teaches an agent how to drive it headlessly, control a running session over its
HTTP API, onboard a new app into it, and read a running session's logs for debugging.

## 1. Invoke headlessly

Never launch devtooie's interactive TUI from an agent — there is no TTY to drive it.
Always pass `--plain` together with an explicit `-s <service>` (repeatable) so no
interactive selector is shown:

```sh
devtooie --plain -s <service> [-s <other-service> ...]
```

- **Build instead of run**: add `--build` (alias for `--phase build`) to build the
  selected service(s) and their dependencies, then exit — no long-running processes.
- **Force a clean rebuild**: add `--rebuild` — clears `dist/` for the whole build set
  first, then builds.
- **Stop a session you started**: send `SIGINT`/`SIGTERM` to the process (graceful
  shutdown), or use the control API's `POST /command/quit` (see below) if you no
  longer hold the process directly.

## 2. Drive a running session via the control API

A running devtooie session (whether started by you or a human) exposes a localhost
HTTP control API. Its port is **not** a devtooie CLI flag — read it from the project
config file `devtooie.yaml` at the repo root, field `apiPort` (default `4099` if the
field is absent):

```yaml
apiPort: 4099
```

Endpoints (all plain HTTP, no auth — localhost-only):

- `POST /command/restart/<app>` — restart one service in place.
- `POST /command/rebuild/<app>` — stop, run `build:clean`, then start. Prefer this
  over `restart` whenever the service's build output (not just its source) changed.
- `POST /command/quit` — gracefully shut down the whole session.
- `GET /query/status` — status of every service. `GET /query/status/<app>` — one
  service.
- `GET /query/services?status=<status>` — list service names filtered by status.

Do not hardcode service names. Discover them either from a running session
(`GET /query/status`) or by asking devtooie directly:

```sh
devtooie resolvedeps -s <service>
```

which prints that service's build/dev/runtime dependency names as JSON.

## 3. Onboard an app into devtooie

When asked to add, configure, or onboard one of the user's apps into devtooie:

1. **Ensure the app has the npm scripts devtooie drives.** For a Node app (it has a
   `package.json`), it needs `dev`, `build`, `clean`, and `build:clean`, where
   `build:clean` runs `clean` then `build`. devtooie's rebuild command runs
   `build:clean`, and its "rebuildable" detection (the `b` hotkey in the interactive
   UI, and the control API's rebuild endpoint) keys off that script's presence — so
   don't skip it. A non-Node app is driven the same way through a `Makefile` with
   equivalent targets instead of npm scripts.
2. **Rename equivalent existing scripts rather than duplicate them.** If the app
   already has a script that does the same job under a different name, rename it
   (and fix any references to the old name) instead of adding a second script that
   does the same thing:
   - `start:dev` or `serve` → rename to `dev`
   - `compile` or `tsc` → rename to `build`
   - a script that runs `rimraf dist` (or equivalent) → rename to `clean`
3. **Add the app to the services file.** Append a new entry to the `apps` array in
   the module named by `devtooie.yaml`'s `services` field (default `./services.ts`):
   ```ts
   { name: 'my-app', types: ['backend'], run: { port: 3001 } }
   ```
   Infer `types` (`backend` / `browser` / `lib`) and a `run` block (`port`,
   `healthcheck`, `deps`) from what the app actually is. Keep `name` consistent with
   how the app should be referred to elsewhere (control API paths, `-s` flags, etc).
4. **Refresh generated types.** After editing the services file, run:
   ```sh
   devtooie typegen
   ```
   to regenerate the type-augmentation file so the new app name is recognized
   (this also happens automatically on devtooie's next run, but running it
   explicitly avoids a stale-types window while you keep working).

## 4. Read running-service logs for debugging

A running devtooie session streams the combined stdout/stderr of every service it
runs into a single logfile at the fixed, literal path:

```
node_modules/.devtooie/devlog.txt
```

To debug a service's runtime behavior — crashes, stack traces, request logs — read,
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

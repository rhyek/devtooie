# devtooie usage guide

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. This
guide teaches an agent how to drive it headlessly, control a running session over its
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
- **Environment**: each package's `.env` files are loaded and injected into its process
  automatically (see §5), so you don't set env vars yourself. A running session also
  restarts a package when its `.env` files change — so an unexpected restart may just be
  an env edit, not a crash.

## 2. Drive a running session via the control API

A running devtooie session (whether started by you or a human) exposes a localhost
HTTP control API on a port chosen at startup. **Read the active port from the JSON file
`node_modules/.devtooie/running.json`** — devtooie writes the current `{ "port", "pid" }`
there. Always resolve the port from that file rather than assuming one; a project may pin
a fixed port with `apiPort` in `devtooie.config.ts`, but `running.json` is always current.

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

1. **Ensure the package exposes the entry points devtooie drives.** devtooie chooses how
   to run a package from what's in its directory: with a `package.json` it runs npm
   scripts (`pnpm run <name>`); with a `Makefile` and no `package.json` it runs
   `make <target>`. (`package.json` wins if a package somehow has both.)

   In all cases a package needs `dev`, `build`, and `clean`. devtooie's clean-rebuild (the
   `b` hotkey in the interactive UI and the control API's rebuild endpoint) runs
   `build:clean` if the package defines it, otherwise it runs `clean` then `build` in
   sequence — so `dev` + `build` + `clean` is enough to be "rebuildable".

   For a **Node package**, these are npm scripts. You may add a combined `build:clean`
   script (running `clean` then `build`) as a shortcut, but it's optional now that separate
   `clean` + `build` are used automatically.

   For a **non-Node package** (no `package.json`), the entry points come from a `Makefile`
   with the equivalent **`make` targets** `dev`, `build`, and `clean`, which devtooie
   invokes as `make dev` / `make build` / `make clean`. **If the package has no `Makefile`,
   create one** (a package with neither a `package.json` nor a `Makefile` can't be driven);
   if it already has one, add whatever targets are missing. Each target wraps whatever the
   app's toolchain needs — e.g. for a Go service `dev` is `go run .`, `build` is
   `go build`, and `clean` removes the build output:

   ```makefile
   SHELL=/bin/bash -o pipefail
   .PHONY: dev build clean

   dev:
   	@go run .

   build:
   	@go build -o ./bin/app .

   clean:
   	@rm -rf ./bin
   ```

   Recipe lines must be indented with a real tab. A `make` target name can't contain a
   colon, so a Makefile package can't have a `build:clean` target — but it doesn't need one:
   with `build` and `clean` targets, devtooie's rebuild runs `make clean` then `make build`,
   so a Makefile package with `dev`/`build`/`clean` is fully rebuildable.

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
   {
     name: 'my-pkg',
     types: ['backend'],
     run: {
       port: 3001,
       healthcheck: 'http://localhost:$port/health',
       deps: { runtime: ['other-pkg'] },
       waitFor: ['other-pkg'],
     },
   }
   ```

   Infer `types` (`backend` / `browser` / `lib`) and the `run` block from what the
   package actually is:
   - `port` — the dev port it listens on (`hmrPort` for a browser package's HMR socket).
     devtooie injects this into the package's process as the `PORT` env var, so the app can
     read `process.env.PORT` without you duplicating it in a `.env` (an explicit `.env`
     `PORT` still wins).
   - `healthcheck` / `urls` — strings that may contain **tokens** substituted at load
     time: `$port`, `$name`, `$subdomain` (intrinsic), plus any extrinsic `$key` you
     declare in the top-level `tokens` map passed to `defineConfig`. Write
     `http://localhost:$port/health` rather than hardcoding the port, so it can't drift.
     Each `urls` entry is a string, a `{ label, url }`, or an array of those (an array
     entry's links render on one footer line, space-separated).
   - `deps: { build, dev, runtime }` — names of other packages this one depends on;
     drives build/start ordering and what gets pulled in when this package is selected.
   - `waitFor` — names of packages whose `healthcheck` must pass before this one starts
     (each named package must itself define a `healthcheck`).

   Keep `name` consistent with how the package should be referred to elsewhere (control
   API paths, `-p` flags, etc). The `declare module 'devtooie'` block at the bottom of
   `devtooie.config.ts` references the config's own `packages` (`typeof config.packages`),
   so the new name is recognized inline with no extra codegen step.

   For workspace-wide links not tied to any package (dashboards, docs), add a top-level
   `urls` array to `defineConfig` — same entry shape as a package's `run.urls`. These
   render in the TUI footer above the per-package links and substitute only extrinsic
   `tokens` (no `$port`/`$name`/`$subdomain`).

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

Mutating commands received over the control API (restart, rebuild, quit) are echoed
into the same log as `[dt:control]` lines (e.g. `[dt:control] restart backend`),
so you can confirm a command you sent (per §2) actually landed and see the package's
own output that followed it.

**This skill always reads logs from that exact path, regardless of any `--logfile`
override.** The `--logfile` flag only changes where the _running_ devtooie session
writes its combined log — it does not change where this skill looks. So if you are
the one starting the session (per §1), do **not** pass `--logfile`, otherwise the
logs you need to debug with will end up somewhere other than the path above.

## 5. Run a one-off command with a package's environment

devtooie resolves a package's `.env` files (at the workspace root and the package's own
directory) and can inject them into any command — use this to run scripts, migrations, or
checks with the exact env a package would run under:

```sh
devtooie env --dir <relativeDir> -- <command> [args...]
```

- `--dir <relativeDir>` — the package's `relativeDir` from `devtooie.config.ts`, relative to
  the workspace root. Omit it to default to your current directory — so running from inside a
  package resolves that package (workspace-level files included). Pass `--dir .` to resolve at
  the workspace root only.
- Everything after `--` is run with the resolved vars merged over the current environment;
  the command's exit code is propagated.
- Omit the `-- <command>` to instead **print** the resolved `KEY=value` pairs — useful for
  seeing what a package will get:

```sh
devtooie env --dir <relativeDir>
```

Precedence: files in the package's own directory override the workspace-root ones, and a
`.env.local` overrides a `.env`. You do not need this for packages devtooie is already
running (§1 injects their env automatically) — it's for driving commands yourself.

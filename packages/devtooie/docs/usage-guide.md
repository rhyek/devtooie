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
  automatically (see §6), so you don't set env vars yourself. A running session also
  restarts a package when its `.env` files change — so an unexpected restart may just be
  an env edit, not a crash.

## 2. Drive a running session via the control API

A running devtooie session (whether started by you or a human) exposes a localhost
HTTP control API on a port chosen at startup. **Read the active port from the JSON file
`node_modules/.devtooie/running.json`** — devtooie writes the current
`{ "port", "pid", "logDir" }` there (`logDir` is where this session's logs go, see §5).
Always resolve the port from that file rather than assuming one; a project may pin a fixed
port with `apiPort` in `devtooie.config.ts`, but `running.json` is always current.

Endpoints (all plain HTTP, no auth — localhost-only):

- `POST /command/restart/<name>` — restart one package in place.
- `POST /command/rebuild/<name>` — stop, run `build:clean`, then start. Prefer this
  over `restart` whenever the package's build output (not just its source) changed.
- `POST /command/quit` — gracefully shut down the whole session.
- `GET /query/status` — status of every package. `GET /query/status/<name>` — one
  package.
- `GET /query/packages?status=<status>` — list package names filtered by status.
- `GET /query/config` — the whole resolved config (defaults applied, `command`
  normalized to `{ name, watches, builds, cleans }`). Use it to decide package lifecycle — see §4.

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

   Only the **dev entry point** is always required. `build` and `clean` are situational:
   - **`build`** — only if another package build-depends on this one, or to build it with
     `--build`. A leaf app that nothing depends on needs none (`--build` on it builds its deps,
     not the package itself).
   - **`clean`** — with `build` (or a single `build:clean`) it makes the package cleanly
     rebuildable: rebuild (the `b` hotkey / `POST /command/rebuild`) runs `clean` then `build`.
     A self-cleaning dev command needs neither — see `cleans` below.

   For a **Node package**, these are npm scripts. For a **non-Node package** (no
   `package.json`), they're the equivalent **`make` targets**, invoked as `make <target>`.
   **If the package has neither a `package.json` nor a `Makefile`, create a `Makefile`** (a
   package with neither can't be driven); if it already has one, add whatever targets are missing.

   Example — a Go service whose dev command is `go run .`. Because `go run .` compiles from
   current source on every start, it's a clean rebuild on its own, so a single `start` target
   suffices; set `command: ['start', { watches: false, builds: true, cleans: true }]` (see §4)
   and both restart and rebuild work without `build`/`clean` targets:

   ```makefile
   .PHONY: start
   start:
   	@go run .
   ```

   Recipe lines must be indented with a real tab. (If instead you want a compiled artifact —
   e.g. because another package build-depends on this one — add `build` (`go build -o ./bin/app .`)
   and `clean` (`rm -rf ./bin`) targets. A `make` target name can't contain a colon, so Makefile
   packages use the `clean` + `build` pair, never `build:clean`.)

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
     port: 3001,
     healthcheck: 'http://localhost:$port/health',
     deps: { runtime: ['other-pkg'] },
     waitFor: ['other-pkg'],
   }
   ```

   All package fields are flat (there is no `run` nesting). Infer them from what the
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
     For **TypeScript** deps you usually don't need `deps.build`: devtooie infers build-time
     deps from project references — it reads `tsconfig` if set, else `tsconfig.build.json`,
     else `tsconfig.json`, and follows their `references` to other packages. Wire the real
     dependency the normal way (a `workspace:*` entry in the consumer's `package.json` so pnpm
     links it, plus a tsconfig `references` entry). Use `deps.build` only for edges TS can't express.
   - `waitFor` — names of packages whose `healthcheck` must pass before this one starts
     (each named package must itself define a `healthcheck`).

   Keep `name` consistent with how the package should be referred to elsewhere (control
   API paths, `-p` flags, etc).

   For workspace-wide links not tied to any package (dashboards, docs), add a top-level
   `urls` array to `defineConfig` — same entry shape as a package's `urls`. These
   render in the TUI footer above the per-package links and substitute only extrinsic
   `tokens` (no `$port`/`$name`/`$subdomain`).

4. **Shared TypeScript libraries.** A package others depend on (shared types/logic) is
   onboarded like any other, plus:
   - Give consumers a `workspace:*` dependency on it (pnpm links it) and a tsconfig
     `references` entry pointing at it — that's what makes devtooie build it first.
   - To make it update **live**, give it a watching `dev` script that emits its output
     (e.g. `tsc --watch` → `dist`) and `selectable: false`. devtooie runs its watcher
     alongside the apps; consumers import its emitted `dist` and pick up edits automatically.
     With no `dev` script it's just built once — edits then need an explicit rebuild of the lib.
   - Keep each package's `dev`/`build` building only itself; never root a whole-graph
     `tsc --build --watch` in an app (devtooie already builds the deps).

## 4. Handle a package's lifecycle when you change its code

devtooie does **not** watch source files. How a package should react to a code edit is
declared by its `command`, which you read from `GET /query/config`.

**Fetch the config early, and re-fetch before acting.** On first involvement with a running
session, read `node_modules/.devtooie/running.json` (for the port) and `GET /query/config`
once. Then, each time you're about to restart/rebuild a package, **re-read `running.json`**
(the port changes if the user restarted devtooie) and **re-`GET /query/config`** — the user
may have edited the config and restarted the session, changing what a package needs. Don't
trust a cached copy across a possible restart.

For the package you edited, look at its resolved `command`
(`{ name, watches, builds, cleans }`):

- `watches: true` (the default) — the dev script watches files and reloads itself.
  **Do nothing.**
- `watches: false, builds: true` — `POST /command/restart/<name>`.
- `watches: false, builds: false` — `POST /command/rebuild/<name>` (clean build, then start).

Rule: `watches` → nothing; else `builds` → restart; else rebuild.

`POST /command/rebuild/<name>` only succeeds when the package can clean-rebuild — its command
has `cleans: true` (a self-cleaning dev command like `go run .`, where rebuild just restarts it),
or it has `clean` + `build` (or `build:clean`) scripts. Otherwise it's a no-op; use restart.
`POST /command/restart/<name>` works for any running package.

## 5. Read running-package logs for debugging

A running devtooie session streams the combined stdout/stderr of every package it
runs into a timestamped logfile. The directory it writes into is recorded in
`node_modules/.devtooie/running.json` as **`logDir`**; it defaults to
`node_modules/.devtooie/logs/` and only differs when the session was started with
`--log-dir`.

Each session (and each in-session log rotation) writes a **fresh** file named
`dev-<timestamp>.log`. devtooie never truncates or overwrites an existing log, so
logs from earlier sessions stay on disk. To debug the **current** session, resolve
that directory and read the most recent file in it:

```sh
# the session's log dir from running.json, falling back to the default
dir=$(node -e "process.stdout.write(require('./node_modules/.devtooie/running.json').logDir)" 2>/dev/null || echo node_modules/.devtooie/logs)
log=$(ls -t "$dir"/dev-*.log | head -1)   # newest = current session
tail -n 200 "$log"
grep -i error "$log"
```

`ls -t` sorts newest-first, and the running session's file is always the most
recently written, so `$log` is the current session. To dig into an **earlier** run,
pick an older file from `ls -t "$dir"` instead — prior logs are still there.

Mutating commands received over the control API (restart, rebuild, quit) are echoed
into the same log as `[dt:control]` lines (e.g. `[dt:control] restart backend`),
so you can confirm a command you sent (per §2) actually landed and see the package's
own output that followed it.

**You generally don't need `--log-dir`.** If you start the session yourself (per §1),
leave it off and logs land in the default `node_modules/.devtooie/logs/`. The flag only
changes which directory the _running_ session writes into — and because that directory is
recorded in `running.json` (`logDir`), the command above finds the logs either way.

## 6. Run a one-off command with a package's environment

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

## 7. Convert or improve a TypeScript monorepo for devtooie

When asked to improve a Node/TypeScript monorepo so its packages work well with devtooie —
typically **converting to TypeScript project references** and **reshaping dev scripts** — aim
for the end state below, then apply the per-package specifics from §3.

1. **Let project references drive the build graph.** For every cross-package import:
   - Make the dependency a real workspace package and add a `workspace:*` entry to each
     consumer's `package.json` (so pnpm links it and the consumer imports its published
     `exports`, not a relative path into its source).
   - Add a tsconfig `references` entry from each consumer to the package it imports. devtooie
     reads these to discover build-time deps and builds shared packages **first, in dependency
     order**. It reads `tsconfig` if set, else `tsconfig.build.json`, else `tsconfig.json` —
     so the references can live in a package's plain `tsconfig.json`; a separate build config
     is optional.
   - Make each **shared library** a composite project that **emits** its output
     (`composite: true`, `declaration: true`, `outDir: dist`). Consumers import the emitted
     `dist` (via the package's `exports`), never its source.

2. **Make each package's `dev`/`build` build only itself.** devtooie already builds a package's
   deps before running it, so nothing should rebuild the whole graph.
   - A **library**: a watching `dev` that re-emits (e.g. `tsc --watch`) plus
     `selectable: false`. devtooie runs its watcher alongside the apps, so edits to it
     propagate live to every consumer (see §3.4).
   - An **app**: a `dev` that watches only its own source (`node --watch`, `tsx watch`,
     `vite dev`, …) and consumes libraries through their emitted `dist`. **Never** root a
     whole-graph `tsc --build --watch` in an app — the library owns its watcher.
   - Normalize script names to `dev`/`build`/`clean` (§3.1–§3.2). A leaf app that nothing
     build-depends on needs only its dev script; drop its `build`/`clean` if present.

3. **Verify the graph.** `devtooie resolvedeps -p <app>` should now list the shared libraries
   under `build`; `devtooie --build -p <app>` then builds them in dependency order, and
   `devtooie --plain -p <app>` runs the app with its library watchers alongside it.

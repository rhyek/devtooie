# CLI usage

> Part of the [devtooie](../README.md) documentation.

```bash
devtooie                     # interactive TUI: pick services, run them
devtooie --headless -s web   # no TUI: run `web` (+ its deps), streaming logs
devtooie -s web -s api       # repeatable -s: run multiple named services
devtooie --build -s worker   # build `worker`, then exit
devtooie --rebuild -s worker # like --build, but clears dist/ first
devtooie --mode test      # load .env.test instead of .env.development
devtooie infra up         # bring the config's infra up, wait until ready, exit
```

Every command works from **anywhere in the repo**: as a first step devtooie walks up to the
nearest `devtooie.config.*` and switches to that directory, and a command that uses the
config loads it there with its workspace-scope `.env` — so running from a subdirectory
behaves the same as running from the root.

Common options:

| Option                     | Description                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-s, --service <name>`     | Repeatable. Service(s) to run, bypassing the interactive selector.                                                                                                                                                                         |
| `-m, --mode <name>`        | Environment mode selecting the `.env.<mode>` files to load. Defaults to `development`. Also accepted after a subcommand (`devtooie exec --mode test`). See [Environment loading](../README.md#environment-env-loading).                    |
| `--ui`                     | Interactive terminal UI (default). Mutually exclusive with `--headless`.                                                                                                                                                                   |
| `--headless`               | No TUI — stream logs to stdout with colored name prefixes. Requires `-s` or `--last-answers`.                                                                                                                                              |
| `--detach`                 | With `--headless`: start the session in the background and return, reusing the one already running for this config in this mode. See [Running in the background](#running-in-the-background---detach).                                     |
| `--wait`                   | With `--detach`: return only once the infra and every service it asked for are healthy.                                                                                                                                                    |
| `--wait-timeout <seconds>` | With `--wait`: how long to wait before failing. Defaults to `300`.                                                                                                                                                                         |
| `--last-answers`           | Skip selection; reuse the last saved selection. If a saved name is no longer a service (a renamed key), the picker opens instead with the surviving names preselected; `--headless`/`--build` refuse with a message naming the stale ones. |
| `--build`                  | Build the selected services with their `build` scripts, then exit (no run phase).                                                                                                                                                          |
| `--rebuild`                | Like `--build`, but first clears `dist/` for every build target.                                                                                                                                                                           |
| `--log-dir <dir>`          | Write the timestamped session log into this directory. Defaults to `node_modules/.devtooie/logs/<mode>/`. Each run gets a fresh `<timestamp>.log`; previous sessions' logs are kept. Also used by [`devtooie exec` and `devtooie run`](#devtooie-exec-and-devtooie-run). |
| `--kill-others`            | Quit the devtooie session already running for this project in the same mode instead of asking. See [Taking over a running session](#taking-over-a-running-session).                                                                        |

Subcommands:

- **`devtooie init`** — interactive setup; see [Getting started](../README.md#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved service selection.
- **`devtooie resolvedeps <service>`** — print the resolved dependency sets for a single service
  as JSON.
- **`devtooie exec`** — run a **one-off command** with a service's environment (its dir +
  resolved `.env`); see [below](#devtooie-exec-and-devtooie-run).
- **`devtooie run <script>`** — run one of a service's **scripts or make targets** with that
  same environment; see [below](#devtooie-exec-and-devtooie-run).
- **`devtooie logs`** — print (or `-f/--follow`) the current dev session's logfile; see
  [below](#devtooie-logs).
- **`devtooie infra`** — bring up, tear down, or drive the infrastructure the config declares
  under `infra`; see [below](#devtooie-infra).

## Taking over a running session

A project runs one devtooie session per [mode](../README.md#modes). A session in another mode
runs alongside: `devtooie --mode test` starts next to the `development` session, and nothing is
asked or quit. Starting a second session in the **same** mode has to quit the first — along with
every dev process under it. devtooie asks before doing that:

| Situation                                    | What happens                           |
| -------------------------------------------- | -------------------------------------- |
| `--kill-others` passed                       | Quits the running session, no question |
| Both sessions were started by a coding agent | Quits it, no question                  |
| A terminal is attached                       | Asks you to confirm (default **yes**)  |
| No terminal to ask in                        | Refuses, exits `1`, leaves it running  |

The agent rule keeps agents unblocked without letting one interrupt you: an agent may
replace a session another agent started, but a session **you** started is never taken over
without your say-so. devtooie spots an agent by the environment variables they set
(`CLAUDECODE`, `CURSOR_AGENT`, `GEMINI_CLI`, `CODEX_SANDBOX`, `AGENT`, and others). Editor
variables like `COPILOT_DEBUG_NONCE` don't count — an installed AI extension isn't an agent
at the keyboard. Set `DEVTOOIE_STARTED_BY_AGENT=0` (or `=1`) to override the detection for a
shell where it guesses wrong.

A session's own answer is published as `startedByAgent` on
[`GET /query/status`](./control-api.md).

`--detach` never takes a session over: it [reuses](#running-in-the-background---detach) one
that answers, and refuses one that doesn't.

## Running in the background (`--detach`)

`--headless --detach` starts a session in the background and returns. The session runs what any
session start does — the selected services plus their `deps.runtime`, with the mode's infra —
and runs on after the command exits, until something quits it. `--wait` holds the command until
the stack is healthy:

```bash
devtooie --headless -s web --detach
devtooie --mode test --headless -s web --detach --wait
devtooie --mode test --headless -s web --detach --wait --wait-timeout 60
```

**A running session is reused.** If a session of this config and mode is running and answering,
no second one starts: devtooie starts into that session whatever of the selection (the services
and their runtime deps) it lacks or has stopped. That works for a TUI session too — the service
appears in its footer. A session recorded as running whose process is alive but whose control API
doesn't answer is refused, never taken over. `--detach` can't be combined with `--build`,
`--rebuild`, `--phase build` or `--kill-others`.

**Output.** Progress lines go to stderr. stdout gets exactly one JSON line:

```json
{"ok":true,"session":"started","pid":1234,"port":14019,"mode":"development","logFile":"/abs/…/node_modules/.devtooie/logs/development/1792522023353.log","services":["web","api"]}
```

| Field         | Value                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ok`          | `true` on success. On failure `false`, with an `error` saying why, and the command exits `1`.                          |
| `session`     | `started` when this call started the session; `reused` when one was already running.                                   |
| `pid`, `port` | The session's process and its [control API](./control-api.md) port.                                                    |
| `mode`        | The session's mode.                                                                                                    |
| `logFile`     | The session's log.                                                                                                     |
| `services`    | What this call started: everything the session runs, for a `started` one; what it lacked or had stopped, for `reused`. |

A failure before there is a session to report on prints just `{"ok":false,"error":"…"}`.

**`--wait`** returns only once the infra and every service it asked for are healthy. A service is
healthy when it's running and passing its [`healthcheck`](./configuration.md#readiness-probing);
one with no healthcheck is healthy while it runs. The infra counts once every infra service is
`running`. `--wait` fails — `"ok":false`, exit `1` — when the session exits while starting, when a
wanted service stops (crashes) while starting, or when `--wait-timeout` passes (default `300`
seconds). The error points at the log, or for a timeout lists what isn't healthy:
`not healthy after 300s: worker`.

**The session's own output** from before its log starts, and from any crash, goes to
`<logDir>/detached.out`; `logDir` is `node_modules/.devtooie/logs/<mode>/` unless `--log-dir` is
given. None of it reaches the command's stdout, so a caller that reads stdout to the end isn't
kept waiting. A session that is still running but hasn't answered on its control API by
the `--wait-timeout` (with or without `--wait`) is stopped, and the command fails.

**Stopping it.** Quit a session you started with `POST /command/quit` on its `port` — only when
`session` is `started`. Reuse leaves everything as it found it, so a caller that wants to clean
up a `reused` session stops just the `services` it started, each with
`POST /command/service/stop/<name>` (see [Control API](./control-api.md)).

The typical caller is an e2e suite getting its stack:

```bash
out=$(devtooie --mode test --headless -s web --detach --wait)
ok=$?
if [ "$ok" = 0 ]; then pnpm test:e2e; ok=$?; else echo "$out" >&2; fi
port=$(echo "$out" | jq .port)
session=$(echo "$out" | jq -r .session)
if [ "$session" = started ]; then
  curl -s -X POST "http://127.0.0.1:$port/command/quit"
elif [ "$session" = reused ]; then
  for s in $(echo "$out" | jq -r '.services[]'); do
    curl -s -X POST "http://127.0.0.1:$port/command/service/stop/$s"
  done
fi
exit "$ok"
```

When `--wait` fails, the session it started keeps running, and the `"ok":false` line still
carries its `session`, `port` and `services` — so tear down on failure too.

### From a test suite's setup: `startStack()`

`startStack()`, exported from `devtooie`, is `--headless --detach --wait` as a function, for a
suite's global setup under any test runner:

```ts
import { startStack } from 'devtooie';

const stack = await startStack({ mode: 'test', services: ['web'] });
try {
  // stack.origins.web, stack.rootDomain, stack.control.query.status(), …
} finally {
  await stack.stop(); // quits the session if this call started it; a reused one is left running
}
```

| Option        | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `services`    | The services to bring up, as `-s` names them. Their runtime deps and the mode's infra come too.        |
| `mode`        | As `--mode` takes it. Unset, the mode resolves as it does for the CLI.                                 |
| `cwd`         | Where the workspace is found from, as the CLI finds it. Defaults to `process.cwd()`.                   |
| `waitTimeout` | As `--wait-timeout` takes it, in seconds. Defaults to `300`.                                           |
| `logDir`      | As `--log-dir` takes it.                                                                               |
| `env`         | The environment the session starts with. Defaults to `stackEnvironment()`; given, it is used as it is. |

It resolves with:

| Field             | Value                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`         | `started` or `reused`, as on the JSON line.                                                                                                                                |
| `pid`, `port`     | The session's process and its control-API port.                                                                                                                           |
| `mode`, `logFile` | The session's mode and log.                                                                                                                                                |
| `services`        | What this call started, as on the JSON line. `stop()` leaves those of a reused session running; stop them with `control.command.service.stop()` to undo them too.          |
| `origins`         | Every configured service's origin, selected or not: its `publicOrigin` under the [dev reverse proxy](./dev-reverse-proxy.md), `http://localhost:<port>` otherwise. A service with no `port` has none. |
| `rootDomain`      | The dev reverse proxy's canonical root domain, or `null` without one.                                                                                                      |
| `control`         | A [control API](./control-api.md) client bound to the session: `query.status()`, `command.service.*`, `command.infra.*`, `command.quit()`.                                  |
| `stop()`          | Quits the session if this call started it, and does nothing for a reused one.                                                                                             |

On failure it throws devtooie's error, with the log's path, after quitting a session it started.

`stackEnvironment(env = process.env)` is `env` without what a package manager script and a test
runner add to it, which would otherwise reach every service: `npm_*`, `INIT_CWD`, `NODE`,
`NODE_PATH` and `PNPM_SCRIPT_SRC_DIR`; under Vitest (`VITEST` set), `VITEST*`, `NODE_ENV`, `MODE`,
`DEV`, `PROD`, `SSR`, `BASE_URL` and `TEST`; under Jest (`JEST_WORKER_ID` set), `JEST_WORKER_ID`
and `NODE_ENV`.

## `devtooie show-config`

Print the **fully resolved config** as prettified JSON — the same object a running session serves
as `config` on [`GET /query/status`](./control-api.md) — **without a session**. Callbacks have run,
defaults are applied, `command` is normalized, and every service carries its `relativeDir`
(as written, or inferred from `serviceRootDir`) and `absoluteDir`, its resolved `port`,
`urls`, `healthcheck`, and — under the [dev reverse proxy](./dev-reverse-proxy.md) — its
`publicOrigin` (`<urlScheme>://<subdomain>.<rootDomain>[:<port>]`, or the bare root for a
`defaultService` with no `proxy`). Each infra service the config
names carries its `enabled`, its resolved `port`, its `proxy`, its `urls`, and its `publicOrigin`
the same way. The `devReverseProxy` block itself is there too, with its port, its canonical `rootDomain`,
and `rootDomains`, every root domain it routes under.

```bash
devtooie show-config                          # the whole resolved config
devtooie show-config --mode test              # resolved against that mode's .env files
devtooie show-config | jq '.services.api.publicOrigin'
devtooie show-config | jq '.services | map_values(.port)'
devtooie show-config | jq '.infra["docker-compose"].services | map_values(.publicOrigin)'
```

`--mode` selects the `.env.<mode>` files the config resolves against, exactly as for a session or
`devtooie exec`; it defaults to `development`. The config is resolved exactly once per devtooie
process, when the file loads, so this prints what a session started with the same mode runs with.
Function-valued fields (`logs.formatter`, the [`infra`](./infra.md) callbacks) have no JSON form
and are omitted, as on the control API. The `infra` block carries what was resolved — the compose
`file`, `readyTimeout`, the mode's `projectName`, and each configured service's `enabled`:

```bash
devtooie show-config | jq -r '.infra["docker-compose"].projectName'   # example-development
```

## `devtooie exec` and `devtooie run`

Run a **single one-off command with a service's exact environment** — without starting a whole
session. Think migrations, seed scripts, scrapers, or a REPL. There are two ways to say **what**
to run:

- **`devtooie exec -- <command> [args...]`** — a literal command.
- **`devtooie run <script> [-- args...]`** — a service **script or make target**, found in that
  dir's `package.json` or `Makefile` and run [the way devtooie runs a
  service](../README.md#how-a-script-is-run). Anything after `--` is forwarded to it as
  arguments. Errors if it has no such script/target.

Either way the command runs in the service's directory with that service's resolved `.env` injected and its configured `port` as `PORT` (plus `PUBLIC_ORIGIN` under the [dev reverse proxy](./dev-reverse-proxy.md)) —
exactly the environment the TUI would give it (its `.env` files and the config's
[`env.vars`](./configuration.md#envvars), per
[Environment loading](../README.md#environment-env-loading)).

The service is chosen by **where you run it** (or named explicitly with `-s`, below). By default
there's no service argument — run it from a service's directory, or any subdirectory of it:

```bash
cd apps/api
devtooie exec -- node src/migrate.ts      # run a literal command in the api service's dir
devtooie exec -- psql "$DATABASE_URI"
devtooie run start                        # run the api service's `start` script/target
devtooie run start -- --port=3001         # ...forwarding args to that script
```

**Which service** is the nearest **ancestor** directory that is a configured service (so it works
from a service dir or anywhere below it). If you're below the config root but **not** inside any
service, it falls back to the **root**: the working dir is the root and only workspace-scope
`.env` vars (and the config's `env.vars`) are loaded. It errors only if there's no `devtooie.config.*` at all (any supported
extension — `.ts`, `.mts`, `.js`, `.mjs`).

To target a service **explicitly** instead of by location, pass `-s, --service <name>` — it
overrides the cwd inference, so you can run it from anywhere:

```bash
devtooie run -s api start -- --port=3001    # target `api` regardless of where you are
devtooie exec -s api -- node src/migrate.ts
```

The command's exit code is propagated, and devtooie exits as soon as the command does.
Output is streamed to your terminal **and** teed to a fresh timestamped logfile under
`node_modules/.devtooie/logs/<mode>/` (or `--log-dir`), the same place a headless session logs.
Nothing else is printed — the terminal shows only the command's own output, so both compose in
a pipeline.

## `devtooie infra`

Drive the infra services the config declares under [`infra`](./infra.md) — the databases,
caches and brokers your application services need. Every subcommand **exits when it's done**, and
none disturbs a running dev session. (A session runs `infra up` itself, before starting the
application services.)

```bash
devtooie infra up                     # start every service, wait until ready, then exit
devtooie infra up db                  # only `db`
devtooie infra up --reset             # destroy the services first, then start them clean
devtooie infra up --reset db          # destroy and restart only `db`
devtooie infra down [services...]     # stop and remove containers; data is kept
devtooie infra destroy [services...]  # remove containers and their data
devtooie infra docker-compose ps      # Compose itself, bound to this project and mode
```

| Subcommand                 | What it does                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up [services...]`         | Starts the services (default: every [enabled](./infra.md#turning-a-service-off) one), waits until each is ready, runs its `afterReady` callback, exits `0` — or `1` if any didn't make it. They keep running. `--reset` destroys the targets first.         |
| `down [services...]`       | `docker compose down`, with Compose's output: removes the containers (and, with no services named, the network). Volumes are kept.                                                                                                                          |
| `destroy [services...]`    | Runs `beforeDestroy`, removes the services **and their data**, then runs `afterDestroy`. With services named, only what those services own; with none, the whole project — containers, volumes, networks.                                                   |
| `docker-compose [args...]` | Runs `docker compose <args>` against this project and mode, with the terminal handed over: `logs -f`, `exec db psql`, and the exit code all behave as they do with Compose directly. Runs in your current directory, so relative paths mean what you typed. |

`-m/--mode` selects the mode's `.env` files **and** its Compose project
(`<workspace directory>-<mode>`), so `devtooie --mode test infra up` runs next to the development
one. It's accepted before or after `up`/`down`/`destroy` — but for the passthrough it has to
come **before** `docker-compose`, because everything after that word is Compose's:

```bash
devtooie -m test infra docker-compose ps         # test mode's project
devtooie infra docker-compose build -m 2g        # -m here is Compose's memory limit
```

Readiness, the callbacks, and exactly what `destroy` removes are in [Infra](./infra.md).

## `devtooie logs`

Print the **current dev session's logfile** — handy for reading a headless or TUI session's
output from another terminal, or for an agent tailing progress.

```bash
devtooie logs         # print the whole current logfile and exit
devtooie logs -f      # print it, then stream new lines live (Ctrl+C to stop)
devtooie logs --path  # print just the resolved logfile path, then exit
devtooie logs --mode test  # the test-mode session's logfile
```

It reads the session of the active mode (`--mode`, default `development`), and finds its logfile
without disturbing it, in order of precedence:

1. If a session is running, it asks the instance over the [control API](control-api.md)
   (`GET /query/status` → `logFile`), so it always follows the **current** file even across
   in-session log rotation (the `t` hotkey).
2. Otherwise, the `logFile` recorded in `node_modules/.devtooie/running.<mode>.json` — the last logfile
   the session was writing (kept current across rotation) — if it still exists. This is more
   precise than scanning the directory, where a stray `devtooie exec` log could be newer.
3. Failing that, the **newest** `*.log` in the session's log directory (`logDir` from
   `running.<mode>.json`, else `node_modules/.devtooie/logs/<mode>/`).

`devtooie logs` is **strictly read-only**: it never starts, hands off, or shuts down a session.
Printing uses `cat`; `-f/--follow` uses `tail -n +1 -f` (native, so it prints the whole file
first, then follows). **Ctrl+C** stops only that `cat`/`tail` — the running session keeps going.
`--path` (mutually exclusive with `-f`) prints the resolved path instead of the contents — handy
for piping into another tool. `-f` needs the Unix `tail`/`cat` commands (macOS/Linux).

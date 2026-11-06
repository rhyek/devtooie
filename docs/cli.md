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

[`startStack()`](#a-test-suites-stack-startstack) never takes a session over unasked: with one of
its mode running, it fails, unless its `killOthers` option says to quit that one.

A session recorded as running whose process is alive but whose control API doesn't answer as that
session looks hung: starting another in its mode is refused, and `--kill-others` kills it instead
of asking it to quit. See [Finding a session](./control-api.md#finding-a-session).

## A test suite's stack: `startStack()`

`startStack()`, exported from `devtooie`, brings up a `--headless` session for a suite's global
setup under any test runner, and resolves once the infra and every service it asked for are
healthy:

```ts
import { startStack } from 'devtooie';

const stack = await startStack({ mode: 'test', services: ['web'] });
try {
  // stack.origins.web, stack.rootDomain, stack.control.query.status(), …
} finally {
  await stack.stop();
}
```

**The session is the calling process's child, and ends with it**, however that process ends: a
`stop()`, a test runner that exits or is cut off, a `kill -9`. A session started from a shell has
no such parent, and runs until it is told to stop.

**A session of the mode already running fails the call**, naming its pid. Pass `killOthers: true`
to quit it, as [`--kill-others`](#taking-over-a-running-session) does, and start this one in its
place.

| Option        | Value                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `services`    | The services to bring up, as `-s` names them. Their runtime deps and the mode's infra come too.                               |
| `mode`        | As `--mode` takes it. Unset, the mode resolves as it does for the CLI.                                                        |
| `cwd`         | Where the workspace is found from, as the CLI finds it. Defaults to `process.cwd()`.                                         |
| `waitTimeout` | How long to wait for everything to be healthy, in seconds. Defaults to `300`.                                                 |
| `logDir`      | As `--log-dir` takes it.                                                                                                      |
| `killOthers`  | Quit a session of the mode already running (or kill one that looks hung), and start this one in its place. Defaults to `false`. |
| `env`         | The environment the session starts with. Defaults to `stackEnvironment()`; given, it is used as it is.                        |

It resolves with:

| Field             | Value                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`         | `started`.                                                                                                                                                                 |
| `pid`, `port`     | The session's process and its control-API port.                                                                                                                           |
| `mode`, `logFile` | The session's mode and log.                                                                                                                                                |
| `services`        | What the session runs: the services asked for, and their runtime deps.                                                                                                    |
| `origins`         | Every configured service's origin, selected or not: its [`publicOrigin`](./configuration.md#publicorigin). A service with no `port` has none. |
| `rootDomain`      | The dev reverse proxy's canonical root domain, or `null` without one.                                                                                                      |
| `control`         | A [control API](./control-api.md) client bound to the session: `query.status()`, `events()`, `command.service.*`, `command.infra.*`, `command.quit()`.                       |
| `stop()`          | Quits the session, resolving once it has exited.                                                                                                                           |

**Healthy** is running and passing its [`healthcheck`](./configuration.md#readiness-probing); a
service with no healthcheck is healthy while it runs, and must stay up for a second before the
stack counts as up. The infra counts once every infra service is `running`. The call follows the
session's [`GET /events`](./control-api.md#get-events) to know.

**On failure it throws** devtooie's error, with the log's path, after quitting the session: when
the session exits while starting, when a selected service stops (crashes) while starting, when its
events stop arriving, or when `waitTimeout` passes, listing what isn't healthy:
`not healthy after 300s: worker`. Before its log starts, the session's own output is quoted in the
error.

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
`urls`, `healthcheck`, and its [`publicOrigin`](./configuration.md#publicorigin), where a
browser reaches it. Each infra service the config
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

Either way the command runs in the service's directory with that service's resolved `.env` injected and its configured `port` as `PORT` (plus its [public origin](./configuration.md#publicorigin) as `PUBLIC_ORIGIN`) —
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
   the session was writing (kept current across rotation) — if it still exists. A record is there
   while its session runs, and after one that was killed outright. This is more precise than
   scanning the directory, where a stray `devtooie exec` log could be newer.
3. Failing that, the **newest** `*.log` in the session's log directory (`logDir` from
   `running.<mode>.json`, else `node_modules/.devtooie/logs/<mode>/`). The logs of a session that
   has ended and wrote them elsewhere, with `--log-dir`, are in that directory.

`devtooie logs` is **strictly read-only**: it never starts, hands off, or shuts down a session.
Printing uses `cat`; `-f/--follow` uses `tail -n +1 -f` (native, so it prints the whole file
first, then follows). **Ctrl+C** stops only that `cat`/`tail` — the running session keeps going.
`--path` (mutually exclusive with `-f`) prints the resolved path instead of the contents — handy
for piping into another tool. `-f` needs the Unix `tail`/`cat` commands (macOS/Linux).

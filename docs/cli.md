# CLI usage

> Part of the [devtooie](../README.md) documentation.

```bash
devtooie                  # interactive TUI: pick packages, build, run
devtooie --plain -p web   # no TUI: run `web` (+ its deps), streaming logs
devtooie -p web -p api    # repeatable -p: run multiple named packages
devtooie --build -p web   # build `web` + its build-time deps, then exit
devtooie --rebuild -p web # like --build, but clears dist/ first
devtooie --mode test      # load .env.test instead of .env.development
```

Every command works from **anywhere in the repo**: as a first step devtooie walks up to the
nearest `devtooie.config.*`, switches to that directory, and loads its workspace-scope `.env`
— so running from a subdirectory behaves the same as running from the root.

Common options:

| Option                 | Description                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector.                                                                                                                                                                      |
| `-m, --mode <name>`    | Environment mode selecting the `.env.<mode>` files to load. Defaults to `development`. Also accepted after a subcommand (`devtooie cmd --mode test`). See [Environment loading](../README.md#environment-env-loading).                  |
| `--ui`                 | Interactive terminal UI (default). Mutually exclusive with `--plain`.                                                                                                                                                                   |
| `--plain`              | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`.                                                                                                                                           |
| `--last-answers`       | Skip selection; reuse the last saved selection. If a saved name is no longer a package (a renamed key), the picker opens instead with the surviving names preselected; `--plain`/`--build` refuse with a message naming the stale ones. |
| `--build`              | Build the selected packages and their build-time deps, then exit (no run phase).                                                                                                                                                        |
| `--rebuild`            | Like `--build`, but first clears `dist/` for every build target.                                                                                                                                                                        |
| `--log-dir <dir>`      | Write the timestamped session log into this directory. Defaults to `node_modules/.devtooie/logs/`. Each run gets a fresh `<timestamp>.log`; previous sessions' logs are kept. Also used by [`devtooie cmd`](#devtooie-cmd).             |
| `--kill-others`        | Quit a devtooie session already running for this project instead of asking. See [Taking over a running session](#taking-over-a-running-session).                                                                                        |

Subcommands:

- **`devtooie init`** — interactive setup; see [Getting started](../README.md#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie resolvedeps <package>`** — print the resolved
  build/dev/runtime dependency sets for a single package as JSON.
- **`devtooie cmd`** — run a **one-off command** with a package's environment (its dir +
  resolved `.env`); see [below](#devtooie-cmd).
- **`devtooie logs`** — print (or `-f/--follow`) the current dev session's logfile; see
  [below](#devtooie-logs).

## Taking over a running session

Only one devtooie session can run a project at a time, so starting a second one has to
quit the first — along with every dev process under it. Since 0.7.0 devtooie asks before
doing that:

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

## `devtooie show-config`

Print the **fully resolved config** as prettified JSON — the same object a running session serves
as `config` on [`GET /query/status`](./control-api.md) — **without a session**. Callbacks have run,
defaults are applied, `command` is normalized, and every package carries its `relativeDir`
(as written, or inferred from `packageRootDir`) and `absoluteDir`, its resolved `port`,
`urls`, `healthcheck`, and — under the [dev reverse proxy](./dev-reverse-proxy.md) — its
`publicOrigin` (`<urlScheme>://<subdomain>.<rootDomain>[:<port>]`). The `devReverseProxy` block
itself, port included, is there too.

```bash
devtooie show-config                          # the whole resolved config
devtooie show-config --mode test              # resolved against that mode's .env files
devtooie show-config | jq '.packages.api.publicOrigin'
devtooie show-config | jq '.packages | map_values(.port)'
```

`--mode` selects the `.env.<mode>` files the config resolves against, exactly as for a session or
`devtooie cmd`; it defaults to `development`. The config is resolved exactly once per devtooie
process, when the file loads, so this prints what a session started with the same mode runs with.
Function-valued fields (`logs.formatter`) have no JSON form and are omitted, as on the control API.

## `devtooie cmd`

Run a **single one-off command with a package's exact environment** — without starting a whole
session. Think migrations, seed scripts, scrapers, or a REPL. The command runs in the package's
directory with that package's resolved `.env` injected and its configured `port` as `PORT` (plus `PUBLIC_ORIGIN` under the [dev reverse proxy](./dev-reverse-proxy.md)) —
exactly the environment the TUI would give it (its `.env` files per
[Environment loading](../README.md#environment-env-loading)).

The package is chosen by **where you run it** (or named explicitly with `-p`, below). By default
there's no package argument — run it from a package's directory, or any subdirectory of it:

```bash
cd packages/api
devtooie cmd -- pnpm start                # run a literal command in the api package's dir
devtooie cmd -- npm run migrate
devtooie cmd -c start                      # run the api package's `start` script/target
devtooie cmd -c start -- --port=3001      # ...forwarding args to that script
```

**Which package** is the nearest **ancestor** directory that is a configured package (so it works
from a package dir or anywhere below it). If you're below the config root but **not** inside any
package, it falls back to the **root**: the working dir is the root and only workspace-scope
`.env` vars are loaded. It errors only if there's no `devtooie.config.*` at all (any supported
extension — `.ts`, `.mts`, `.js`, `.mjs`).

To target a package **explicitly** instead of by location, pass `-p, --package <name>` — it
overrides the cwd inference, so you can run it from anywhere:

```bash
devtooie cmd -p api -c start -- --port=3001    # target `api` regardless of where you are
devtooie cmd -p api -- pnpm start
```

There are two ways to say **what** to run:

- **A literal command** after `--` (e.g. `-- pnpm start`) — required unless `-c` is given.
- **`-c, --cmd <script>`** — a package **script or make target** (resolved the way devtooie runs
  a package: `pnpm run <script>` or `make <target>`), found in that dir's `package.json` or
  `Makefile`. Anything after `--` is forwarded to it as arguments. Errors if it has no such
  script/target.

The command's exit code is propagated, and `devtooie cmd` exits as soon as the command does.
Output is streamed to your terminal **and** teed to a fresh timestamped logfile under
`node_modules/.devtooie/logs/` (or `--log-dir`), the same place a `--plain` session logs.
Nothing else is printed — the terminal shows only the command's own output, so `devtooie cmd`
composes in a pipeline.

## `devtooie logs`

Print the **current dev session's logfile** — handy for reading a `--plain` or TUI session's
output from another terminal, or for an agent tailing progress.

```bash
devtooie logs         # print the whole current logfile and exit
devtooie logs -f      # print it, then stream new lines live (Ctrl+C to stop)
devtooie logs --path  # print just the resolved logfile path, then exit
```

It finds the logfile without disturbing the session, in order of precedence:

1. If a session is running, it asks the instance over the [control API](control-api.md)
   (`GET /query/status` → `logFile`), so it always follows the **current** file even across
   in-session log rotation (the `t` hotkey).
2. Otherwise, the `logFile` recorded in `node_modules/.devtooie/running.json` — the last logfile
   the session was writing (kept current across rotation) — if it still exists. This is more
   precise than scanning the directory, where a stray `devtooie cmd` log could be newer.
3. Failing that, the **newest** `*.log` in the session's log directory (`logDir` from
   `running.json`, else `node_modules/.devtooie/logs/`).

`devtooie logs` is **strictly read-only**: it never starts, hands off, or shuts down a session.
Printing uses `cat`; `-f/--follow` uses `tail -n +1 -f` (native, so it prints the whole file
first, then follows). **Ctrl+C** stops only that `cat`/`tail` — the running session keeps going.
`--path` (mutually exclusive with `-f`) prints the resolved path instead of the contents — handy
for piping into another tool. `-f` needs the Unix `tail`/`cat` commands (macOS/Linux).

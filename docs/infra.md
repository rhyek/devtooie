# Infra

> Part of the [devtooie](../README.md) documentation.

Your packages usually need things that aren't packages: a database, a cache, a message broker.
Declare them under `infra` and devtooie brings them up, waits until they're ready, and runs your
setup steps (migrations, seeding) — as a command, and at the start of every dev session.

```ts
// devtooie.config.ts
export default defineConfig({
  infra: {
    'docker-compose': {},
  },
  packages: {/* … */},
});
```

That is a complete config for a self-contained `docker-compose.yaml`. `infra` is keyed by
provider; `docker-compose` is the only one. It needs Docker with Compose v2.

```sh
devtooie infra up                     # start every service, wait until ready, then exit
devtooie infra up db                  # only `db`
devtooie infra up --reset             # destroy the services first, then start them clean
devtooie infra up --reset db          # destroy and restart only `db`
devtooie infra down [services...]     # stop and remove containers; data is kept
devtooie infra destroy [services...]  # remove containers *and* their data
devtooie infra docker-compose ps      # Compose itself, bound to this project and mode
devtooie --mode test infra up         # the test mode's own project, ports and env
```

Every one of these exits when it's done. None stays up streaming logs.

- [In a dev session](#in-a-dev-session)
- [Config](#config)
- [Turning a service off](#turning-a-service-off)
- [Callbacks](#callbacks)
- [Modes: one Compose project each](#modes-one-compose-project-each)
- [Commands](#commands)
- [Readiness](#readiness)
- [What destroy removes](#what-destroy-removes)

## In a dev session

`devtooie` (the TUI or `--plain`) runs the same `up` **after building and before starting the
packages**, for every enabled service. The startup screen shows a row per service while it happens, and
the footer lists them once the session is running:

```
● api  ● web
← →: select │ r: restart  b: rebuild  s: stop  m: commands

infra:  ● db  ● redis
cwd: example  git: main
```

- **Quitting devtooie leaves the services running**, so the next start finds them up and takes
  well under a second.
- **A service that doesn't come up stops the session.** The packages aren't started against
  infrastructure that isn't there; you get the service, the reason, and the tail of its logs.
- What infra printed on the way up is at the top of the session log, as `[infra:<service>]`
  lines (type `infra` in the `f` filter to see only those).
- The footer dots are a record of startup, not a monitor: nothing watches the containers
  afterwards.

`--build`, `devtooie cmd`, `show-config`, `logs` and the other subcommands never touch infra.

## Config

```ts
infra: {
  'docker-compose': {
    file: './docker-compose.yaml', // optional
    readyTimeout: 300_000,         // optional, ms
    services: {                    // optional — keys are Compose service names
      db: {
        isEnabled: ({ mode }) => mode !== 'test',
        afterDestroy: async (ctx) => {},
        beforeUp: async (ctx) => {},
        afterReady: async (ctx) => {},
      },
    },
  },
}
```

| Field          | Meaning                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`         | The compose file, relative to `workspaceDir`. Omit it and Compose discovers the file itself (`compose.yaml`, `docker-compose.yaml`, plus any override file).                                                                                                            |
| `readyTimeout` | How long `up` waits for the services to become ready, in ms. Default: 5 minutes.                                                                                                                                                                                        |
| `services`     | Per-service options, keyed by Compose service name: [`isEnabled`](#turning-a-service-off) and the [callbacks](#callbacks). A service doesn't have to be listed to run. A key that isn't a service in the compose file is an error, reported before anything is started. |

**Which services run:** all the services Compose reports for the file — minus any you
[turn off](#turning-a-service-off) — or the ones you name on the command line.

**Readiness, ports, images, volumes — all of it lives in the compose file.** devtooie hands
Compose the mode's environment, so the file can interpolate it:

```yaml
services:
  db:
    image: postgres:18.6
    ports:
      - '${DB_PORT}:5432' # DB_PORT from .env.development, or .env.test under --mode test
    healthcheck:
      test: ['CMD', 'pg_isready', '-h', '127.0.0.1']
```

## Turning a service off

`isEnabled` decides whether devtooie runs a service. It's a boolean, or a callback over the mode
and the environment:

```ts
services: {
  // not in test mode
  emulator: { isEnabled: ({ mode }) => mode !== 'test' },
  // only when its API key is set
  tracing: { isEnabled: ({ envs }) => Boolean(envs.TRACING_API_KEY) },
}
```

The callback gets `{ mode, envs, tokens }` — `envs` being the workspace-scope `.env` files for
the mode over the ambient environment — and must return a real boolean. Like the config's other
callbacks (`port`, `urls`) it's synchronous and runs once, when the config loads, so
`devtooie show-config` shows the answer:

```sh
devtooie --mode test show-config | jq '.infra["docker-compose"].services'
# { "emulator": { "isEnabled": false }, "tracing": { "isEnabled": true } }
```

A disabled service is left out of `infra up` and of a dev session, isn't in the footer, and its
callbacks don't run. Naming it — `devtooie infra up emulator` — is an error that says it's
disabled. It can still be destroyed by name, to clean up after a mode where it ran.

Two things `isEnabled` doesn't do:

- **It doesn't override `depends_on`.** If an enabled service depends on a disabled one, Compose
  starts both.
- **It doesn't stop a container that's already running.** It only decides what devtooie starts.

Compose's own [profiles](https://docs.docker.com/compose/how-tos/profiles/) are the other way
to do this — `COMPOSE_PROFILES=…` in a mode's `.env` file — and they do hide a service from
Compose entirely.

## Callbacks

Optional and async. They run **around** devtooie's built-in steps — they don't replace them —
and each is named for when it runs:

| Callback       | Runs                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afterDestroy` | After the service's container and volumes are removed: on `infra destroy` and on `infra up --reset`. For state Compose can't see, such as a bind-mounted directory.             |
| `beforeUp`     | On every `infra up`, after any destroy and before the services are started. If one fails, nothing is started.                                                                   |
| `afterReady`   | On every `infra up`, once the service is ready — **including when it was already running**, and so at every session start. For migrations and seeding. It has to be idempotent. |

`afterReady` runs every time on purpose: pull a branch with new migrations, start a session,
and they're applied — even though the database never stopped.

So the full order of `infra up --reset db` is: destroy → `afterDestroy` → `beforeUp` → start →
wait until ready → `afterReady`.

```ts
db: {
  afterReady: async ({ run, reset }) => {
    await run('pnpm', ['migrate'], { cwd: 'packages/db' });
    if (reset) {
      await run('pnpm', ['seed'], { cwd: 'packages/db' });
    }
  },
},
```

Each callback receives one object:

| Field          | What it is                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `service`      | The Compose service this callback belongs to.                                                                                       |
| `mode`         | The active mode (`development`, `test`, …).                                                                                         |
| `reset`        | `true` when this run is `infra up --reset`. Always `false` under `infra destroy`.                                                   |
| `workspaceDir` | The workspace root, absolute.                                                                                                       |
| `envs`         | The workspace-scope `.env` files for the mode merged over the ambient environment, plus `COMPOSE_PROJECT_NAME`.                     |
| `tokens`       | The config's top-level [`tokens`](./configuration.md#typed-tokens), typed from what you declared.                                   |
| `compose`      | `compose(args, opts?)` — runs `docker compose <args>` against this project: `await compose(['exec', '-T', 'db', 'psql', '-c', …])`. |
| `run`          | `run(command, args?, opts?)` — runs any other command.                                                                              |
| `log`          | `log(message)` — writes a line to devtooie's infra output.                                                                          |

`compose` and `run` take `{ cwd?, env?, reject? }` and resolve with
`{ exitCode, stdout, stderr }`:

- `cwd` is relative to the workspace root, which is the default.
- `env` is merged over `envs`.
- A non-zero exit **rejects** — which fails the service — unless you pass `reject: false`.

**Use `compose`, `run` and `log` for anything a callback prints or spawns.** Their output goes
where devtooie is showing infra output: the terminal for `infra up`, the startup screen and the
session log for the TUI. A child process you spawn yourself with inherited stdio draws straight
over the TUI.

A callback that throws fails its service: an `afterReady` failure fails only that service, while
an `afterDestroy` or `beforeUp` failure stops the run before anything is started.

## Modes: one Compose project each

devtooie sets the Compose project name to **`<workspace directory>-<mode>`** — `example-development`,
`example-test` — so each [mode](../README.md#modes) is its own project, with its own containers,
volumes and network. `devtooie infra up` and `devtooie --mode test infra up` run side by side,
each with the ports from its own `.env.<mode>` file.

(Compose's default name is the directory alone. Two modes would then share one project, and
bringing the test one up would recreate the development containers on the test ports.)

To choose the name yourself, set `COMPOSE_PROJECT_NAME` in an `.env` file; devtooie uses it
as is. A top-level `name:` in the compose file is overridden either way.

Because the name isn't Compose's default, a bare `docker compose ps` in the directory won't find
these containers. Use the [passthrough](#devtooie-infra-docker-compose-args).

## Commands

All of them accept `-m/--mode`, before or after the subcommand, and none disturbs a running dev
session.

### `devtooie infra up [services...] [--reset]`

Starts the services (all the enabled ones, or the ones named), waits until each is
[ready](#readiness), runs `afterReady`, and exits — `0` if every service made it, `1` otherwise. The services keep
running.

```
▶ infra (development): db, redis
  redis  ready (0.4s)
[db] 2 migrations applied
  db     ready (3.1s)
✔ infra ready (3.1s)
```

`--reset` [destroys](#what-destroy-removes) the targets first. Once the services are starting,
one failing doesn't stop the others; a failed container's report includes the tail of its logs.

### `devtooie infra down [services...]`

`docker compose down [services...]`, with Compose's own output. Removes the containers — and,
with no services named, the project's network. **Volumes are kept**, so the data is there on
the next `up`. No callbacks.

### `devtooie infra destroy [services...]`

Removes the services **and their data**, then runs `afterDestroy`. See
[What destroy removes](#what-destroy-removes).

### `devtooie infra docker-compose [args...]`

Compose itself, against this project and mode. Everything after `docker-compose` is handed to
`docker compose` untouched, with the terminal: `exec db psql`, `logs -f` and colors behave
exactly as they do when you run Compose directly, and the exit code is Compose's.

```sh
devtooie infra docker-compose ps
devtooie infra docker-compose logs -f db
devtooie infra docker-compose exec db psql -U example
cd packages/db && devtooie infra docker-compose cp ./dump.sql db:/tmp/  # relative to where you are
```

**The mode goes before `docker-compose`**: `devtooie -m test infra docker-compose ps`. After that
word every flag is Compose's — `docker compose build -m` is a memory limit.

## Readiness

A service is ready when its container is:

- `running` and **`healthy`**, if the compose file gives it a `healthcheck`;
- `running`, if it has none;
- `exited` with code **0** — a one-shot service (an init or migration container) that finished.

It has failed when it is `unhealthy`, exited non-zero, or `dead`; and when it still isn't ready
after `readyTimeout`.

That's the whole definition: devtooie adds no probe of its own, so **give a service a
`healthcheck`** when "the container is running" isn't the same as "it accepts connections". For
anything beyond that, wait in `afterReady`.

Only the service's own containers count: a one-off `docker compose run` container left open in
another terminal is ignored.

A container with no healthcheck that this run just started is only called ready the second time
devtooie finds it running — one that crashes on startup still reads as `running` for a moment.
One that was already running is ready on the first look, so a repeat `up` stays quick.

## What destroy removes

What `infra destroy` removes depends on whether you name services:

| You name…   | What goes                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no services | **The whole project**, disabled services' leftovers included: every container, the named volumes the file declares, anonymous volumes, the project's networks, and orphan containers. |
| services    | Those services' containers, their anonymous volumes, and the **named volumes only they mount**. The network stays — the other services are on it.                                     |

When you name services, devtooie leaves alone — and tells you about — a volume another service
also mounts, an `external` volume, and one a container outside the file still holds. It never
runs `docker compose down <service> --volumes`, which would also delete the volumes of every
other service whose container doesn't currently exist.

`infra up --reset` always works the second way, on exactly the services it is about to start —
all the enabled ones when you name none. It never takes the whole project, so a service that is
[turned off](#turning-a-service-off) keeps its data through a reset; only `infra destroy` with no
services named removes that too.

Never removed: images, `external` volumes and networks, the volumes of services in a Compose
profile that isn't active, and bind-mounted host directories. Clean the last of those up in
`afterDestroy`.

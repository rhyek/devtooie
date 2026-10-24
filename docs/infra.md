# Infra

> Part of the [devtooie](../README.md) documentation.

Your application services usually need infra services alongside them: a database, a cache, a
message broker. Declare them under `infra` and devtooie brings them up, waits until they're
ready, and runs your setup steps (migrations, seeding) — as a command, and at the start of every dev session.

```ts
// devtooie.config.ts
export default defineConfig({
  infra: {
    'docker-compose': true,
  },
  services: {/* … */},
});
```

That is a complete config for a self-contained `docker-compose.yaml`; `true` is short for `{}`,
the block the options below go in. `infra` is keyed by
provider; `docker-compose` is the only one. It needs Docker with Compose v2.

For a working setup to copy from, see the
[`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo: a Postgres service in
`docker-compose.yaml` with a healthcheck, its connection values in the mode's `.env` file (read
by Compose, and by the app as `DATABASE_URI`), and an `afterReady` in `devtooie.config.ts` that
migrates on every start and seeds a fresh database.

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

`devtooie` (the TUI or `--headless`) runs the same `up` **after building and before starting the
application services**, for every enabled infra service. The startup screen shows a row per
infra service while it happens, and the footer lists them once the session is running:

```
←→↑↓: select │ r: restart  b: rebuild  s: stop  m: commands
● api  ● web
infra:  ● db  ● redis

cwd: example  git: main
```

- **Quitting devtooie leaves the infra services running**, so the next start finds them up and takes
  well under a second.
- **An infra service that doesn't come up stops the session.** The application services aren't
  started against infrastructure that isn't there; you get the infra service, the reason, and the tail of its logs.
- What infra printed on the way up is at the top of the session log, as `[infra:<service>]`
  lines (type `infra` in the `f` filter to see only those).
- **Each infra service's dot is its live state**: green running, yellow (pulsing) starting or while
  an action runs on it, red stopped. It follows the containers themselves, so one stopped
  outside devtooie turns red within a second or two.
- **Select an infra service with the arrow keys** — `←`/`→` walk the application services and then
  the infra services, `↑`/`↓` move between the rows — and its hotkeys replace the application
  service ones:
  - `s` — start or stop it (`devtooie infra up` / `down`).
  - `r` — restart it: `down`, then `up`, so the container is recreated and its data kept.
  - `t` — reset it (`infra up --reset`), which **deletes its data**, so it asks for a second
    `t` to confirm.

  Their output goes into the session log under `[infra:<service>]`. The control API runs the
  same actions — see [Control API](./control-api.md).
- A service's [`urls`](#a-services-footer-links) are in the footer's link column, under an `infra`
  caption.

`--build`, `devtooie exec`, `run`, `show-config`, `logs` and the other subcommands never touch infra.

## Config

```ts
infra: {
  'docker-compose': {
    file: './docker-compose.yaml', // optional
    readyTimeout: 300_000,         // optional, ms
    services: {                    // optional — keys are Compose service names
      db: {
        enabled: ({ mode }) => mode !== 'test',
        port: ({ envs }) => Number(envs.DB_PORT), // optional: the host port, for `proxy`
        proxy: { subdomain: 'db' },               // optional: route it through devReverseProxy
        urls: [''],                               // optional: footer links
        beforeDestroy: async (ctx) => {},
        afterDestroy: async (ctx) => {},
        beforeUp: async (ctx) => {},
        afterReady: async (ctx) => {},
      },
    },
  },
}
```

| Field          | Meaning                                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`         | The compose file, relative to `workspaceDir`. Omit it and Compose discovers the file itself (`compose.yaml`, `docker-compose.yaml`, plus any override file).                                                                                                          |
| `readyTimeout` | How long `up` waits for the services to become ready, in ms. Default: 5 minutes.                                                                                                                                                                                      |
| `services`     | Per-service options, keyed by Compose service name: [`enabled`](#turning-a-service-off), [`port` and `proxy`](#reaching-a-service-through-the-dev-reverse-proxy), [`urls`](#a-services-footer-links), and the [callbacks](#callbacks). A service doesn't have to be listed to run. A key that isn't a service in the compose file is an error, reported before anything is started. |

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

`enabled` decides whether devtooie runs a service. It's a boolean, or a callback over the mode
and the environment:

```ts
services: {
  // not in test mode
  emulator: { enabled: ({ mode }) => mode !== 'test' },
  // only when its API key is set
  tracing: { enabled: ({ envs }) => Boolean(envs.TRACING_API_KEY) },
}
```

The callback gets `{ mode, envs, tokens }` — `envs` being the mode's workspace-scope `.env` files
and the ambient environment, where the ambient environment wins over the files — and must return
a real boolean. Like the config's other
callbacks (`port`, `urls`) it's synchronous and runs once, when the config loads, so
`devtooie show-config` shows the answer:

```sh
devtooie --mode test show-config | jq '.infra["docker-compose"].services'
# { "emulator": { "enabled": false }, "tracing": { "enabled": true } }
```

A disabled service is left out of `infra up` and of a dev session, isn't in the footer, and its
callbacks don't run. Naming it — `devtooie infra up emulator` — is an error that says it's
disabled. It can still be destroyed by name, to clean up after a mode where it ran.

Two things `enabled` doesn't do:

- **It doesn't override `depends_on`.** If an enabled service depends on a disabled one, Compose
  starts both.
- **It doesn't stop a container that's already running.** It only decides what devtooie starts.

Compose's own [profiles](https://docs.docker.com/compose/how-tos/profiles/) are the other way
to do this — `COMPOSE_PROFILES=…` in a mode's `.env` file — and they do hide a service from
Compose entirely.

## Reaching a service through the dev reverse proxy

A service a browser has to reach — an S3-compatible object store, a mail catcher's web UI —
can be routed by the [dev reverse proxy](./dev-reverse-proxy.md) at `<subdomain>.<rootDomain>`,
like an application service. Give it a `port` and a `proxy`:

```ts
services: {
  // signed GET URLs and presigned POST forms cover the Host header, which the proxy keeps
  store: { port: ({ envs }) => Number(envs.STORE_PORT), proxy: { subdomain: 's3' } },
  mail: { port: 21054, proxy: { subdomain: true } }, // true: the service's key, `mail`
}
```

- **`port`** is the port the service answers on at `localhost` — the host side of its port
  mapping. devtooie doesn't read it from the compose file. A literal, or a callback over the
  workspace context `{ envs, tokens }`, resolved once at load like an application service's `port`; it isn't
  resolved for a disabled service. It equals no application service's port, no other infra service's, and not the
  proxy's.
- **`proxy`** is the same block an application service takes — `subdomain` is a label, an array of them (the
  first canonical, the rest aliases), or `true` for the service's key — and requires `port`.
  Its subdomains are unique across application and infra services. See
  [`proxy`](./dev-reverse-proxy.md#proxy).

These are options of the service, not of the provider, so they mean the same for every
provider. A disabled service is not routed. Until a session's infra step has finished, its
hostnames answer 503 `starting`; after it they are forwarded, and a refused or reset connection
gets a 502 naming the service and its port. Only a session runs the proxy — `infra up` doesn't.

The resolved `port`, `proxy` and `publicOrigin` are on the exported config, so `devtooie
show-config` shows them:

```sh
devtooie show-config | jq '.infra["docker-compose"].services.mail'
# { "enabled": true, "port": 21054, "proxy": { "subdomain": "mail" }, "publicOrigin": "http://mail.localhost:21050" }
```

## A service's footer links

A service shows links in the footer's link column only when it lists them in `urls`, which
takes the same entries as an application service's [`urls`](./configuration.md):

```ts
services: {
  mail: { port: 21054, proxy: { subdomain: true }, urls: [''] }, // the web UI, at its origin
  store: { port: 9000, urls: [{ label: 'console', url: '/minio' }] },
}
```

- **A path** — `''` for the origin itself, `'/inbox'` for a page on it — is based on the
  service's public origin when the [dev reverse proxy](#reaching-a-service-through-the-dev-reverse-proxy)
  routes it, else on `http://localhost:<port>`. A path needs `port`; a full URL doesn't.
- **A callback** gets `{ envs, tokens, port, subdomain }`, as an application service's does.
- **The footer lists them under an `infra` caption**, below the application services' links. A service whose
  `urls` is one unlabelled link shows its name as that link; otherwise its name heads its
  lines, as an application service's does.
- **A disabled service shows none**, and its `urls` aren't resolved.

## Callbacks

Optional and async. They run **around** devtooie's built-in steps — they don't replace them —
and each is named for when it runs:

| Callback        | Runs                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeDestroy` | Before the service's container and volumes are removed: on `infra destroy` and on `infra up --reset`. For whatever has to let go of the data first, such as an application service holding connections to it. If one fails, nothing is removed. |
| `afterDestroy`  | After the service's container and volumes are removed: on `infra destroy` and on `infra up --reset`. For state Compose can't see, such as a bind-mounted directory.                                                                             |
| `beforeUp`      | On every `infra up`, after any destroy and before the services are started. If one fails, nothing is started.                                                                                                                                   |
| `afterReady`    | On every `infra up`, once the service is ready — **including when it was already running**, and so at every session start. For migrations, which have to be idempotent, and for seeding behind [`fresh`](#seeding-fresh).                       |

`afterReady` runs every time on purpose: pull a branch with new migrations, start a session,
and they're applied — even though the database never stopped.

So the full order of `infra up --reset db` is: `beforeDestroy` → destroy → `afterDestroy` →
`beforeUp` → start → wait until ready → `afterReady`.

```ts
db: {
  afterReady: async ({ run, fresh }) => {
    await run('pnpm', ['migrate'], { cwd: 'libs/db' }); // every time: idempotent
    if (fresh) {
      await run('pnpm', ['seed'], { cwd: 'libs/db' }); // only into a new database
    }
  },
},
```

Each callback receives one object:

| Field          | What it is                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`      | The Compose service this callback belongs to.                                                                                                                                                                                                                                                                                                                                   |
| `mode`         | The active mode (`development`, `test`, …).                                                                                                                                                                                                                                                                                                                                     |
| `reset`        | `true` when this run is `infra up --reset`. Always `false` under `infra destroy`.                                                                                                                                                                                                                                                                                               |
| `fresh`        | **`afterReady` only.** `true` when this run created the service's data — see [Seeding: `fresh`](#seeding-fresh).                                                                                                                                                                                                                                                                |
| `workspaceDir` | The workspace root, absolute.                                                                                                                                                                                                                                                                                                                                                   |
| `envs`         | This mode's environment: the config's own [`env.vars`](./configuration.md#envvars), the workspace-scope `.env` files and the ambient environment — **the ambient environment wins over the others**, except for the variables `env.override` names ([Environment loading](../README.md#environment-env-loading)) — plus `COMPOSE_PROJECT_NAME`. It includes `DEVTOOIE_MODE`. It is the environment `run` and `compose` give their commands. |
| `tokens`       | The config's top-level [`tokens`](./configuration.md#typed-tokens), typed from what you declared.                                                                                                                                                                                                                                                                               |
| `compose`      | `compose(args, opts?)` — runs `docker compose <args>` against this project, with `envs` as its environment: `await compose(['exec', '-T', 'db', 'psql', '-c', …])`.                                                                                                                                                                                                             |
| `run`          | `run(command, args?, opts?)` — runs any other command, with `envs` as its environment: a migration or seed script gets the mode's variables and `DEVTOOIE_MODE` with nothing passed by hand.                                                                                                                                                                                    |
| `log`          | `log(message)` — writes a line to devtooie's infra output.                                                                                                                                                                                                                                                                                                                      |
| `control`      | A client for this config's running dev session, in this mode, or `undefined` when none is running — see [Driving the session: `control`](#driving-the-session-control).                                                                                                                                                                                                         |
| `data`         | An object the service's callbacks share for the run, empty when it starts: what `beforeDestroy` writes to it, `afterReady` reads. Nothing is kept between runs. See [Driving the session: `control`](#driving-the-session-control).                                                                                                                                             |

### Seeding: `fresh`

`afterReady` runs on every `up`, so a seeder needs to know whether the database is new.
`fresh` says so: it's `true` when **this run created the service's data**.

| What happened                     | `fresh` |
| --------------------------------- | ------- |
| The service's first start ever    | `true`  |
| `infra up` again, already running | `false` |
| `infra down`, then `infra up`     | `false` |
| `infra destroy`, then `infra up`  | `true`  |
| `infra up --reset`                | `true`  |

devtooie goes by the service's **named volumes**: `fresh` means none of them existed before this
run started the service. That's why `down` and `up` isn't fresh — the container is new, the data
isn't. A service with no named volume keeps its data in the container, so it's fresh when it had
no container. (Data in a bind-mounted host directory is invisible to devtooie: such a service
goes by its container too.)

`fresh` describes this run and nothing is remembered between runs. So **if `afterReady` fails on
the run where `fresh` is `true`** — the migration errors before the seed — it's `false` the next
time, and the seed doesn't run. Give the service a clean start with
`devtooie infra up --reset <service>`.

`reset` is narrower: it's `true` only when this run was `infra up --reset`, in every callback
of the run. Use `fresh` to seed; `reset` is for a step that belongs to a deliberate reset and
nothing else, such as [stopping an application service around it](#driving-the-session-control).

### The helpers

`compose` and `run` take `{ cwd?, env?, reject? }` and resolve with
`{ exitCode, stdout, stderr }`:

- `cwd` is relative to the workspace root, which is the default.
- `env` adds to `envs`, or overrides it, for that one command.
- A non-zero exit **rejects** — which fails the service — unless you pass `reject: false`.

**A command started with `run` or `compose` gets `envs` as its whole environment**, with any `env`
option merged on top. That includes `DEVTOOIE_MODE`, the config's `env.vars`, and everything in
the mode's workspace-scope `.env` files, so a migration or seed script sees the same
`DATABASE_URL` and the same mode the application services do, with nothing passed by hand:

```ts
// DATABASE_URL and DEVTOOIE_MODE are already in the script's environment
await run('pnpm', ['seed'], { cwd: 'libs/db' });
```

Two limits:

- **It is the workspace scope only.** A variable defined in an application service's own `.env`
  file isn't in `envs` — setting `cwd` to that service doesn't add it — and neither are the `PORT`
  and `PUBLIC_ORIGIN` devtooie injects into an application service's process. Pass those with `env`, or keep what
  a callback needs in the workspace-scope files.
- **`compose` always runs against this project.** Its `env` option can't change
  `COMPOSE_PROJECT_NAME`.

**Use `compose`, `run` and `log` for anything a callback prints or spawns.** Their output goes
where devtooie is showing infra output: the terminal for `infra up`, the startup screen and the
session log for the TUI. A child process you spawn yourself with inherited stdio draws straight
over the TUI.

A callback that throws fails its service: an `afterReady` failure fails only that service, a
`beforeDestroy` failure stops the run before anything is removed, and an `afterDestroy` or
`beforeUp` failure stops it before anything is started.

### Driving the session: `control`

`control` is a client for the dev session running for this config, in this mode: the
[control API](./control-api.md), with its methods named after the endpoint paths. It is
`undefined` when no such session is running — `infra up` from a terminal with no session up,
say — so reach it with `?.`.

| Method                                    | Endpoint                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `control.query.status()`                  | `GET /query/status` — resolves with the snapshot, or `null` if the session didn't answer.          |
| `control.command.service.<action>(name)`  | `POST /command/service/<action>/<name>`, `<action>` being `start`, `stop`, `restart` or `rebuild`. |
| `control.command.infra.<action>(service)` | `POST /command/infra/<action>/<service>`, `<action>` being `start`, `stop`, `restart` or `reset`.  |
| `control.command.quit()`                  | `POST /command/quit`                                                                               |

The `command` methods resolve `true` when the session accepted the command, and `false` when it
didn't: an application service that isn't in the config, or one that couldn't be added to the
session; an infra service the session doesn't have; or one busy with another action.
`service.start` and `service.stop` resolve once they're done — `stop` once the application
service's process has exited — and are `true` for one already started or stopped. The others
resolve once the command is accepted; `query.status()` shows where it ends. The `service`
methods take your application service names, typed once you
[register them](./configuration.md#advanced-typed-service-names).

The case it's for: an application service that holds on to an infra service's data while it runs — connections to a
database, a job queue whose schema it creates when it boots. A reset pulls the data out from
under it. Stop it before the destroy, if it was running, and start it again once the new
database is migrated and seeded:

```ts
db: {
  beforeDestroy: async ({ reset, control, data }) => {
    const status = await control?.query.status();
    if (reset && status?.services?.api === 'running') {
      data.apiWasRunning = await control?.command.service.stop('api');
    }
  },
  afterReady: async ({ run, fresh, control, data }) => {
    await run('pnpm', ['migrate'], { cwd: 'libs/db' });
    if (fresh) {
      await run('pnpm', ['seed'], { cwd: 'libs/db' });
    }
    if (data.apiWasRunning) {
      await control?.command.service.start('api');
    }
  },
},
```

`data` ties the two together: it's one object for all of a service's callbacks in a run, so
what `beforeDestroy` writes there, `afterReady` reads. An application service that was already
stopped is left stopped. The next run's `data` starts empty, and each infra service has its own.

- **It only drives this project's session.** A session's record outlives it, and every
  project's control API takes its port from the same range, so devtooie binds `control` only to
  a session that reports this config file and this mode. Anything else is `undefined`.
- **At a session's own start the application services aren't running yet.** The session brings
  its infra up first, so `status.services` is `null` there and the `service` methods resolve
  `false`. The
  example above acts on a reset made while the session runs: the footer's `t`,
  `POST /command/infra/reset/db`, or `devtooie infra up --reset db` from another terminal.
- **Leave the callback's own infra service alone.** A run the session started — from the footer
  or the control API — keeps the infra service busy until its callbacks end, so `command.infra.*` on it
  resolves `false`; from a terminal it would start a second run on a service still in this one.
- **An application service stopped in `beforeDestroy` stays stopped if the run fails before
  `afterReady` starts it** — in the destroy, `beforeUp`, the start, or a migration that throws
  first. Start it from the footer (`s`) or with `POST /command/service/start/<name>`.
- **Don't `quit()` from a callback**: the session ends the run that is calling it.

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

Runs `beforeDestroy`, removes the services **and their data**, then runs `afterDestroy`. See
[What destroy removes](#what-destroy-removes).

### `devtooie infra docker-compose [args...]`

Compose itself, against this project and mode. Everything after `docker-compose` is handed to
`docker compose` untouched, with the terminal: `exec db psql`, `logs -f` and colors behave
exactly as they do when you run Compose directly, and the exit code is Compose's.

```sh
devtooie infra docker-compose ps
devtooie infra docker-compose logs -f db
devtooie infra docker-compose exec db psql -U example
cd libs/db && devtooie infra docker-compose cp ./dump.sql db:/tmp/  # relative to where you are
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

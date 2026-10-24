---
name: devtooie
description: Use when you need to know whether an app, service, or dev server in this repo is currently running or already started — e.g. "is the backend up?", or before launching one yourself — INCLUDING when you don't yet know whether devtooie manages that app, or whether this repo uses devtooie at all (the guide covers how to tell, and how to check an app devtooie does not manage); when you need to reach an application service or a proxied infra service (an object store, a mail catcher's web UI) — find the URL, hostname, port, or public origin an app or API is served at, to call it with curl or fetch, open it in a browser, or point another service at it (never guess a port or hostname: `devtooie show-config` prints the resolved ones); when running, building, or restarting a local dev service through devtooie, or starting a dev stack in the background for tests (`--headless --detach --wait`, or `startStack()` from a test runner's global setup); when you need the project's local infrastructure — a database, cache, broker, or any other Docker Compose service — started, stopped, reset, or inspected, or before running `docker compose` yourself in this repo (devtooie binds Compose to a per-mode project, so a bare `docker compose` lands on the wrong one: use `devtooie infra`); when asked to add, configure, or onboard a service into devtooie; when asked to improve or restructure a Node/TypeScript monorepo for devtooie — e.g. converting workspace packages to TypeScript project references and reshaping their dev/build/clean scripts to be more devtooie-compatible; when you need to know how to handle a service's lifecycle (whether to restart or rebuild it) after changing its code; or when debugging a running service by reading its logs.
---

# devtooie

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. It can
be driven headlessly, controlled over an HTTP API, taught about new services, and
queried for logs while a session runs.

> **Stop and restart sessions through the control API — never `kill`, `pkill`, or
> `lsof … | kill` a devtooie process or its port.** To stop a running session,
> `POST /command/quit` (to the API port in `node_modules/.devtooie/running.<mode>.json`, e.g.
> `running.development.json`); it shuts
> every service down gracefully and frees the ports — that's all you need before relaunching. To
> restart one service in place without stopping the session, `POST /command/service/restart/<name>`.
> Reaching for a raw OS kill is a mistake: it kills the process out from under devtooie and
> looks like the session "died" on its own.

If you need to **reach a service** — its URL, hostname, or port, to `curl` it or open it — run
`devtooie show-config` (no session needed) and read that service's `publicOrigin` (the hostname it
is served at, via devtooie's dev reverse proxy) or its `port` on localhost. The guide's _"Reach a
service"_ section says which to use and how. Never guess a port or hostname.

If you need the project's **database or other infrastructure** — to start it, reset it, or look
at it — use `devtooie infra` (`up`, `down`, `destroy`, and `docker-compose <args>` for Compose
itself), never a bare `docker compose`: devtooie puts the mode in the Compose project name, so a
bare command talks to a different, empty project. `infra up --reset` and `infra destroy` delete
data — only on request. The guide's _"Infra"_ section has the details.

If all you need is **whether an app is already running**, read the guide's _"Is the app already
running?"_ section — it covers how to tell whether devtooie manages that app in the first place,
how to read a live session's per-service state, and how to check an app devtooie doesn't manage.
Do it before starting anything: a new session hands off from (and shuts down) a running one.

The consolidated guide ships inside the installed `devtooie` package, so it always matches the
version currently in `node_modules`. It covers driving devtooie headlessly, the control API,
onboarding a service, reading logs, and the full configuration/CLI/API reference.

**Read it now, before acting**, with the Read tool:

```
${CLAUDE_PROJECT_DIR}/node_modules/devtooie/docs/agents.md
```

That should already read as an absolute path. If it still shows an unresolved placeholder, your
harness does not substitute them — read `node_modules/devtooie/docs/agents.md` resolved from the
repository root instead, NOT from this skill's own directory, which has no `node_modules` under it.

Nothing loads the guide for you. That path is deliberately not an `@` reference: `@` force-loads
the whole file, which defeats the progressive disclosure a skill exists to provide. If you have not
run Read, you have not seen it.

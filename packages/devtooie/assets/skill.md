---
name: devtooie
description: Use when running, building, or restarting a local dev package through devtooie; when asked to add, configure, or onboard a package into devtooie; when asked to improve or restructure a Node/TypeScript monorepo for devtooie — e.g. converting packages to TypeScript project references and reshaping their dev/build/clean scripts to be more devtooie-compatible; when you need to know how to handle a package's lifecycle (whether to restart or rebuild it) after changing its code; or when debugging a running package by reading its logs.
---

# devtooie

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. It can
be driven headlessly, controlled over an HTTP API, taught about new packages, and
queried for logs while a session runs.

> **Stop and restart sessions through the control API — never `kill`, `pkill`, or
> `lsof … | kill` a devtooie process or its port.** To stop a running session, `POST
> /command/quit` (to the API port in `node_modules/.devtooie/running.json`); it shuts every
> package down gracefully and frees the ports — that's all you need before relaunching. To
> restart one package in place without stopping the session, `POST /command/restart/<name>`.
> Reaching for a raw OS kill is a mistake: it kills the process out from under devtooie and
> looks like the session "died" on its own.

The consolidated guide below ships inside the installed `devtooie` package, so it always
matches the version currently in `node_modules`. Read it before acting — it covers driving
devtooie headlessly, the control API, onboarding a package, reading logs, and the full
configuration/CLI/API reference:

@node_modules/devtooie/docs/agents.md

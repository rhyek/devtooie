---
name: devtooie
description: Use when running, building, or restarting a local dev package through devtooie; when asked to add, configure, or onboard a package into devtooie; when you need to know how to handle a package's lifecycle (whether to restart or rebuild it) after changing its code; or when debugging a running package by reading its logs.
---

# devtooie

devtooie is a dependency-aware CLI that runs a monorepo's local dev processes. It can
be driven headlessly, controlled over an HTTP API, taught about new packages, and
queried for logs while a session runs.

The README and usage guide below both ship inside the installed `devtooie` package, so
they always match the version currently in `node_modules`. Read both before acting — the
README is the full configuration reference; the usage guide covers driving devtooie
headlessly, the control API, onboarding a package, and reading logs:

@node_modules/devtooie/README.md

@node_modules/devtooie/docs/usage-guide.md

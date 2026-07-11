# CLI usage

> Part of the [devtooie](../README.md) documentation.

```bash
devtooie                  # interactive TUI: pick packages, build, run
devtooie --plain -p web   # no TUI: run `web` (+ its deps), streaming logs
devtooie -p web -p api    # repeatable -p: run multiple named packages
devtooie --build -p web   # build `web` + its build-time deps, then exit
devtooie --rebuild -p web # like --build, but clears dist/ first
```

Common options:

| Option                 | Description                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-p, --package <name>` | Repeatable. Package(s) to run, bypassing the interactive selector.                                           |
| `--ui`                 | Interactive terminal UI (default). Mutually exclusive with `--plain`.                                        |
| `--plain`              | No TUI — stream logs to stdout with colored name prefixes. Requires `-p` or `--last-answers`.                |
| `--last-answers`       | Skip selection; reuse the last saved selection.                                                              |
| `--build`              | Build the selected packages and their build-time deps, then exit (no run phase).                             |
| `--rebuild`            | Like `--build`, but first clears `dist/` for every build target.                                             |
| `--log-dir <dir>`      | Write the timestamped session log into this directory. Defaults to `node_modules/.devtooie/logs/`. Each run gets a fresh `dev-<timestamp>.log`; previous sessions' logs are kept. |

Subcommands:

- **`devtooie init`** — interactive setup; see [Getting started](../README.md#getting-started-devtooie-init).
- **`devtooie reset`** — clear the saved package selection.
- **`devtooie resolvedeps -p <name> [...]`** — print the resolved
  build/dev/runtime dependency sets as JSON.
- **`devtooie env`** — resolve a package's `.env` files; see [below](#devtooie-env).

## `devtooie env`

Resolve a package's `.env` files (per [Environment loading](../README.md#environment-env-loading))
— handy for running a one-off command with a package's env, or inspecting what
resolves:

```bash
devtooie env                              # resolve for the current directory
devtooie env --dir packages/api           # ...for a specific package
devtooie env -- node ./scripts/seed.js    # run a command with them injected
devtooie env --dir packages/api -- npm run migrate
```

It works from anywhere (finding the nearest ancestor with a `devtooie.config.*`).
`--dir` is relative to that root and **defaults to your current directory**, so
running it inside a package resolves that package.

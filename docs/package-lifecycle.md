# Package lifecycle when you edit code

> Part of the [devtooie](../README.md) documentation.

`command` declares **how a package's dev process behaves**, which tells you (or an
agent) what to do after editing that package's source. It's a script/target name or
`[name, { watches, builds, cleans }]`:

- `command: 'dev'` — the default: `{ watches: true, builds: true, cleans: false }`.
- `command: ['start', { watches: false }]` — `builds` defaults to `true`.
- `command: ['start', { watches: false, cleans: true }]` — its start is a clean rebuild.
- `command: ['serve', { watches: false, builds: false }]` — neither builds nor watches.

`command[0]` (or a bare string) is the npm script / Makefile target run as the dev
process (defaults to `dev`). The flags:

- **`watches`** — the script watches files and reloads itself (default `true`).
- **`builds`** — it (re)builds on start (default `true`). `watches: true` with `builds: false`
  is rejected — a watching script must also build.
- **`cleans`** — its start is a *clean* rebuild, with no stale output to clear (default
  `false`; requires `builds: true`). A `go run .`, for instance. This makes the package
  **rebuildable** without separate `clean`/`build` scripts — a rebuild just restarts it.

**After editing** the package's code — what devtooie (or an agent) does:

| resolved flags                  | after you edit the package's code                       |
| ------------------------------- | ------------------------------------------------------- |
| `watches: true` (default)       | nothing — the script reloads itself                     |
| `watches: false, builds: true`  | `POST /command/restart/<pkg>`                           |
| `watches: false, builds: false` | `POST /command/rebuild/<pkg>` (clean build, then start) |

**The two manual commands** (the `r`/`b` hotkeys and their endpoints):

- **restart** (`POST /command/restart`) — re-runs the dev command; available for any running package.
- **rebuild** (`POST /command/rebuild`) — a clean rebuild; available only when the package
  _can_ clean-rebuild: `cleans: true` (rebuild just restarts it), or it has `clean` + `build`
  (or `build:clean`) scripts. Otherwise it's a no-op (e.g. a plain `node --watch` app).

The resolved flags are served by [`GET /query/config`](./control-api.md) for tooling to read.

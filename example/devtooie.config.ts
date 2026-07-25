import { defineConfig, logging } from 'devtooie';

export default defineConfig({
  packages: [
    // Note: @example/db (packages/db) is deliberately NOT a devtooie package. It's a
    // source-consumption TS library — its package.json `exports` point straight at `src` (no build,
    // no emit) and the backend type-strips it on the fly via Node's native TS support. With no dev
    // process and nothing to build, there's nothing for devtooie to manage: the pnpm `workspace:*`
    // link + package `exports` wire it entirely, and the backend's `node --watch` picks up edits to
    // its source. Contrast `isomorphic` below, which IS a devtooie build-dep — compiled to `dist`
    // and discovered via a tsconfig project reference.
    {
      name: 'isomorphic',
      relativeDir: 'packages/isomorphic',
      // A shared, dependency-free TS library consumed by `backend` and `frontend`. devtooie
      // discovers it as a build-time dep from each app's `tsconfig.json` project references,
      // builds it once first, then runs its `tsc --watch` dev process so edits re-emit `dist`
      // and both apps pick them up live. Hidden from the picker — a dep, not a selection.
      selectable: false,
    },
    {
      name: 'backend',
      relativeDir: 'packages/backend',
      shortName: 'api',
      port: 3001,
      healthcheck: 'http://localhost:$port/health',
      urls: ['http://localhost:$port/todos'],
    },
    {
      name: 'worker',
      relativeDir: 'packages/worker',
      // A Go program — no package.json. devtooie drives it through the single `start`
      // target in its Makefile (`go run .`) instead of npm scripts. It doesn't watch
      // files, but `go run .` compiles from current source every start, so it's a clean
      // rebuild (`cleans: true`). After editing its code, restart it; both restart and
      // rebuild are offered in the TUI, and both just re-run `go run .`.
      command: ['start', { watches: false, builds: true, cleans: true }],
      port: 3002,
      healthcheck: 'http://localhost:$port/health',
      // devtooie applies a default structured-log formatter to every package (non-JSON passes
      // through, JSON is pretty-printed as `[LEVEL] message`), so the worker's `log/slog` output is
      // already formatted with no config. `logging.formatter` is that same default, configured.
      // (Node services would use `logging.nodejs.pino.formatter()` etc.)
      //
      // It takes either shape. A plain object is enough when the rules are the same for every
      // line — e.g. just hiding slog's own `time`, since devtooie stamps its own timestamp:
      //
      //   formatter: logging.formatter({ fields: { custom: { time: { show: false } } } }),
      //
      // Pass a callback instead and it returns the config for the entry being rendered. It
      // receives the *parsed* log — devtooie does the parsing, so there's nothing to JSON.parse
      // and no non-JSON line to guard against. Here the worker attaches `port` to every line via
      // its base logger (see main.go), which is worth seeing on the startup lines but is pure
      // noise on the heartbeat that repeats every 5s:
      logs: {
        formatter: logging.formatter((log) => ({
          fields: {
            custom: {
              time: { show: false }, // hidden on every entry
              ...(log.context === 'heartbeat' ? { port: { show: false } } : {}),
            },
          },
        })),
      },
    },
    {
      name: 'frontend',
      relativeDir: 'packages/frontend',
      shortName: 'web',
      port: 3000,
      healthcheck: 'http://localhost:$port/',
      urls: [{ label: 'home', url: 'http://localhost:$port' }],
      // Selecting `frontend` also runs `backend`; `frontend` waits for the
      // backend's healthcheck to pass before it starts.
      deps: { runtime: ['backend'] },
      waitFor: ['backend'],
    },
  ],
});

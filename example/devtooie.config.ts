import { defineConfig } from 'devtooie';

export default defineConfig({
  packages: [
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

import { defineConfig, logging } from 'devtooie';

export default defineConfig({
  // Values of your own, handed to every callback as `tokens`. A package can add its own on
  // top (see `backend`) — only that package's callbacks see them.
  tokens: { domain: 'example.test' },
  // The ambient environment wins over `.env` files by default, so `FOO=bar pnpm dev` overrides
  // one for a single run. `override` names the exceptions — here so `.env.development` can
  // *extend* an inherited NODE_OPTIONS (VS Code's terminal sets one) instead of losing to it.
  env: { override: ['NODE_OPTIONS'] },
  // Keyed by package name: the key is the name `-p` takes and what `waitFor`/`deps` reference.
  packages: {
    // @example/db is deliberately not a devtooie package: a source-consumption library with no
    // build and no dev process, wired entirely by `workspace:*` + package `exports`.
    isomorphic: {
      relativeDir: 'packages/isomorphic',
      // A build-time dep, discovered from the apps' tsconfig project references: built once
      // first, then `tsc --watch` re-emits `dist` live. Hidden from the picker.
      selectable: false,
    },
    backend: {
      relativeDir: 'packages/backend',
      shortName: 'api',
      tokens: { region: 'us-east' },
      port: ({ envs }) => Number(envs.BACKEND_PORT),
      healthcheck: ({ port }) => `http://localhost:${port}/health`,
      urls: [
        ({ port }) => `http://localhost:${port}/todos`,
        { label: 'public', url: ({ tokens }) => `https://${tokens.region}.${tokens.domain}` },
      ],
    },
    worker: {
      relativeDir: 'packages/worker',
      // A Go program driven through its Makefile's `start` target (`go run .`). It doesn't
      // watch files, but recompiles from source every start — so restart after editing it.
      command: ['start', { watches: false, builds: true, cleans: true }],
      port: 3002,
      healthcheck: ({ port }) => `http://localhost:${port}/health`,
      // JSON logs are formatted by default; `logging.formatter` configures that default. It
      // takes a plain object, or a callback over the parsed entry when the rules vary by line.
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
    frontend: {
      relativeDir: 'packages/frontend',
      shortName: 'web',
      port: 3000,
      // The object form raises this package's probe deadline: a dev server compiling on its
      // first request can take longer than the 1500ms default, and aborting that request is
      // what makes the server log a dropped connection.
      healthcheck: { url: ({ port }) => `http://localhost:${port}/`, timeout: 5000 },
      urls: [{ label: 'home', url: ({ port }) => `http://localhost:${port}` }],
      // Selecting `frontend` also runs `backend`, and holds until its healthcheck passes.
      deps: { runtime: ['backend'] },
      waitFor: ['backend'],
    },
  },
});

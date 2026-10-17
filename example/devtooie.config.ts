import { defineConfig, logging } from 'devtooie';

export default defineConfig({
  // Handed to every callback as `tokens`; a package can add its own (see `backend`).
  tokens: { domain: 'example.test' },
  // Let `.env.development` extend an inherited NODE_OPTIONS instead of losing to it.
  env: { override: ['NODE_OPTIONS'] },
  // devtooie's own dev reverse proxy: http://<subdomain>.localhost:21050 reaches each package
  // (and the mail catcher), with a status page while it's stopped or starting. A custom `rootDomain` (behind a TLS
  // terminator) implies https URLs without the port.
  devReverseProxy: {
    port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT),
    rootDomain: 'localhost', // the default
    defaultPackage: 'frontend', // http://localhost:21050
  },
  // Infrastructure that isn't a package: the Postgres and the mail catcher in ./docker-compose.yaml.
  // `devtooie infra up` starts them and waits for their healthchecks; `pnpm dev` does the same
  // before starting the packages, and leaves them running when you quit.
  // `infra: { 'docker-compose': {} }` alone would start both — `services` attaches callbacks, and
  // routes a service through the dev reverse proxy.
  infra: {
    'docker-compose': {
      services: {
        db: {
          // Once Postgres is healthy — on every `infra up` and every session start, including
          // when it was already running, so this has to be idempotent. `run` executes a command
          // with the mode's environment (DATABASE_URI among it) and sends its output to devtooie.
          afterReady: async ({ run, fresh }) => {
            await run('node', ['src/migrate.ts'], { cwd: 'packages/db' });
            // `fresh`: this run created the database's volume — the very first start, or the
            // first after `devtooie infra destroy` / `infra up --reset`. Start from sample rows.
            if (fresh) {
              await run('node', ['src/seed.ts'], { cwd: 'packages/db' });
            }
          },
        },
        // Mailpit's web UI at http://mail.localhost:21050, through the dev reverse proxy, like a
        // package. `port` is the host side of its port mapping — devtooie doesn't read the compose
        // file for it — and `subdomain: true` is the service's key.
        mail: {
          port: ({ envs }) => Number(envs.MAIL_UI_PORT),
          proxy: { subdomain: true },
        },
      },
    },
  },
  // Each package lives at packages/<key> unless it sets `relativeDir` itself.
  packageRootDir: 'packages',
  // Keyed by package name — what `-p` takes and what `waitFor`/`deps` reference.
  packages: {
    // (@example/db is not a devtooie package: no build, no dev process — plain `workspace:*`.)
    isomorphic: {
      // Build-time dep (from the apps' project references); `tsc --watch` re-emits `dist` live.
      selectable: false,
    },
    backend: {
      shortName: 'api',
      proxy: { subdomain: 'api' }, // http://api.localhost:21050
      tokens: { region: 'us-east' },
      port: ({ envs }) => Number(envs.BACKEND_PORT),
      healthcheck: '/health', // a path: probed at http://localhost:<port>/health
      urls: [
        '/todos', // a path: based on the public origin (http://api.localhost:21050/todos)
        { label: 'public', url: ({ tokens }) => `https://${tokens.region}.${tokens.domain}` },
      ],
    },
    worker: {
      // Go, via the Makefile's `start` target: recompiles on start, doesn't watch — restart after edits.
      command: ['start', { watches: false, builds: true, cleans: true }],
      port: 3002,
      healthcheck: '/health',
      // Tune the default JSON-log formatting; the callback form varies the rules per entry.
      logs: {
        formatter: logging.formatter((log) => ({
          fields: {
            custom: {
              time: { show: false },
              ...(log.context === 'heartbeat' ? { port: { show: false } } : {}),
            },
          },
        })),
      },
    },
    frontend: {
      shortName: 'web',
      proxy: { subdomain: 'web' }, // http://web.localhost:21050; Vite HMR rides the proxied connection (see vite.config.ts)
      port: 3000,
      // A longer probe deadline: a dev server compiling on first request can exceed the 1500ms default.
      healthcheck: { url: '/', timeout: 5000 },
      urls: [''], // '' is the public origin itself: http://web.localhost:21050
      // Runs `backend` too, and waits for its healthcheck.
      deps: { runtime: ['backend'] },
      waitFor: ['backend'],
    },
  },
});

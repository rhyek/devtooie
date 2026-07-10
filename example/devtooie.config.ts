import { defineConfig } from 'devtooie';

export default defineConfig({
  packages: [
    {
      name: 'backend',
      relativeDir: 'packages/backend',
      types: ['backend'],
      run: {
        shortName: 'api',
        port: 3001,
        healthcheck: 'http://localhost:$port/health',
        urls: ['http://localhost:$port/todos'],
      },
    },
    {
      name: 'worker',
      relativeDir: 'packages/worker',
      types: ['backend'],
      run: {
        // This package's dev process doesn't watch files: it builds once on start
        // and stays put. After you edit its code, devtooie knows to restart it
        // (rather than do nothing or a full clean rebuild).
        command: ['start', { watches: false, builds: true }],
        port: 3002,
        healthcheck: 'http://localhost:$port/health',
      },
    },
    {
      name: 'frontend',
      relativeDir: 'packages/frontend',
      types: ['browser'],
      run: {
        shortName: 'web',
        port: 3000,
        healthcheck: 'http://localhost:$port/',
        urls: [{ label: 'home', url: 'http://localhost:$port' }],
        // Selecting `frontend` also runs `backend`; `frontend` waits for the
        // backend's healthcheck to pass before it starts.
        deps: { runtime: ['backend'] },
        waitFor: ['backend'],
      },
    },
  ],
});

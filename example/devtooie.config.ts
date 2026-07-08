import { defineConfig } from 'devtooie';

const config = defineConfig({
  apiPort: 4099,
  skill: false,
  packages: [
    {
      name: 'backend',
      relativeDir: 'packages/backend',
      types: ['backend'],
      run: {
        shortName: 'api',
        port: 3001,
        healthcheck: 'http://localhost:3001/health',
        urls: ['http://localhost:3001/todos'],
      },
    },
    {
      name: 'frontend',
      relativeDir: 'packages/frontend',
      types: ['browser'],
      run: {
        shortName: 'web',
        port: 3000,
        urls: ['http://localhost:3000'],
        // Selecting `frontend` also runs `backend`; `frontend` waits for the
        // backend's healthcheck to pass before it starts.
        deps: { runtime: ['backend'] },
        waitFor: ['backend'],
      },
    },
  ],
});
export default config;

// Wires your package names into devtooie's types. Keep as-is.
declare module 'devtooie' {
  interface Register {
    packageConfigs: typeof config.packages;
  }
}

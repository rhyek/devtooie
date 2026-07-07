import { defineAppConfigs } from 'devtooie';

export default defineAppConfigs({
  apps: [
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

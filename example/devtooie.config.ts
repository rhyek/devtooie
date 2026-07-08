import { defineConfig } from 'devtooie';

const config = defineConfig({
  // Workspace-wide links (not tied to any package). Rendered in the TUI footer above the
  // per-package links, separated by a dim rule. Each entry is one line: a string, a
  // `{ label, url }`, or an array of those rendered on the same line (space-separated).
  // Only extrinsic `$tokens` are substituted here.
  tokens: { pkg: 'devtooie' },
  urls: [
    { label: 'devtooie on npm', url: 'https://www.npmjs.com/package/$pkg' },
    // Two links on one line:
    [
      { label: 'repo', url: 'https://github.com/example/devtooie' },
      { label: 'health', url: 'http://localhost:3001/health' },
    ],
  ],
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
      name: 'frontend',
      relativeDir: 'packages/frontend',
      types: ['browser'],
      run: {
        shortName: 'web',
        port: 3000,
        urls: [{ label: 'home', url: 'http://localhost:$port' }],
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

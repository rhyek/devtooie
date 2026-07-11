import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// TanStack Start builds to a Web `fetch` handler: `vite build` emits `dist/client` (static assets)
// + `dist/server/server.js` (the `{ fetch }` handler), which `server.ts` runs via srvx on Node,
// also serving the static assets. `resolve.tsconfigPaths` makes the `~/` alias (from tsconfig
// paths) resolve at build.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Don't pre-bundle the linked workspace lib: keep @example/isomorphic in the module graph so
  // Vite watches its emitted `dist` and hot-reloads when its `tsc --watch` re-emits on edit.
  optimizeDeps: { exclude: ['@example/isomorphic'] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

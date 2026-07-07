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
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

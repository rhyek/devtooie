import { createServer } from 'node:http';

// A tiny background worker. Its `start` script does NOT watch files (see the
// package's `run.command` in devtooie.config.ts), so after editing this file you
// restart the process to pick up the change rather than relying on a reloader.
const TICK_MS = 5_000;
const PORT = Number(process.env.PORT ?? 3002);

console.log('[worker] started');

setInterval(() => {
  console.log(`[worker] tick @ ${new Date().toISOString()}`);
}, TICK_MS);

// A minimal health endpoint so devtooie can show this package as ready (green dot).
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}).listen(PORT, () => {
  console.log(`[worker] health endpoint on http://localhost:${PORT}/health`);
});

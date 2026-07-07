// TanStack Start instance config. One global middleware lives here: the ONE place every server-fn
// failure is surfaced. (No CSRF middleware — this app isn't behind a TLS-terminating, Sec-Fetch-*
// stripping reverse proxy, so TanStack's built-in origin check needs no override.)
import { createStart, createMiddleware } from '@tanstack/react-start';
import { toast } from 'sonner';

// Global server-fn error surface. The `.client()` phase wraps every server-fn call in the browser;
// on a rejection it toasts MUTATION (POST) failures — the state-changing calls where a silent
// failure is dangerous — then RE-THROWS so existing call-site handling + loaders still run (additive;
// it never hides an error). Reads (GET, in loaders) surface through the root route's errorComponent
// instead. Server-thrown Error messages serialize to the client, so `err.message` is the real cause.
const surfaceErrors = createMiddleware({ type: 'function' }).client(async ({ next, method }) => {
  try {
    return await next();
  } catch (err) {
    if (method === 'POST') {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [surfaceErrors],
}));

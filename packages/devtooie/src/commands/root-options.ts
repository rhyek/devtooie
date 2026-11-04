import type { RootOptions } from './default.js';

// Checked by the CLI before it loads anything a session needs, so a bad combination fails fast.

/**
 * Why the root options can't run together, or `undefined` when they can. Each refusal names the
 * flag that's missing or in the way.
 */
export function rootOptionsRefusal(opts: RootOptions): string | undefined {
  if (opts.plain) {
    return '`--plain` is spelled `--headless`: rename it.';
  }
  if (opts.detach) {
    return "`--detach` is gone: run `devtooie --headless` as a background task, which it ends with, or start a test suite's stack with `startStack()`.";
  }
  if (opts.ui && opts.headless) {
    return 'Cannot use both --ui and --headless.';
  }
  if (opts.phase !== 'dev' && opts.phase !== 'build') {
    return '--phase must be "dev" or "build".';
  }
  return undefined;
}

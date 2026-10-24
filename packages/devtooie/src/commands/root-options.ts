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
  if (opts.ui && opts.headless) {
    return 'Cannot use both --ui and --headless.';
  }
  if (opts.phase !== 'dev' && opts.phase !== 'build') {
    return '--phase must be "dev" or "build".';
  }
  if (opts.detach && !opts.headless) {
    return '--detach needs --headless.';
  }
  if (opts.wait && !opts.detach) {
    return '--wait needs --detach.';
  }
  if (opts.waitTimeout !== undefined && !opts.wait) {
    return '--wait-timeout needs --wait.';
  }
  if (
    opts.waitTimeout !== undefined &&
    !(Number.isFinite(opts.waitTimeout) && opts.waitTimeout > 0)
  ) {
    return '--wait-timeout takes a number of seconds greater than 0.';
  }
  if (opts.detach && (opts.build || opts.rebuild || opts.phase === 'build')) {
    return '--detach starts a dev session; it cannot be used with --build, --rebuild or --phase build.';
  }
  if (opts.detach && opts.killOthers) {
    return '--detach reuses a running session instead of quitting it; it cannot be used with --kill-others.';
  }
  return undefined;
}

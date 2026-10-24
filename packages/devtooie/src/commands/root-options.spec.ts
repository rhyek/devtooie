import { describe, expect, test } from 'vitest';
import type { RootOptions } from './default.js';
import { rootOptionsRefusal } from './root-options.js';

const base: RootOptions = {
  service: [],
  lastAnswers: false,
  phase: 'dev',
  build: false,
  rebuild: false,
  killOthers: false,
};

describe('rootOptionsRefusal', () => {
  test('names --headless for the old --plain', () => {
    expect(rootOptionsRefusal({ ...base, plain: true })).toBe(
      '`--plain` is spelled `--headless`: rename it.',
    );
  });

  test('each of --detach, --wait and --wait-timeout names the flag it needs', () => {
    expect(rootOptionsRefusal({ ...base, detach: true })).toBe('--detach needs --headless.');
    expect(rootOptionsRefusal({ ...base, headless: true, wait: true })).toBe(
      '--wait needs --detach.',
    );
    expect(rootOptionsRefusal({ ...base, headless: true, detach: true, waitTimeout: 60 })).toBe(
      '--wait-timeout needs --wait.',
    );
  });

  test('accepts the full detached form', () => {
    expect(
      rootOptionsRefusal({ ...base, headless: true, detach: true, wait: true, waitTimeout: 180 }),
    ).toBeUndefined();
  });

  test('refuses a --wait-timeout that is not a positive number', () => {
    const opts = { ...base, headless: true, detach: true, wait: true };
    expect(rootOptionsRefusal({ ...opts, waitTimeout: Number('soon') })).toMatch(/greater than 0/);
    expect(rootOptionsRefusal({ ...opts, waitTimeout: 0 })).toMatch(/greater than 0/);
  });

  test('refuses --detach with a build or with --kill-others', () => {
    const detached = { ...base, headless: true, detach: true };
    expect(rootOptionsRefusal({ ...detached, build: true })).toMatch(/--build/);
    expect(rootOptionsRefusal({ ...detached, killOthers: true })).toMatch(/--kill-others/);
  });

  test('refuses --ui with --headless', () => {
    expect(rootOptionsRefusal({ ...base, ui: true, headless: true })).toBe(
      'Cannot use both --ui and --headless.',
    );
  });
});

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

  test('refuses --detach, saying what replaced it', () => {
    expect(rootOptionsRefusal({ ...base, headless: true, detach: true })).toMatch(
      /`--detach` is gone: run `devtooie --headless` as a background task.*startStack/,
    );
  });

  test('refuses --ui with --headless', () => {
    expect(rootOptionsRefusal({ ...base, ui: true, headless: true })).toBe(
      'Cannot use both --ui and --headless.',
    );
  });
});

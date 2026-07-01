import { describe, it, expect } from 'vitest';
import { defineAppConfigs, findApp } from './index.js';
import type { AnyAppConfig, AppName } from './index.js';

describe('public exports', () => {
  it('re-exports the runtime API', () => {
    expect(typeof defineAppConfigs).toBe('function');
    expect(typeof findApp).toBe('function');
  });

  it('AppName falls back to string when Register is unaugmented', () => {
    // Compile-time assertion: a plain string is assignable to AppName.
    const n: AppName = 'anything';
    const app: AnyAppConfig | undefined = defineAppConfigs({ apps: [{ name: n, types: [] }] })[0];
    expect(app?.name).toBe('anything');
  });
});

import { describe, it, expect } from 'vitest';
import { defineConfig, findPackage } from './index.js';
import type { AnyPackageConfig, PackageName } from './index.js';

describe('public exports', () => {
  it('re-exports the runtime API', () => {
    expect(typeof defineConfig).toBe('function');
    expect(typeof findPackage).toBe('function');
  });

  it('PackageName falls back to string when Register is unaugmented', () => {
    // Compile-time assertion: a plain string is assignable to PackageName.
    const n: PackageName = 'anything';
    const pkg: AnyPackageConfig | undefined = defineConfig({ packages: [{ name: n, types: [] }] })
      .packages[0];
    expect(pkg?.name).toBe('anything');
  });
});

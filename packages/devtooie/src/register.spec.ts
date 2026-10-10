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
    const pkg: AnyPackageConfig | undefined = Object.values(
      defineConfig({ packageRootDir: 'packages', packages: { [n]: {} } }).packages,
    )[0];
    expect(pkg?.name).toBe('anything');
  });

  it('narrows PackageConfig by name, tokens included', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      tokens: { domain: 'example.com' },
      packages: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    // Compile-time: each package's tokens are its own, keyed by name.
    const region: string = config.packages.api.tokens.region;
    const domain: 'example.com' = config.packages.web.tokens.domain;
    // @ts-expect-error `region` is api's token, not web's
    void config.packages.web.tokens.region;
    expect([region, domain]).toEqual(['us-east', 'example.com']);
  });
});

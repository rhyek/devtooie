import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defineConfig, findPackage, getRegisteredPackages, getLoadedConfig } from './config.js';

describe('defineConfig path resolution', () => {
  it('defaults relativeDir to packages/<name> and resolves path against cwd', () => {
    const { packages } = defineConfig({ packages: [{ name: 'svc', types: ['backend'] }] });
    const [pkg] = packages;
    expect(pkg!.relativeDir).toBe('packages/svc');
    expect(pkg!.path).toBe(path.resolve(process.cwd(), 'packages/svc'));
  });

  it('honors explicit relativeDir and workspaceDir', () => {
    const { packages } = defineConfig({
      workspaceDir: '/repo',
      packages: [{ name: 'svc', relativeDir: 'apps/svc', types: [] }],
    });
    expect(packages[0]!.path).toBe(path.resolve('/repo', 'apps/svc'));
  });
});

describe('meta defaults', () => {
  it('defaults apiPort to 4099 and skill to false', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc', types: [] }] });
    expect(cfg.apiPort).toBe(4099);
    expect(cfg.skill).toBe(false);
  });

  it('passes through apiPort and skill and exposes them via getLoadedConfig', () => {
    const cfg = defineConfig({
      apiPort: 5000,
      skill: true,
      packages: [{ name: 'svc', types: [] }],
    });
    expect(cfg.apiPort).toBe(5000);
    expect(cfg.skill).toBe(true);
    expect(getLoadedConfig()?.apiPort).toBe(5000);
    expect(getLoadedConfig()?.skill).toBe(true);
  });
});

describe('token substitution', () => {
  it('substitutes intrinsic :name, :port, :subdomain', () => {
    const { packages } = defineConfig({
      packages: [
        {
          name: 'core',
          types: ['backend'],
          run: {
            port: 3001,
            subdomain: ['core', 'core-bg'],
            healthcheck: 'http://localhost::port/health',
            urls: ['https://:subdomain.local/:name'],
          },
        },
      ],
    });
    const [pkg] = packages;
    expect(pkg!.run!.healthcheck).toBe('http://localhost:3001/health');
    expect(pkg!.run!.urls![0]).toBe('https://core.local/core');
  });

  it('substitutes extrinsic tokens from opts.tokens (string and object urls)', () => {
    const { packages } = defineConfig({
      tokens: { domain: 'example.com', proxyport: '8443' },
      packages: [
        {
          name: 'web',
          types: ['browser'],
          run: { urls: [{ label: 'home', url: 'https://app.:domain::proxyport' }] },
        },
      ],
    });
    const url = packages[0]!.run!.urls![0];
    expect(typeof url === 'object' && url.url).toBe('https://app.example.com:8443');
  });
});

describe('validation', () => {
  it('throws when waitFor targets a package without a healthcheck', () => {
    expect(() =>
      defineConfig({
        packages: [
          { name: 'a', types: ['backend'], run: { waitFor: ['b'] } },
          { name: 'b', types: ['backend'], run: {} },
        ],
      }),
    ).toThrow(/waitFor "b".*no healthcheck/);
  });

  it('throws when waitFor targets a missing package', () => {
    expect(() =>
      defineConfig({
        packages: [{ name: 'a', types: ['backend'], run: { waitFor: ['ghost' as any] } }],
      }),
    ).toThrow(/waitFor "ghost"/);
  });

  it('throws when a url uses an unknown extrinsic token', () => {
    expect(() =>
      defineConfig({
        packages: [{ name: 'a', types: ['browser'], run: { urls: ['https://:domain'] } }],
      }),
    ).toThrow(/:domain/);
  });
});

describe('registry + findPackage', () => {
  it('populates the registry on define and looks packages up by name', () => {
    defineConfig({
      packages: [
        { name: 'alpha', types: [] },
        { name: 'beta', types: [] },
      ],
    });
    expect(getRegisteredPackages().map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
    expect(findPackage('alpha').name).toBe('alpha');
  });

  it('throws for an unknown package', () => {
    defineConfig({ packages: [{ name: 'alpha', types: [] }] });
    expect(() => findPackage('nope')).toThrow(/nope/);
  });
});

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  defineConfig,
  findPackage,
  getRegisteredPackages,
  getLoadedConfig,
  getDevScript,
} from './config.js';

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
  it('leaves apiPort undefined when unset (random port chosen at startup)', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc', types: [] }] });
    expect(cfg.apiPort).toBeUndefined();
  });

  it('passes through a pinned apiPort and exposes it via getLoadedConfig', () => {
    const cfg = defineConfig({
      apiPort: 5000,
      packages: [{ name: 'svc', types: [] }],
    });
    expect(cfg.apiPort).toBe(5000);
    expect(getLoadedConfig()?.apiPort).toBe(5000);
  });

  it('defaults envFiles to the standard set', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc', types: [] }] });
    expect(cfg.envFiles).toEqual([
      '.env',
      '.env.development.pre',
      '.env.development',
      '.env.local',
    ]);
  });

  it('honors an env.files override', () => {
    const cfg = defineConfig({
      env: { files: ['.env', '.env.test'] },
      packages: [{ name: 'svc', types: [] }],
    });
    expect(cfg.envFiles).toEqual(['.env', '.env.test']);
  });
});

describe('token substitution', () => {
  it('substitutes intrinsic $name, $port, $subdomain', () => {
    const { packages } = defineConfig({
      packages: [
        {
          name: 'core',
          types: ['backend'],
          run: {
            port: 3001,
            subdomain: ['core', 'core-bg'],
            healthcheck: 'http://localhost:$port/health',
            urls: ['https://$subdomain.local/$name'],
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
          run: { urls: [{ label: 'home', url: 'https://app.$domain:$proxyport' }] },
        },
      ],
    });
    expect(packages[0]!.run!.urls![0]).toEqual({
      label: 'home',
      url: 'https://app.example.com:8443',
    });
  });

  it('substitutes tokens inside a per-package array (same-line) url entry, keeping its shape', () => {
    const { packages } = defineConfig({
      tokens: { domain: 'example.com' },
      packages: [
        {
          name: 'web',
          types: ['browser'],
          run: {
            port: 3000,
            urls: [['http://localhost:$port', { label: 'app', url: 'https://app.$domain' }]],
          },
        },
      ],
    });
    expect(packages[0]!.run!.urls![0]).toEqual([
      'http://localhost:3000',
      { label: 'app', url: 'https://app.example.com' },
    ]);
  });
});

describe('top-level urls', () => {
  it('substitutes extrinsic tokens in a bare-string top-level url', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      urls: ['https://grafana.$domain'],
      packages: [{ name: 'svc', types: [] }],
    });
    expect(cfg.urls![0]).toBe('https://grafana.example.com');
  });

  it('substitutes extrinsic tokens in an object top-level url and keeps the label', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com', proxyport: '8443' },
      urls: [{ label: 'Grafana', url: 'https://grafana.$domain:$proxyport' }],
      packages: [{ name: 'svc', types: [] }],
    });
    const url = cfg.urls![0];
    expect(url).toEqual({ label: 'Grafana', url: 'https://grafana.example.com:8443' });
  });

  it('substitutes tokens inside a top-level array (same-line) url entry, keeping its shape', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      urls: [['https://grafana.$domain', { label: 'Logs', url: 'https://logs.$domain' }]],
      packages: [{ name: 'svc', types: [] }],
    });
    expect(cfg.urls![0]).toEqual([
      'https://grafana.example.com',
      { label: 'Logs', url: 'https://logs.example.com' },
    ]);
  });

  it('leaves a top-level url with no tokens verbatim', () => {
    const cfg = defineConfig({
      urls: ['https://dashboard.internal'],
      packages: [{ name: 'svc', types: [] }],
    });
    expect(cfg.urls![0]).toBe('https://dashboard.internal');
  });

  it('leaves urls undefined when none are given', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc', types: [] }] });
    expect(cfg.urls).toBeUndefined();
  });

  it('throws when a top-level url references an intrinsic token like $port', () => {
    expect(() =>
      defineConfig({
        urls: ['http://localhost:$port'],
        packages: [{ name: 'svc', types: [] }],
      }),
    ).toThrow(/top-level url.*\$port/);
  });

  it('throws when a top-level url references an unknown extrinsic token', () => {
    expect(() =>
      defineConfig({
        urls: ['https://$domain'],
        packages: [{ name: 'svc', types: [] }],
      }),
    ).toThrow(/top-level url.*\$domain/);
  });
});

describe('run.command', () => {
  const cmd = (run: object) =>
    defineConfig({ packages: [{ name: 'a', types: ['backend'], run: run as never }] }).packages[0]!
      .run!.command;

  it('defaults to dev / watches:true / builds:true when omitted', () => {
    expect(cmd({})).toEqual({ name: 'dev', watches: true, builds: true });
  });

  it('accepts a bare string (defaults watches:true, builds:true)', () => {
    expect(cmd({ command: 'start' })).toEqual({ name: 'start', watches: true, builds: true });
  });

  it('a tuple with watches:false defaults builds to true', () => {
    expect(cmd({ command: ['start', { watches: false }] })).toEqual({
      name: 'start',
      watches: false,
      builds: true,
    });
  });

  it('a tuple with watches:false, builds:false is kept', () => {
    expect(cmd({ command: ['start', { watches: false, builds: false }] })).toEqual({
      name: 'start',
      watches: false,
      builds: false,
    });
  });

  it('an empty options object defaults to watches:true, builds:true', () => {
    expect(cmd({ command: ['start', {}] })).toEqual({
      name: 'start',
      watches: true,
      builds: true,
    });
  });

  it('throws at runtime for watches:true + builds:false', () => {
    expect(() => cmd({ command: ['start', { watches: true, builds: false }] })).toThrow();
  });

  it('throws at runtime for builds:false without watches:false', () => {
    expect(() => cmd({ command: ['start', { builds: false }] })).toThrow();
  });

  it('getDevScript returns the configured command name, else dev', () => {
    const { packages } = defineConfig({
      packages: [
        { name: 'a', types: [], run: { command: 'start' } },
        { name: 'b', types: [], run: {} },
        { name: 'c', types: [] },
      ],
    });
    expect(getDevScript(packages[0]!)).toBe('start');
    expect(getDevScript(packages[1]!)).toBe('dev');
    expect(getDevScript(packages[2]!)).toBe('dev');
  });

  it('rejects the illegal combos at the type level', () => {
    // @ts-expect-error watches:true requires builds:true
    const a = (): unknown => defineConfig({ packages: [{ name: 'a', types: [], run: { command: ['x', { watches: true, builds: false }] } }] }); // prettier-ignore
    // @ts-expect-error builds:false requires watches:false
    const b = (): unknown => defineConfig({ packages: [{ name: 'a', types: [], run: { command: ['x', { builds: false }] } }] }); // prettier-ignore
    void a;
    void b;
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
        packages: [{ name: 'a', types: ['browser'], run: { urls: ['https://$domain'] } }],
      }),
    ).toThrow(/\$domain/);
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

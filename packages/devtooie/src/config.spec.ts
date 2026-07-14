import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  defineConfig,
  findPackage,
  getRegisteredPackages,
  getLoadedConfig,
  getDevScript,
} from './config.js';

describe('command / autostart', () => {
  it('resolves an omitted command to the `dev` default', () => {
    const { packages } = defineConfig({ packages: [{ name: 'svc' }] });
    expect(packages[0]!.command).toEqual({
      name: 'dev',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  it('passes `command: null` through (no dev process)', () => {
    const { packages } = defineConfig({ packages: [{ name: 'lib', command: null }] });
    expect(packages[0]!.command).toBeNull();
  });

  it('honors autostart and leaves it undefined (⇒ true) by default', () => {
    const { packages } = defineConfig({
      packages: [{ name: 'a', autostart: false }, { name: 'b' }],
    });
    expect(packages[0]!.autostart).toBe(false);
    expect(packages[1]!.autostart).toBeUndefined();
  });
});

describe('defineConfig path resolution', () => {
  it('defaults relativeDir to packages/<name> and resolves path against cwd', () => {
    const { packages } = defineConfig({ packages: [{ name: 'svc' }] });
    const [pkg] = packages;
    expect(pkg!.relativeDir).toBe('packages/svc');
    expect(pkg!.path).toBe(path.resolve(process.cwd(), 'packages/svc'));
  });

  it('honors explicit relativeDir and workspaceDir', () => {
    const { packages } = defineConfig({
      workspaceDir: '/repo',
      packages: [{ name: 'svc', relativeDir: 'apps/svc' }],
    });
    expect(packages[0]!.path).toBe(path.resolve('/repo', 'apps/svc'));
  });
});

describe('meta defaults', () => {
  it('leaves apiPort undefined when unset (random port chosen at startup)', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc' }] });
    expect(cfg.apiPort).toBeUndefined();
  });

  it('passes through a pinned apiPort and exposes it via getLoadedConfig', () => {
    const cfg = defineConfig({
      apiPort: 5000,
      packages: [{ name: 'svc' }],
    });
    expect(cfg.apiPort).toBe(5000);
    expect(getLoadedConfig()?.apiPort).toBe(5000);
  });

  it('defaults envFiles to the standard set', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc' }] });
    expect(cfg.envFiles).toEqual(['.env', '.env.development', '.env.local']);
  });

  it('honors an env.files override', () => {
    const cfg = defineConfig({
      env: { files: ['.env', '.env.test'] },
      packages: [{ name: 'svc' }],
    });
    expect(cfg.envFiles).toEqual(['.env', '.env.test']);
  });

  it('defaults logTimestamps to false', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc' }] });
    expect(cfg.logTimestamps).toBe(false);
  });

  it('honors a logs.timestamps override', () => {
    const cfg = defineConfig({ logs: { timestamps: true }, packages: [{ name: 'svc' }] });
    expect(cfg.logTimestamps).toBe(true);
  });
});

describe('logs (per-package)', () => {
  it('passes a logs.formatter through unchanged (not a validating wrapper)', () => {
    const fmt = (line: string): string => `[fmt] ${line}`;
    const { packages } = defineConfig({ packages: [{ name: 'svc', logs: { formatter: fmt } }] });
    expect(packages[0]!.logs?.formatter).toBe(fmt);
    expect(packages[0]!.logs?.formatter!('hi')).toBe('[fmt] hi');
  });

  it('stores a package-level logs.timestamps override', () => {
    const { packages } = defineConfig({
      packages: [{ name: 'a', logs: { timestamps: true } }, { name: 'b' }],
    });
    expect(packages[0]!.logs?.timestamps).toBe(true);
    expect(packages[1]!.logs).toBeUndefined();
  });

  it('leaves logs undefined when not set', () => {
    const { packages } = defineConfig({ packages: [{ name: 'svc' }] });
    expect(packages[0]!.logs).toBeUndefined();
  });

  it('rejects a non-function logs.formatter', () => {
    expect(() =>
      // @ts-expect-error logs.formatter must be a function
      defineConfig({ packages: [{ name: 'svc', logs: { formatter: 'nope' } }] }),
    ).toThrow(/logs\.formatter/);
  });
});

describe('token substitution', () => {
  it('substitutes intrinsic $name, $port, $subdomain', () => {
    const { packages } = defineConfig({
      packages: [
        {
          name: 'core',

          port: 3001,
          subdomain: ['core', 'core-bg'],
          healthcheck: 'http://localhost:$port/health',
          urls: ['https://$subdomain.local/$name'],
        },
      ],
    });
    const [pkg] = packages;
    expect(pkg!.healthcheck).toBe('http://localhost:3001/health');
    expect(pkg!.urls![0]).toBe('https://core.local/core');
  });

  it('substitutes extrinsic tokens from opts.tokens (string and object urls)', () => {
    const { packages } = defineConfig({
      tokens: { domain: 'example.com', proxyport: '8443' },
      packages: [
        {
          name: 'web',
          urls: [{ label: 'home', url: 'https://app.$domain:$proxyport' }],
        },
      ],
    });
    expect(packages[0]!.urls![0]).toEqual({
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

          port: 3000,
          urls: [['http://localhost:$port', { label: 'app', url: 'https://app.$domain' }]],
        },
      ],
    });
    expect(packages[0]!.urls![0]).toEqual([
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
      packages: [{ name: 'svc' }],
    });
    expect(cfg.urls![0]).toBe('https://grafana.example.com');
  });

  it('substitutes extrinsic tokens in an object top-level url and keeps the label', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com', proxyport: '8443' },
      urls: [{ label: 'Grafana', url: 'https://grafana.$domain:$proxyport' }],
      packages: [{ name: 'svc' }],
    });
    const url = cfg.urls![0];
    expect(url).toEqual({ label: 'Grafana', url: 'https://grafana.example.com:8443' });
  });

  it('substitutes tokens inside a top-level array (same-line) url entry, keeping its shape', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      urls: [['https://grafana.$domain', { label: 'Logs', url: 'https://logs.$domain' }]],
      packages: [{ name: 'svc' }],
    });
    expect(cfg.urls![0]).toEqual([
      'https://grafana.example.com',
      { label: 'Logs', url: 'https://logs.example.com' },
    ]);
  });

  it('leaves a top-level url with no tokens verbatim', () => {
    const cfg = defineConfig({
      urls: ['https://dashboard.internal'],
      packages: [{ name: 'svc' }],
    });
    expect(cfg.urls![0]).toBe('https://dashboard.internal');
  });

  it('leaves urls undefined when none are given', () => {
    const cfg = defineConfig({ packages: [{ name: 'svc' }] });
    expect(cfg.urls).toBeUndefined();
  });

  it('throws when a top-level url references an intrinsic token like $port', () => {
    expect(() =>
      defineConfig({
        urls: ['http://localhost:$port'],
        packages: [{ name: 'svc' }],
      }),
    ).toThrow(/top-level url.*\$port/);
  });

  it('throws when a top-level url references an unknown extrinsic token', () => {
    expect(() =>
      defineConfig({
        urls: ['https://$domain'],
        packages: [{ name: 'svc' }],
      }),
    ).toThrow(/top-level url.*\$domain/);
  });
});

describe('command', () => {
  const cmd = (fields: object) =>
    defineConfig({ packages: [{ name: 'a', ...fields } as never] }).packages[0]!.command;

  it('defaults to dev / watches:true / builds:true / cleans:false when omitted', () => {
    expect(cmd({})).toEqual({ name: 'dev', watches: true, builds: true, cleans: false });
  });

  it('accepts a bare string (defaults watches:true, builds:true, cleans:false)', () => {
    expect(cmd({ command: 'start' })).toEqual({
      name: 'start',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  it('a tuple with watches:false defaults builds to true, cleans to false', () => {
    expect(cmd({ command: ['start', { watches: false }] })).toEqual({
      name: 'start',
      watches: false,
      builds: true,
      cleans: false,
    });
  });

  it('a tuple with watches:false, builds:false is kept', () => {
    expect(cmd({ command: ['start', { watches: false, builds: false }] })).toEqual({
      name: 'start',
      watches: false,
      builds: false,
      cleans: false,
    });
  });

  it('keeps cleans:true (a dev command that clean-rebuilds on start)', () => {
    expect(cmd({ command: ['start', { watches: false, builds: true, cleans: true }] })).toEqual({
      name: 'start',
      watches: false,
      builds: true,
      cleans: true,
    });
  });

  it('an empty options object defaults to watches:true, builds:true, cleans:false', () => {
    expect(cmd({ command: ['start', {}] })).toEqual({
      name: 'start',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  it('throws at runtime for watches:true + builds:false', () => {
    expect(() => cmd({ command: ['start', { watches: true, builds: false }] })).toThrow();
  });

  it('throws at runtime for builds:false without watches:false', () => {
    expect(() => cmd({ command: ['start', { builds: false }] })).toThrow();
  });

  it('throws at runtime for cleans:true + builds:false (cleaning implies building)', () => {
    expect(() =>
      cmd({ command: ['start', { watches: false, builds: false, cleans: true }] }),
    ).toThrow();
  });

  it('getDevScript returns the configured command name, else dev', () => {
    const { packages } = defineConfig({
      packages: [{ name: 'a', command: 'start' }, { name: 'b' }, { name: 'c' }],
    });
    expect(getDevScript(packages[0]!)).toBe('start');
    expect(getDevScript(packages[1]!)).toBe('dev');
    expect(getDevScript(packages[2]!)).toBe('dev');
  });

  it('rejects the illegal combos at the type level', () => {
    // @ts-expect-error watches:true requires builds:true
    const a = (): unknown => defineConfig({ packages: [{ name: 'a',  command: ['x', { watches: true, builds: false }]  }] }); // prettier-ignore
    // @ts-expect-error builds:false requires watches:false
    const b = (): unknown => defineConfig({ packages: [{ name: 'a',  command: ['x', { builds: false }]  }] }); // prettier-ignore
    // @ts-expect-error cleans:true requires builds:true
    const c = (): unknown => defineConfig({ packages: [{ name: 'a',  command: ['x', { watches: false, builds: false, cleans: true }]  }] }); // prettier-ignore
    void a;
    void b;
    void c;
  });
});

describe('validation', () => {
  it('throws when waitFor targets a package without a healthcheck', () => {
    expect(() =>
      defineConfig({
        packages: [{ name: 'a', waitFor: ['b'] }, { name: 'b' }],
      }),
    ).toThrow(/waitFor "b".*no healthcheck/);
  });

  it('throws when waitFor targets a missing package', () => {
    expect(() =>
      defineConfig({
        packages: [{ name: 'a', waitFor: ['ghost' as any] }],
      }),
    ).toThrow(/waitFor "ghost"/);
  });

  it('throws when a url uses an unknown extrinsic token', () => {
    expect(() =>
      defineConfig({
        packages: [{ name: 'a', urls: ['https://$domain'] }],
      }),
    ).toThrow(/\$domain/);
  });
});

describe('registry + findPackage', () => {
  it('populates the registry on define and looks packages up by name', () => {
    defineConfig({
      packages: [{ name: 'alpha' }, { name: 'beta' }],
    });
    expect(getRegisteredPackages().map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
    expect(findPackage('alpha').name).toBe('alpha');
  });

  it('throws for an unknown package', () => {
    defineConfig({ packages: [{ name: 'alpha' }] });
    expect(() => findPackage('nope')).toThrow(/nope/);
  });
});

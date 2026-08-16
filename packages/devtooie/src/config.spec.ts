import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defineConfig,
  findPackage,
  getRegisteredPackages,
  getLoadedConfig,
  getWorkspaceDir,
  getDevScript,
} from './config.js';

describe('command / autostart', () => {
  it('resolves an omitted command to the `dev` default', () => {
    const packages = Object.values(defineConfig({ packages: { svc: {} } }).packages);
    expect(packages[0]!.command).toEqual({
      name: 'dev',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  it('passes `command: null` through (no dev process)', () => {
    const packages = Object.values(defineConfig({ packages: { lib: { command: null } } }).packages);
    expect(packages[0]!.command).toBeNull();
  });

  it('honors autostart and leaves it undefined (⇒ true) by default', () => {
    const packages = Object.values(
      defineConfig({
        packages: { a: { autostart: false }, b: {} },
      }).packages,
    );
    expect(packages[0]!.autostart).toBe(false);
    expect(packages[1]!.autostart).toBeUndefined();
  });
});

describe('defineConfig path resolution', () => {
  it('defaults relativeDir to packages/<name> and resolves path against cwd', () => {
    const packages = Object.values(defineConfig({ packages: { svc: {} } }).packages);
    const [pkg] = packages;
    expect(pkg!.relativeDir).toBe('packages/svc');
    expect(pkg!.path).toBe(path.resolve(process.cwd(), 'packages/svc'));
  });

  it('honors explicit relativeDir and workspaceDir', () => {
    const packages = Object.values(
      defineConfig({
        workspaceDir: '/repo',
        packages: { svc: { relativeDir: 'apps/svc' } },
      }).packages,
    );
    expect(packages[0]!.path).toBe(path.resolve('/repo', 'apps/svc'));
  });
});

describe('meta defaults', () => {
  it('leaves apiPort undefined when unset (random port chosen at startup)', () => {
    const cfg = defineConfig({ packages: { svc: {} } });
    expect(cfg.apiPort).toBeUndefined();
  });

  it('passes through a pinned apiPort and exposes it via getLoadedConfig', () => {
    const cfg = defineConfig({
      apiPort: 5000,
      packages: { svc: {} },
    });
    expect(cfg.apiPort).toBe(5000);
    expect(getLoadedConfig()?.apiPort).toBe(5000);
  });

  it("defaults envFiles to the development mode's set", () => {
    const cfg = defineConfig({ packages: { svc: {} } });
    expect(cfg.envFiles).toEqual([
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
    ]);
    expect(cfg.envMode).toBe('development');
  });

  it('follows DEVTOOIE_MODE for both envFiles and envMode', () => {
    process.env.DEVTOOIE_MODE = 'test';
    try {
      const cfg = defineConfig({ packages: { svc: {} } });
      expect(cfg.envFiles).toEqual(['.env', '.env.local', '.env.test', '.env.test.local']);
      expect(cfg.envMode).toBe('test');
    } finally {
      delete process.env.DEVTOOIE_MODE;
    }
  });

  it('rejects the removed env.files option instead of silently ignoring it', () => {
    expect(() =>
      // @ts-expect-error - `files` was removed; the schema must say so rather than strip it.
      defineConfig({ env: { files: ['.env', '.env.test'] }, packages: { svc: {} } }),
    ).toThrow(/Unrecognized key: "files"/);
  });

  it('carries env.override through to the resolved config', () => {
    const cfg = defineConfig({
      env: { override: ['NODE_OPTIONS'] },
      packages: { svc: {} },
    });
    expect(cfg.envOverride).toEqual(['NODE_OPTIONS']);
  });

  it('defaults logTimestamps to false', () => {
    const cfg = defineConfig({ packages: { svc: {} } });
    expect(cfg.logTimestamps).toBe(false);
  });

  it('honors a logs.timestamps override', () => {
    const cfg = defineConfig({ logs: { timestamps: true }, packages: { svc: {} } });
    expect(cfg.logTimestamps).toBe(true);
  });
});

describe('logs (per-package)', () => {
  it('passes a logs.formatter through unchanged (not a validating wrapper)', () => {
    const fmt = (line: string): string => `[fmt] ${line}`;
    const packages = Object.values(
      defineConfig({ packages: { svc: { logs: { formatter: fmt } } } }).packages,
    );
    expect(packages[0]!.logs?.formatter).toBe(fmt);
    expect(packages[0]!.logs?.formatter!('hi')).toBe('[fmt] hi');
  });

  it('stores a package-level logs.timestamps override', () => {
    const packages = Object.values(
      defineConfig({
        packages: { a: { logs: { timestamps: true } }, b: {} },
      }).packages,
    );
    expect(packages[0]!.logs?.timestamps).toBe(true);
    expect(packages[1]!.logs).toBeUndefined();
  });

  it('leaves logs undefined when not set', () => {
    const packages = Object.values(defineConfig({ packages: { svc: {} } }).packages);
    expect(packages[0]!.logs).toBeUndefined();
  });

  it('rejects a non-function logs.formatter', () => {
    expect(() =>
      // @ts-expect-error logs.formatter must be a function
      defineConfig({ packages: { svc: { logs: { formatter: 'nope' } } } }),
    ).toThrow(/logs\.formatter/);
  });
});

describe('tokens', () => {
  it('merges the package tokens over the config tokens, package winning', () => {
    const packages = Object.values(
      defineConfig({
        tokens: { domain: 'example.com', scheme: 'https' },
        packages: {
          api: {
            tokens: { region: 'us-east', scheme: 'http' },
            healthcheck: ({ tokens }) => `${tokens.scheme}://${tokens.region}.${tokens.domain}`,
          },
        },
      }).packages,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://us-east.example.com');
  });

  it('keeps one package tokens out of another package', () => {
    const seen: (string | undefined)[] = [];
    defineConfig({
      packages: {
        api: { tokens: { region: 'us-east' } },
        web: {
          healthcheck: ({ tokens }) => {
            seen.push((tokens as Record<string, string | undefined>).region);
            return 'http://localhost/health';
          },
        },
      },
    });
    expect(seen).toEqual([undefined]);
  });

  it('gives a package with no tokens of its own just the config tokens', () => {
    const packages = Object.values(
      defineConfig({
        tokens: { domain: 'example.com' },
        packages: { web: { healthcheck: ({ tokens }) => `https://${tokens.domain}` } },
      }).packages,
    );
    expect(packages[0]!.healthcheck?.url).toBe('https://example.com');
  });

  it('hands workspace-wide urls only the config tokens', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      urls: [({ tokens }) => `https://status.${tokens.domain}`],
      packages: { api: { tokens: { region: 'us-east' } } },
    });
    expect(cfg.urls![0]).toBe('https://status.example.com');
  });

  // The type-level half of the feature. vitest does not typecheck, so these are enforced by
  // `tsc -p packages/devtooie/tsconfig.json` — the `@ts-expect-error`s fail the typecheck if
  // the inference regresses. See docs/configuration.md#callbacks-instead-of-interpolation.
  it('types each package tokens from what it declares', () => {
    defineConfig({
      tokens: { domain: 'example.com' },
      packages: {
        api: {
          tokens: { region: 'us-east' },
          // both the config token and this package's own are known keys
          healthcheck: ({ tokens }) => `https://${tokens.region}.${tokens.domain}`,
        },
        web: {
          // @ts-expect-error `region` is the api package's token, not this one's
          urls: [({ tokens }) => `https://${tokens.region}`],
        },
        edge: {
          // @ts-expect-error no token named `nope` anywhere
          healthcheck: ({ tokens }) => `https://${tokens.nope}`,
        },
      },
    });
  });

  // The regression this whole shape exists to prevent: a package that declares NO tokens must
  // not make its siblings' tokens fall back to a permissive record. `P` is constrained to
  // `Record<K, unknown>` (not `Record<K, TokenRecord>`) precisely so the inference survives —
  // TypeScript replaces an inference that fails its constraint with the constraint itself.
  it('keeps sibling tokens exact when a package omits tokens entirely', () => {
    defineConfig({
      tokens: { domain: 'example.com' },
      packages: {
        // declares tokens, and still gets exact types despite the siblings below
        api: {
          tokens: { region: 'us-east' },
          healthcheck: ({ tokens }) => `https://${tokens.region}.${tokens.domain}`,
        },
        // no `tokens` key at all — not even `{}`
        web: {
          healthcheck: ({ tokens }) => `https://${tokens.domain}`,
        },
        edge: {
          // @ts-expect-error still exact: no fallback to a permissive record
          healthcheck: ({ tokens }) => `https://${tokens.anything}`,
        },
      },
    });
  });

  // Rejected at both layers: a compile error at the declaration (the `@ts-expect-error`) and
  // a load-time error from the schema, for configs that reach `defineConfig` unchecked.
  it('rejects a non-string token value', () => {
    expect(() =>
      defineConfig({
        packages: {
          // @ts-expect-error token values must be strings
          api: { tokens: { port: 8080 } },
        },
      }),
    ).toThrow(/tokens\.port/);
  });

  it('type-checks waitFor and deps against the package keys', () => {
    // The valid direction compiles and loads.
    defineConfig({
      packages: {
        api: { healthcheck: 'http://localhost/health' },
        web: { waitFor: ['api'], deps: { runtime: ['api'], build: ['api'], dev: ['api'] } },
      },
    });
    // The invalid direction is a compile error *and* a load-time error.
    expect(() =>
      defineConfig({
        packages: {
          api: {},
          edge: {
            // @ts-expect-error no package named `ghost`
            waitFor: ['ghost'],
          },
        },
      }),
    ).toThrow(/waitFor "ghost"/);
    expect(() =>
      defineConfig({
        packages: {
          api: {},
          edge: {
            // @ts-expect-error no package named `nope`
            deps: { runtime: ['nope'] },
          },
        },
      }),
    ).toThrow(/deps\.runtime "nope"/);
  });
});

describe('package keys', () => {
  it('rejects an integer-like package name (JS would reorder the keys)', () => {
    expect(() => defineConfig({ packages: { 2: {} } })).toThrow(/is a number/);
  });

  it('preserves declaration order of the keys', () => {
    const cfg = defineConfig({ packages: { zebra: {}, alpha: {}, middle: {} } });
    expect(Object.keys(cfg.packages)).toEqual(['zebra', 'alpha', 'middle']);
  });

  it('exposes each package resolved tokens on the config', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      packages: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    expect(cfg.packages.api.tokens).toEqual({ domain: 'example.com', region: 'us-east' });
    expect(cfg.packages.web.tokens).toEqual({ domain: 'example.com' });
  });
});

describe('url/healthcheck callbacks', () => {
  it('resolves a healthcheck callback with the package port', () => {
    const packages = Object.values(
      defineConfig({
        packages: {
          core: { port: 3001, healthcheck: ({ port }) => `http://localhost:${port}/health` },
        },
      }).packages,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:3001/health');
  });

  it('hands the config tokens to a callback (string and object urls)', () => {
    const packages = Object.values(
      defineConfig({
        tokens: { domain: 'example.com', proxyport: '8443' },
        packages: {
          web: {
            urls: [
              {
                label: 'home',
                url: ({ tokens }) => `https://app.${tokens.domain}:${tokens.proxyport}`,
              },
            ],
          },
        },
      }).packages,
    );
    expect(packages[0]!.urls![0]).toEqual({ label: 'home', url: 'https://app.example.com:8443' });
  });

  it('resolves callbacks inside a per-package array (same-line) url entry, keeping its shape', () => {
    const packages = Object.values(
      defineConfig({
        tokens: { domain: 'example.com' },
        packages: {
          web: {
            port: 3000,
            urls: [
              [
                ({ port }) => `http://localhost:${port}`,
                { label: 'app', url: ({ tokens }) => `https://app.${tokens.domain}` },
              ],
            ],
          },
        },
      }).packages,
    );
    expect(packages[0]!.urls![0]).toEqual([
      'http://localhost:3000',
      { label: 'app', url: 'https://app.example.com' },
    ]);
  });

  it('passes a literal string through untouched, `$` and all', () => {
    // Interpolation is gone: a `$port` in a literal is just a character sequence now.
    const packages = Object.values(
      defineConfig({
        packages: {
          core: { port: 3001, healthcheck: 'http://localhost:$port/health', urls: ['$name'] },
        },
      }).packages,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:$port/health');
    expect(packages[0]!.urls![0]).toBe('$name');
  });

  it('reports the package and field when a callback returns a non-string', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error a url callback must return a string
        packages: { core: { port: 3001, healthcheck: ({ port }) => port } },
      }),
    ).toThrow(/core healthcheck: callback returned 3001/);
  });

  // `port` is typed `number` for callbacks, which the type system can't verify (the one
  // inference channel goes to `tokens`). Reading it on a package that declares none therefore
  // fails at load time, naming the package — rather than interpolating `undefined` into a URL.
  it('throws, naming the package, when a callback reads a port the package has not declared', () => {
    expect(() =>
      defineConfig({
        packages: {
          core: {
            healthcheck: ({ port }) => `http://localhost:${port}/health`,
          },
        },
      }),
    ).toThrow(/core: a callback read `port`, but this package declares no `port`/);
  });

  it('leaves a portless package alone when its callbacks never read the port', () => {
    const cfg = defineConfig({
      tokens: { host: 'example.test' },
      packages: {
        core: { selectable: true, healthcheck: ({ tokens }) => `https://${tokens.host}/health` },
      },
    });
    expect(cfg.packages.core.healthcheck?.url).toBe('https://example.test/health');
    expect(cfg.packages.core.port).toBeUndefined();
  });
});

describe('healthcheck', () => {
  const health = (config: Parameters<typeof defineConfig>[0]) =>
    Object.values(defineConfig(config).packages)[0]!.healthcheck;

  it('normalizes a bare URL to `{ url, timeout }` with the default timeout', () => {
    expect(health({ packages: { api: { healthcheck: 'http://localhost/health' } } })).toEqual({
      url: 'http://localhost/health',
      timeout: 1500,
    });
  });

  it('takes the URL and timeout from the object form', () => {
    expect(
      health({
        packages: { api: { healthcheck: { url: 'http://localhost/health', timeout: 10_000 } } },
      }),
    ).toEqual({ url: 'http://localhost/health', timeout: 10_000 });
  });

  it('resolves a callback inside the object form, with the package context', () => {
    expect(
      health({
        tokens: { host: 'api.internal' },
        packages: {
          api: {
            port: 4321,
            healthcheck: {
              url: ({ port, tokens }) => `http://${tokens.host}:${port}/health`,
              timeout: 4000,
            },
          },
        },
      }),
    ).toEqual({ url: 'http://api.internal:4321/health', timeout: 4000 });
  });

  it('defaults the timeout when the object form omits it', () => {
    expect(
      health({ packages: { api: { healthcheck: { url: 'http://localhost/health' } } } })?.timeout,
    ).toBe(1500);
  });

  it('names the package and field when a callback in the object form returns a non-string', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error a url callback must return a string
        packages: { api: { port: 3001, healthcheck: { url: ({ port }) => port } } },
      }),
    ).toThrow(/api healthcheck: callback returned 3001/);
  });

  it('rejects a misspelled key rather than silently keeping the default', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error `timout` is not a healthcheck option
        packages: { api: { healthcheck: { url: 'http://localhost/health', timout: 9000 } } },
      }),
    ).toThrow(/invalid devtooie config/);
  });

  it('rejects a non-positive or fractional timeout', () => {
    for (const timeout of [0, -1, 1.5]) {
      expect(() =>
        defineConfig({
          packages: { api: { healthcheck: { url: 'http://localhost/health', timeout } } },
        }),
      ).toThrow(/invalid devtooie config/);
    }
  });

  it('satisfies a waitFor dependency declared in the object form', () => {
    expect(() =>
      defineConfig({
        packages: {
          api: { healthcheck: { url: 'http://localhost/health', timeout: 3000 } },
          web: { waitFor: ['api'] },
        },
      }),
    ).not.toThrow();
  });
});

describe('top-level urls', () => {
  it('resolves a callback in a bare-string top-level url', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      urls: [({ tokens }) => `https://grafana.${tokens.domain}`],
      packages: { svc: {} },
    });
    expect(cfg.urls![0]).toBe('https://grafana.example.com');
  });

  it('resolves a callback in an object top-level url and keeps the label', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com', proxyport: '8443' },
      urls: [
        {
          label: 'Grafana',
          url: ({ tokens }) => `https://grafana.${tokens.domain}:${tokens.proxyport}`,
        },
      ],
      packages: { svc: {} },
    });
    expect(cfg.urls![0]).toEqual({ label: 'Grafana', url: 'https://grafana.example.com:8443' });
  });

  it('resolves callbacks inside a top-level array (same-line) url entry, keeping its shape', () => {
    const cfg = defineConfig({
      tokens: { domain: 'example.com' },
      urls: [
        [
          ({ tokens }) => `https://grafana.${tokens.domain}`,
          { label: 'Logs', url: ({ tokens }) => `https://logs.${tokens.domain}` },
        ],
      ],
      packages: { svc: {} },
    });
    expect(cfg.urls![0]).toEqual([
      'https://grafana.example.com',
      { label: 'Logs', url: 'https://logs.example.com' },
    ]);
  });

  it('leaves a literal top-level url verbatim', () => {
    const cfg = defineConfig({
      urls: ['https://dashboard.internal'],
      packages: { svc: {} },
    });
    expect(cfg.urls![0]).toBe('https://dashboard.internal');
  });

  it('leaves urls undefined when none are given', () => {
    const cfg = defineConfig({ packages: { svc: {} } });
    expect(cfg.urls).toBeUndefined();
  });

  it('throws when a top-level url callback reads a port (those links have no package)', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error a workspace-wide url has no package, so no `port` in its context
        urls: [({ port }) => `http://localhost:${port}`],
        packages: { svc: { port: 3001 } },
      }),
    ).toThrow(/those links belong to no package/);
  });
});

describe('command', () => {
  const cmd = (fields: object) =>
    Object.values(defineConfig({ packages: { a: { ...fields } as never } }).packages)[0]!.command;

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
    const packages = Object.values(
      defineConfig({
        packages: { a: { command: 'start' }, b: {}, c: {} },
      }).packages,
    );
    expect(getDevScript(packages[0]!)).toBe('start');
    expect(getDevScript(packages[1]!)).toBe('dev');
    expect(getDevScript(packages[2]!)).toBe('dev');
  });

  it('rejects the illegal combos at the type level', () => {
    // @ts-expect-error watches:true requires builds:true
    const a = (): unknown => defineConfig({ packages: { a: {   command: ['x', { watches: true, builds: false }]  } } }); // prettier-ignore
    // @ts-expect-error builds:false requires watches:false
    const b = (): unknown => defineConfig({ packages: { a: {   command: ['x', { builds: false }]  } } }); // prettier-ignore
    // @ts-expect-error cleans:true requires builds:true
    const c = (): unknown => defineConfig({ packages: { a: {   command: ['x', { watches: false, builds: false, cleans: true }]  } } }); // prettier-ignore
    void a;
    void b;
    void c;
  });
});

describe('validation', () => {
  it('throws when waitFor targets a package without a healthcheck', () => {
    expect(() =>
      defineConfig({
        packages: { a: { waitFor: ['b'] }, b: {} },
      }),
    ).toThrow(/waitFor "b".*no healthcheck/);
  });

  it('throws when waitFor targets a missing package', () => {
    expect(() =>
      defineConfig({
        packages: { a: { waitFor: ['ghost' as any] } },
      }),
    ).toThrow(/waitFor "ghost"/);
  });

  it('throws when a dep names a missing package, saying which category', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error also a compile error — the load-time check is the backstop
        packages: { a: { deps: { runtime: ['ghost'] } } },
      }),
    ).toThrow(/a has deps\.runtime "ghost" but no such package exists/);
  });

  it('accepts deps that name real packages', () => {
    const packages = Object.values(
      defineConfig({
        packages: { a: { deps: { build: ['b'], runtime: ['b'] } }, b: {} },
      }).packages,
    );
    expect(packages[0]!.deps).toEqual({ build: ['b'], runtime: ['b'] });
  });
});

describe('registry + findPackage', () => {
  it('populates the registry on define and looks packages up by name', () => {
    defineConfig({
      packages: { alpha: {}, beta: {} },
    });
    expect(getRegisteredPackages().map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
    expect(findPackage('alpha').name).toBe('alpha');
  });

  it('throws for an unknown package', () => {
    defineConfig({ packages: { alpha: {} } });
    expect(() => findPackage('nope')).toThrow(/nope/);
  });
});

describe('port callback', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-port-'));
    fs.mkdirSync(path.join(ws, 'packages/api'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.DEVTOOIE_TEST_PORT;
  });

  it('resolves the port from a workspace-scope env file', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }).packages,
    );
    expect(packages[0]!.port).toBe(4321);
  });

  it('resolves the port from process.env when no file defines it', () => {
    process.env.DEVTOOIE_TEST_PORT = '5555';
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: ({ envs }) => Number(envs.DEVTOOIE_TEST_PORT) } },
      }).packages,
    );
    expect(packages[0]!.port).toBe(5555);
  });

  it('lets an ambient var win over an env file of the same name', () => {
    process.env.DEVTOOIE_TEST_PORT = '5555';
    fs.writeFileSync(path.join(ws, '.env.development'), 'DEVTOOIE_TEST_PORT=6666\n');
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: ({ envs }) => Number(envs.DEVTOOIE_TEST_PORT) } },
      }).packages,
    );
    expect(packages[0]!.port).toBe(5555);
  });

  it('lets env.override hand the file the win back', () => {
    process.env.DEVTOOIE_TEST_PORT = '5555';
    fs.writeFileSync(path.join(ws, '.env.development'), 'DEVTOOIE_TEST_PORT=6666\n');
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        env: { override: ['DEVTOOIE_TEST_PORT'] },
        packages: { api: { port: ({ envs }) => Number(envs.DEVTOOIE_TEST_PORT) } },
      }).packages,
    );
    expect(packages[0]!.port).toBe(6666);
  });

  it('lets a package-scope env file override the workspace-scope one', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    fs.writeFileSync(path.join(ws, 'packages/api/.env.development'), 'BACKEND_PORT=7777\n');
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }).packages,
    );
    expect(packages[0]!.port).toBe(7777);
  });

  it('reads the mode-specific file for the active mode', () => {
    process.env.DEVTOOIE_MODE = 'test';
    try {
      fs.writeFileSync(path.join(ws, '.env.test'), 'BACKEND_PORT=8888\n');
      fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
      const packages = Object.values(
        defineConfig({
          workspaceDir: ws,
          packages: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
        }).packages,
      );
      expect(packages[0]!.port).toBe(8888);
    } finally {
      delete process.env.DEVTOOIE_MODE;
    }
  });

  it('feeds the resolved port into the healthcheck/urls callbacks', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: {
          api: {
            port: ({ envs }) => Number(envs.BACKEND_PORT),
            healthcheck: ({ port }) => `http://localhost:${port}/health`,
            urls: [({ port }) => `http://localhost:${port}/todos`],
          },
        },
      }).packages,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:4321/health');
    expect(packages[0]!.urls).toEqual(['http://localhost:4321/todos']);
  });

  it('hands the same resolved env to a healthcheck callback', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'PUBLIC_HOST=api.internal\n');
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: {
          api: { port: 3001, healthcheck: ({ envs }) => `http://${envs.PUBLIC_HOST}/health` },
        },
      }).packages,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://api.internal/health');
  });

  it('treats an undefined return as no port', () => {
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: () => undefined } },
      }).packages,
    );
    expect(packages[0]!.port).toBeUndefined();
  });

  it('throws when a callback returns NaN, naming the package and the env files', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'OTHER=1\n');
    expect(() =>
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }),
    ).toThrow(/api: port callback returned NaN[\s\S]*\.env\.development/);
  });

  it('says so when no env file was found at all', () => {
    expect(() =>
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }),
    ).toThrow(/no env files were found/);
  });

  it('still accepts a literal numeric port', () => {
    const packages = Object.values(
      defineConfig({
        workspaceDir: ws,
        packages: { api: { port: 3001, healthcheck: 'http://localhost:3001/health' } },
      }).packages,
    );
    expect(packages[0]!.port).toBe(3001);
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:3001/health');
  });
});

describe('getWorkspaceDir', () => {
  it('reports the root package paths resolved against, not the config file directory', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-ws-')));
    defineConfig({ workspaceDir: dir, packages: { svc: {} } });
    try {
      // What decides whether a port holder belongs to this workspace — a config living in a
      // subdirectory can point `workspaceDir` somewhere else entirely.
      expect(getWorkspaceDir()).toBe(path.resolve(dir));
      expect(getRegisteredPackages()[0]!.path).toBe(path.join(dir, 'packages/svc'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to the process cwd', () => {
    defineConfig({ packages: { svc: {} } });
    expect(getWorkspaceDir()).toBe(path.resolve(process.cwd()));
  });
});

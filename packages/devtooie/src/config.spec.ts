import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  type AnyServiceConfig,
  defineConfig,
  findService,
  getRegisteredPackages,
  getLoadedConfig,
  getWorkspaceDir,
  getDevScript,
} from './config.js';
import { packageEnvLayer } from './env.js';

/** `defineConfig`'s options as seen with `serviceRootDir` set (so `relativeDir` is optional). */
type RootedOpts = Parameters<
  typeof defineConfig<Record<never, never>, Record<string, unknown>, string, 'packages'>
>[0];

describe('command / autostart', () => {
  test('resolves an omitted command to the `dev` default', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { svc: {} } }).services,
    );
    expect(packages[0]!.command).toEqual({
      name: 'dev',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  test('passes `command: null` through (no dev process)', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { lib: { command: null } } }).services,
    );
    expect(packages[0]!.command).toBeNull();
  });

  test('honors autostart and leaves it undefined (⇒ true) by default', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { a: { autostart: false }, b: {} } })
        .services,
    );
    expect(packages[0]!.autostart).toBe(false);
    expect(packages[1]!.autostart).toBeUndefined();
  });
});

describe('defineConfig path resolution', () => {
  test('infers relativeDir from serviceRootDir + key, resolving path against cwd', () => {
    const cfg = defineConfig({ serviceRootDir: 'apps', services: { svc: {}, '@scope/x': {} } });
    expect(cfg.services.svc.relativeDir).toBe('apps/svc');
    expect(cfg.services.svc.absoluteDir).toBe(path.resolve(process.cwd(), 'apps/svc'));
    expect(cfg.services['@scope/x'].relativeDir).toBe('apps/@scope/x');
  });

  test('normalizes a trailing slash on serviceRootDir', () => {
    const cfg = defineConfig({ serviceRootDir: 'apps/', services: { svc: {} } });
    expect(cfg.services.svc.relativeDir).toBe('apps/svc');
  });

  test('lets relativeDir override the inferred directory', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { svc: { relativeDir: 'apps/svc' }, other: {} },
    });
    expect(cfg.services.svc.relativeDir).toBe('apps/svc');
    expect(cfg.services.other.relativeDir).toBe('packages/other');
  });

  test('requires relativeDir when there is no serviceRootDir, naming the package', () => {
    expect(() =>
      // @ts-expect-error relativeDir is required without serviceRootDir
      defineConfig({ services: { svc: { port: 3000 } } }),
    ).toThrow(/svc has no `relativeDir`, and the config sets no `serviceRootDir` to infer it from/);
  });

  test('honors explicit relativeDir and workspaceDir', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: '/repo',
        services: { svc: { relativeDir: 'apps/svc' } },
      }).services,
    );
    expect(packages[0]!.absoluteDir).toBe(path.resolve('/repo', 'apps/svc'));
  });
});

describe('meta defaults', () => {
  test('leaves apiPort undefined when unset (random port chosen at startup)', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.apiPort).toBeUndefined();
  });

  test('passes through a pinned apiPort and exposes it via getLoadedConfig', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', apiPort: 5000, services: { svc: {} } });
    expect(cfg.apiPort).toBe(5000);
    expect(getLoadedConfig()?.apiPort).toBe(5000);
  });

  test("defaults envFiles to the development mode's set", () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.envFiles).toEqual([
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
    ]);
    expect(cfg.envMode).toBe('development');
  });

  test('follows DEVTOOIE_MODE for both envFiles and envMode', () => {
    process.env.DEVTOOIE_MODE = 'test';
    try {
      const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
      expect(cfg.envFiles).toEqual(['.env', '.env.local', '.env.test', '.env.test.local']);
      expect(cfg.envMode).toBe('test');
    } finally {
      delete process.env.DEVTOOIE_MODE;
    }
  });

  test('rejects the removed env.files option instead of silently ignoring it', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error - `files` was removed; the schema must say so rather than strip it.
        env: { files: ['.env', '.env.test'] },
        services: { svc: {} },
      }),
    ).toThrow(/Unrecognized key: "files"/);
  });

  test('carries env.override through to the resolved config', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      env: { override: ['NODE_OPTIONS'] },
      services: { svc: {} },
    });
    expect(cfg.envOverride).toEqual(['NODE_OPTIONS']);
  });

  test('defaults logTimestamps to true', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.logTimestamps).toBe(true);
  });

  test('honors a logs.timestamps override', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      logs: { timestamps: false },
      services: { svc: {} },
    });
    expect(cfg.logTimestamps).toBe(false);
  });
});

describe('logs (per-package)', () => {
  test('passes a logs.formatter through unchanged (not a validating wrapper)', () => {
    const fmt = (line: string): string => `[fmt] ${line}`;
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { svc: { logs: { formatter: fmt } } } })
        .services,
    );
    expect(packages[0]!.logs?.formatter).toBe(fmt);
    expect(packages[0]!.logs?.formatter!('hi')).toBe('[fmt] hi');
  });

  test('stores a package-level logs.timestamps override', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { logs: { timestamps: true } }, b: {} },
      }).services,
    );
    expect(packages[0]!.logs?.timestamps).toBe(true);
    expect(packages[1]!.logs).toBeUndefined();
  });

  test('leaves logs undefined when not set', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { svc: {} } }).services,
    );
    expect(packages[0]!.logs).toBeUndefined();
  });

  test('rejects a non-function logs.formatter', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error logs.formatter must be a function
        services: { svc: { logs: { formatter: 'nope' } } },
      }),
    ).toThrow(/logs\.formatter/);
  });
});

describe('tokens', () => {
  test('merges the package tokens over the config tokens, package winning', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com', scheme: 'https' },
        services: {
          api: {
            tokens: { region: 'us-east', scheme: 'http' },
            healthcheck: ({ tokens }) => `${tokens.scheme}://${tokens.region}.${tokens.domain}`,
          },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://us-east.example.com');
  });

  test('keeps one package tokens out of another package', () => {
    const seen: (string | undefined)[] = [];
    defineConfig({
      serviceRootDir: 'packages',
      services: {
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

  test('gives a package with no tokens of its own just the config tokens', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com' },
        services: { web: { healthcheck: ({ tokens }) => `https://${tokens.domain}` } },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('https://example.com');
  });

  test('hands workspace-wide urls only the config tokens', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      urls: [({ tokens }) => `https://status.${tokens.domain}`],
      services: { api: { tokens: { region: 'us-east' } } },
    });
    expect(cfg.urls![0]).toBe('https://status.example.com');
  });

  // The type-level half of the feature. vitest does not typecheck, so these are enforced by
  // `tsc -p packages/devtooie/tsconfig.json` — the `@ts-expect-error`s fail the typecheck if
  // the inference regresses. See docs/configuration.md#callbacks-instead-of-interpolation.
  // Asserted by tsc, not at run time.
  // oxlint-disable-next-line vitest/expect-expect
  test('types each package tokens from what it declares', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: {
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
  // Asserted by tsc, not at run time.
  // oxlint-disable-next-line vitest/expect-expect
  test('keeps sibling tokens exact when a package omits tokens entirely', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: {
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
  test('rejects a non-string token value', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          // @ts-expect-error token values must be strings
          api: { tokens: { port: 8080 } },
        },
      }),
    ).toThrow(/tokens\.port/);
  });

  test('type-checks waitFor and deps against the package keys', () => {
    // The valid direction compiles and loads.
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { healthcheck: 'http://localhost/health' },
        web: { waitFor: ['api'], deps: { runtime: ['api'], build: ['api'], dev: ['api'] } },
      },
    });
    // The invalid direction is a compile error *and* a load-time error.
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
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
        serviceRootDir: 'packages',
        services: {
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
  test('rejects an integer-like package name (JS would reorder the keys)', () => {
    expect(() => defineConfig({ serviceRootDir: 'packages', services: { 2: {} } })).toThrow(
      /is a number/,
    );
  });

  test('preserves declaration order of the keys', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { zebra: {}, alpha: {}, middle: {} },
    });
    expect(Object.keys(cfg.services)).toEqual(['zebra', 'alpha', 'middle']);
  });

  test('exposes each package resolved tokens on the config', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    expect(cfg.services.api.tokens).toEqual({ domain: 'example.com', region: 'us-east' });
    expect(cfg.services.web.tokens).toEqual({ domain: 'example.com' });
  });
});

describe('url/healthcheck callbacks', () => {
  test('resolves a healthcheck callback with the package port', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          core: { port: 3001, healthcheck: ({ port }) => `http://localhost:${port}/health` },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:3001/health');
  });

  test('hands the config tokens to a callback (string and object urls)', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com', proxyport: '8443' },
        services: {
          web: {
            urls: [
              {
                label: 'home',
                url: ({ tokens }) => `https://app.${tokens.domain}:${tokens.proxyport}`,
              },
            ],
          },
        },
      }).services,
    );
    expect(packages[0]!.urls![0]).toEqual({ label: 'home', url: 'https://app.example.com:8443' });
  });

  test('resolves callbacks inside a per-package array (same-line) url entry, keeping its shape', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com' },
        services: {
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
      }).services,
    );
    expect(packages[0]!.urls![0]).toEqual([
      'http://localhost:3000',
      { label: 'app', url: 'https://app.example.com' },
    ]);
  });

  test('passes a literal string through untouched, `$` and all', () => {
    // Interpolation is gone: a `$port` in a literal is just a character sequence now.
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          core: {
            port: 3001,
            healthcheck: 'http://localhost:$port/health',
            urls: ['https://example.test/$name'],
          },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:$port/health');
    expect(packages[0]!.urls![0]).toBe('https://example.test/$name');
  });

  test('reports the package and field when a callback returns a non-string', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error a url callback must return a string
        services: { core: { port: 3001, healthcheck: ({ port }) => port } },
      }),
    ).toThrow(/core healthcheck: callback returned 3001/);
  });

  // `port` is typed `number` for callbacks, which the type system can't verify (the one
  // inference channel goes to `tokens`). Reading it on a package that declares none therefore
  // fails at load time, naming the package — rather than interpolating `undefined` into a URL.
  test('throws, naming the package, when a callback reads a port the package has not declared', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          core: {
            healthcheck: ({ port }) => `http://localhost:${port}/health`,
          },
        },
      }),
    ).toThrow(/core: a callback read `port`, but this service declares no `port`/);
  });

  test('leaves a portless package alone when its callbacks never read the port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { host: 'example.test' },
      services: {
        core: { selectable: true, healthcheck: ({ tokens }) => `https://${tokens.host}/health` },
      },
    });
    expect(cfg.services.core.healthcheck?.url).toBe('https://example.test/health');
    expect(cfg.services.core.port).toBeUndefined();
  });
});

describe('healthcheck', () => {
  const health = (api: RootedOpts['services'][string]) =>
    Object.values(
      // tsc rejects `{ api }` without the cast.
      defineConfig({ serviceRootDir: 'packages', services: { api } as RootedOpts['services'] })
        .services,
    )[0]!.healthcheck;

  test('normalizes a bare URL to `{ url, timeout }` with the default timeout', () => {
    expect(health({ healthcheck: 'http://localhost/health' })).toEqual({
      url: 'http://localhost/health',
      timeout: 1500,
    });
  });

  test('takes the URL and timeout from the object form', () => {
    expect(health({ healthcheck: { url: 'http://localhost/health', timeout: 10_000 } })).toEqual({
      url: 'http://localhost/health',
      timeout: 10_000,
    });
  });

  test('resolves a callback inside the object form, with the package context', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { host: 'api.internal' },
      services: {
        api: {
          port: 4321,
          healthcheck: {
            url: ({ port, tokens }) => `http://${tokens.host}:${port}/health`,
            timeout: 4000,
          },
        },
      },
    });
    expect(cfg.services.api.healthcheck).toEqual({
      url: 'http://api.internal:4321/health',
      timeout: 4000,
    });
  });

  test('defaults the timeout when the object form omits it', () => {
    expect(health({ healthcheck: { url: 'http://localhost/health' } })).toEqual({
      url: 'http://localhost/health',
      timeout: 1500,
    });
  });

  test('names the package and field when a callback in the object form returns a non-string', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error a url callback must return a string
        services: { api: { port: 3001, healthcheck: { url: ({ port }) => port } } },
      }),
    ).toThrow(/api healthcheck: callback returned 3001/);
  });

  test('rejects a misspelled key rather than silently keeping the default', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error `timout` is not a healthcheck option
        services: { api: { healthcheck: { url: 'http://localhost/health', timout: 9000 } } },
      }),
    ).toThrow(/invalid devtooie config/);
  });

  test('rejects a non-positive or fractional timeout', () => {
    for (const timeout of [0, -1, 1.5]) {
      expect(() =>
        defineConfig({
          serviceRootDir: 'packages',
          services: { api: { healthcheck: { url: 'http://localhost/health', timeout } } },
        }),
      ).toThrow(/invalid devtooie config/);
    }
  });

  test('satisfies a waitFor dependency declared in the object form', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          api: { healthcheck: { url: 'http://localhost/health', timeout: 3000 } },
          web: { waitFor: ['api'] },
        },
      }),
    ).not.toThrow();
  });
});

describe('top-level urls', () => {
  test('resolves a callback in a bare-string top-level url', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      urls: [({ tokens }) => `https://grafana.${tokens.domain}`],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toBe('https://grafana.example.com');
  });

  test('resolves a callback in an object top-level url and keeps the label', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com', proxyport: '8443' },
      urls: [
        {
          label: 'Grafana',
          url: ({ tokens }) => `https://grafana.${tokens.domain}:${tokens.proxyport}`,
        },
      ],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toEqual({ label: 'Grafana', url: 'https://grafana.example.com:8443' });
  });

  test('resolves callbacks inside a top-level array (same-line) url entry, keeping its shape', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      urls: [
        [
          ({ tokens }) => `https://grafana.${tokens.domain}`,
          { label: 'Logs', url: ({ tokens }) => `https://logs.${tokens.domain}` },
        ],
      ],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toEqual([
      'https://grafana.example.com',
      { label: 'Logs', url: 'https://logs.example.com' },
    ]);
  });

  test('leaves a literal top-level url verbatim', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      urls: ['https://dashboard.internal'],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toBe('https://dashboard.internal');
  });

  test('leaves urls undefined when none are given', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.urls).toBeUndefined();
  });

  test('throws when a top-level url callback reads a port (those links have no package)', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error a workspace-wide url has no package, so no `port` in its context
        urls: [({ port }) => `http://localhost:${port}`],
        services: { svc: { port: 3001 } },
      }),
    ).toThrow(/those links belong to no service/);
  });
});

describe('command', () => {
  const cmd = (fields: object) =>
    Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { a: { ...fields } } }).services,
    )[0]!.command;

  test('defaults to dev / watches:true / builds:true / cleans:false when omitted', () => {
    expect(cmd({})).toEqual({ name: 'dev', watches: true, builds: true, cleans: false });
  });

  test('accepts a bare string (defaults watches:true, builds:true, cleans:false)', () => {
    expect(cmd({ command: 'start' })).toEqual({
      name: 'start',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  test('a tuple with watches:false defaults builds to true, cleans to false', () => {
    expect(cmd({ command: ['start', { watches: false }] })).toEqual({
      name: 'start',
      watches: false,
      builds: true,
      cleans: false,
    });
  });

  test('a tuple with watches:false, builds:false is kept', () => {
    expect(cmd({ command: ['start', { watches: false, builds: false }] })).toEqual({
      name: 'start',
      watches: false,
      builds: false,
      cleans: false,
    });
  });

  test('keeps cleans:true (a dev command that clean-rebuilds on start)', () => {
    expect(cmd({ command: ['start', { watches: false, builds: true, cleans: true }] })).toEqual({
      name: 'start',
      watches: false,
      builds: true,
      cleans: true,
    });
  });

  test('an empty options object defaults to watches:true, builds:true, cleans:false', () => {
    expect(cmd({ command: ['start', {}] })).toEqual({
      name: 'start',
      watches: true,
      builds: true,
      cleans: false,
    });
  });

  test('throws at runtime for watches:true + builds:false', () => {
    expect(() => cmd({ command: ['start', { watches: true, builds: false }] })).toThrow(
      'a command that watches or cleans must also build',
    );
  });

  test('throws at runtime for builds:false without watches:false', () => {
    expect(() => cmd({ command: ['start', { builds: false }] })).toThrow(
      'a command that watches or cleans must also build',
    );
  });

  test('throws at runtime for cleans:true + builds:false (cleaning implies building)', () => {
    expect(() =>
      cmd({ command: ['start', { watches: false, builds: false, cleans: true }] }),
    ).toThrow('a command that watches or cleans must also build');
  });

  test('getDevScript returns the configured command name, else dev', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { command: 'start' }, b: {}, c: {} },
      }).services,
    );
    expect(getDevScript(packages[0]!)).toBe('start');
    expect(getDevScript(packages[1]!)).toBe('dev');
    expect(getDevScript(packages[2]!)).toBe('dev');
  });

  // Asserted by tsc, not at run time.
  // oxlint-disable-next-line vitest/expect-expect
  test('rejects the illegal combos at the type level', () => {
    // @ts-expect-error watches:true requires builds:true
    const a = (): unknown => defineConfig({ serviceRootDir: 'packages', services: { a: {   command: ['x', { watches: true, builds: false }]  } } }); // oxfmt-ignore
    // @ts-expect-error builds:false requires watches:false
    const b = (): unknown => defineConfig({ serviceRootDir: 'packages', services: { a: {   command: ['x', { builds: false }]  } } }); // oxfmt-ignore
    // @ts-expect-error cleans:true requires builds:true
    const c = (): unknown => defineConfig({ serviceRootDir: 'packages', services: { a: {   command: ['x', { watches: false, builds: false, cleans: true }]  } } }); // oxfmt-ignore
    void a;
    void b;
    void c;
  });
});

describe('validation', () => {
  test('names the spelling of a renamed key: `services`, `serviceRootDir`, `defaultService`', () => {
    const define = (opts: unknown) => () =>
      defineConfig(opts as Parameters<typeof defineConfig>[0]);
    expect(define({ packageRootDir: 'apps', packages: { web: {} } })).toThrow(
      '`packages` is spelled `services`: rename it.\n' +
        '`packageRootDir` is spelled `serviceRootDir`: rename it.',
    );
    expect(
      define({
        serviceRootDir: 'apps',
        devReverseProxy: { defaultPackage: 'web' },
        services: { web: { port: 3000 } },
      }),
    ).toThrow('`devReverseProxy.defaultPackage` is spelled `devReverseProxy.defaultService`: rename it.'); // oxfmt-ignore
  });

  test('throws when waitFor targets a package without a healthcheck', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { a: { waitFor: ['b'] }, b: {} } }),
    ).toThrow(/waitFor "b".*no healthcheck/);
  });

  test('throws when waitFor targets a missing package', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { a: { waitFor: ['ghost' as any] } } }),
    ).toThrow(/waitFor "ghost"/);
  });

  test('throws when a dep names a missing package, saying which category', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error also a compile error — the load-time check is the backstop
        services: { a: { deps: { runtime: ['ghost'] } } },
      }),
    ).toThrow(/a has deps\.runtime "ghost" but no such service exists/);
  });

  test('accepts deps that name real packages', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { deps: { build: ['b'], runtime: ['b'] } }, b: {} },
      }).services,
    );
    expect(packages[0]!.deps).toEqual({ build: ['b'], runtime: ['b'] });
  });
});

describe('registry + findService', () => {
  test('populates the registry on define and looks packages up by name', () => {
    defineConfig({ serviceRootDir: 'packages', services: { alpha: {}, beta: {} } });
    expect(getRegisteredPackages().map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
    expect(findService('alpha').name).toBe('alpha');
  });

  test('throws for an unknown package', () => {
    defineConfig({ serviceRootDir: 'packages', services: { alpha: {} } });
    expect(() => findService('nope')).toThrow(/nope/);
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

  test('resolves the port from a workspace-scope env file', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(4321);
  });

  test('resolves the port from process.env when no file defines it', () => {
    process.env.DEVTOOIE_TEST_PORT = '5555';
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.DEVTOOIE_TEST_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(5555);
  });

  test('lets an ambient var win over an env file of the same name', () => {
    process.env.DEVTOOIE_TEST_PORT = '5555';
    fs.writeFileSync(path.join(ws, '.env.development'), 'DEVTOOIE_TEST_PORT=6666\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.DEVTOOIE_TEST_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(5555);
  });

  test('lets env.override hand the file the win back', () => {
    process.env.DEVTOOIE_TEST_PORT = '5555';
    fs.writeFileSync(path.join(ws, '.env.development'), 'DEVTOOIE_TEST_PORT=6666\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        env: { override: ['DEVTOOIE_TEST_PORT'] },
        services: { api: { port: ({ envs }) => Number(envs.DEVTOOIE_TEST_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(6666);
  });

  test('lets a package-scope env file override the workspace-scope one', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    fs.writeFileSync(path.join(ws, 'packages/api/.env.development'), 'BACKEND_PORT=7777\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(7777);
  });

  test('reads the mode-specific file for the active mode', () => {
    process.env.DEVTOOIE_MODE = 'test';
    try {
      fs.writeFileSync(path.join(ws, '.env.test'), 'BACKEND_PORT=8888\n');
      fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
      const packages = Object.values(
        defineConfig({
          serviceRootDir: 'packages',
          workspaceDir: ws,
          services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
        }).services,
      );
      expect(packages[0]!.port).toBe(8888);
    } finally {
      delete process.env.DEVTOOIE_MODE;
    }
  });

  test('feeds the resolved port into the healthcheck/urls callbacks', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: {
          api: {
            port: ({ envs }) => Number(envs.BACKEND_PORT),
            healthcheck: ({ port }) => `http://localhost:${port}/health`,
            urls: [({ port }) => `http://localhost:${port}/todos`],
          },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:4321/health');
    expect(packages[0]!.urls).toEqual(['http://localhost:4321/todos']);
  });

  test('hands the same resolved env to a healthcheck callback', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'PUBLIC_HOST=api.internal\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: {
          api: { port: 3001, healthcheck: ({ envs }) => `http://${envs.PUBLIC_HOST}/health` },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://api.internal/health');
  });

  test('treats an undefined return as no port', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: () => undefined } },
      }).services,
    );
    expect(packages[0]!.port).toBeUndefined();
  });

  test('throws when a callback returns NaN, naming the package and the env files', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'OTHER=1\n');
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }),
    ).toThrow(/api: port callback returned NaN[\s\S]*\.env\.development/);
  });

  test('says so when no env file was found at all', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }),
    ).toThrow(/no env files were found/);
  });

  test('still accepts a literal numeric port', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: 3001, healthcheck: 'http://localhost:3001/health' } },
      }).services,
    );
    expect(packages[0]!.port).toBe(3001);
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:3001/health');
  });
});

describe('getWorkspaceDir', () => {
  test('reports the root package paths resolved against, not the config file directory', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-ws-')));
    defineConfig({ serviceRootDir: 'packages', workspaceDir: dir, services: { svc: {} } });
    try {
      // What decides whether a port holder belongs to this workspace — a config living in a
      // subdirectory can point `workspaceDir` somewhere else entirely.
      expect(getWorkspaceDir()).toBe(path.resolve(dir));
      expect(getRegisteredPackages()[0]!.absoluteDir).toBe(path.join(dir, 'packages/svc'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defaults to the process cwd', () => {
    defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(getWorkspaceDir()).toBe(path.resolve(process.cwd()));
  });
});

// A package's `proxy.subdomain`. Without a `devReverseProxy` it is data for an external reverse
// proxy that reads the exported config; devtooie validates it and hands the canonical (first)
// entry to the package's callbacks. (Routing is under `devReverseProxy` below.)
describe('proxy', () => {
  test('a top-level `subdomain` is an error saying to move it under `proxy`', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { api: { subdomain: 'api' } as unknown as Record<never, never> },
      }),
    ).toThrow(
      /services\.api\.subdomain: a service's subdomain goes under `proxy` — `proxy: \{ subdomain: … \}`/,
    );
    // Every form of it, `true` included — none may be stripped and leave the package unrouted.
    for (const subdomain of [true, ['api', 'www']]) {
      expect(() =>
        defineConfig({
          serviceRootDir: 'packages',
          services: { api: { subdomain } as unknown as Record<never, never> },
        }),
      ).toThrow(/services\.api\.subdomain: .*under `proxy`/);
    }
  });

  test('rejects an unknown option in the block, and a block with no subdomain', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error `proxy` takes `subdomain` only
        services: { api: { proxy: { subdomain: 'api', host: 'x' } } },
      }),
    ).toThrow(/services\.api\.proxy: Unrecognized key: "host"/);
    expect(() =>
      // @ts-expect-error `subdomain` is required: `proxy: {}` would route nothing
      defineConfig({ serviceRootDir: 'packages', services: { api: { proxy: {} } } }),
    ).toThrow(/services\.api\.proxy\.subdomain/);
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { api: { proxy: { subdomain: [] } } } }),
    ).toThrow(/services\.api\.proxy\.subdomain/);
  });

  test('accepts a single subdomain and exposes it unchanged on the resolved package', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { proxy: { subdomain: 'api' } } },
    });
    expect(cfg.services.api.proxy?.subdomain).toBe('api');
  });

  test('accepts an array of subdomains and exposes it unchanged on the resolved package', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { proxy: { subdomain: ['api', 'api-legacy'] } } },
    });
    expect(cfg.services.api.proxy?.subdomain).toEqual(['api', 'api-legacy']);
  });

  test("`true` is the package's own name, resolved to that string everywhere it is read", () => {
    const seen: (string | undefined)[] = [];
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000 },
      services: {
        'web-api': {
          proxy: { subdomain: true },
          port: 3001,
          urls: [
            ({ subdomain }) => {
              seen.push(subdomain);
              return 'http://localhost/';
            },
          ],
        },
      },
    });
    expect(cfg.services['web-api'].proxy?.subdomain).toBe('web-api');
    expect(seen).toEqual(['web-api']);
    expect(cfg.services['web-api'].publicOrigin).toBe('http://web-api.localhost:4000');
    expect(JSON.parse(JSON.stringify(cfg)).services['web-api'].proxy?.subdomain).toBe('web-api');
  });

  test('`true` on a name that is not a DNS label is an error asking for an explicit one', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { '@scope/web': { proxy: { subdomain: true } } },
      }),
    ).toThrow(/@scope\/web[\s\S]*subdomain: true[\s\S]*DNS label[\s\S]*explicit/);
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { Web_API: { proxy: { subdomain: true } } },
      }),
    ).toThrow(/Web_API[\s\S]*subdomain: true/);
  });

  test('`true` still collides with another package claiming the same label', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          api: { proxy: { subdomain: true } },
          legacy: { proxy: { subdomain: ['old', 'api'] } },
        },
      }),
    ).toThrow(/api and legacy both declare the subdomain "api"/);
  });

  test('rejects `false`: leave the field out for no subdomain', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { api: { proxy: { subdomain: false as unknown as true } } },
      }),
    ).toThrow(/subdomain/);
  });

  test('leaves the resolved subdomain undefined when the package declares none', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { api: {} } });
    expect(cfg.services.api.proxy?.subdomain).toBeUndefined();
  });

  test('rejects two packages declaring the same subdomain, naming both', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { api: { proxy: { subdomain: 'app' } }, web: { proxy: { subdomain: 'app' } } },
      }),
    ).toThrow(/api.*web.*"app"|"app".*api.*web/);
  });

  test('rejects an alias that collides with another package subdomain', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          api: { proxy: { subdomain: ['api', 'app'] } },
          web: { proxy: { subdomain: 'app' } },
        },
      }),
    ).toThrow(/api.*web.*"app"|"app".*api.*web/);
  });

  test('hands a callback the canonical subdomain, the first entry', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test' },
      services: {
        api: {
          proxy: { subdomain: ['api', 'api-legacy'] },
          urls: [({ subdomain, tokens }) => `https://${subdomain}.${tokens.domain}`],
        },
        web: {
          proxy: { subdomain: 'web' },
          healthcheck: ({ subdomain, tokens }) => `https://${subdomain}.${tokens.domain}/health`,
        },
      },
    });
    expect(cfg.services.api.urls).toEqual(['https://api.example.test']);
    expect(cfg.services.web.healthcheck?.url).toBe('https://web.example.test/health');
  });

  // Unlike `port`, a missing subdomain is plain `undefined` — no throwing getter. The field is
  // optional data, and a callback that wants to branch on it can.
  test('hands a callback `undefined` when the package declares no subdomain', () => {
    const seen: unknown[] = [];
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        core: {
          port: 3001,
          urls: [
            ({ subdomain, port }) => {
              seen.push(subdomain);
              return subdomain === undefined ? `http://localhost:${port}` : `https://${subdomain}`;
            },
          ],
        },
      },
    });
    expect(seen).toEqual([undefined]);
    expect(cfg.services.core.urls).toEqual(['http://localhost:3001']);
  });

  test('offers no subdomain to workspace-wide urls', () => {
    const seen: unknown[] = [];
    defineConfig({
      serviceRootDir: 'packages',
      urls: [
        // @ts-expect-error workspace-wide links belong to no service, so there's no subdomain
        ({ subdomain }) => {
          seen.push(subdomain);
          return 'https://example.test';
        },
      ],
      services: { api: { proxy: { subdomain: 'api' } } },
    });
    expect(seen).toEqual([undefined]);
  });

  // A subdomain is a DNS label: the proxy that routes on it treats an empty one as the bare
  // root domain, and case or dots would make two spellings of one route.
  test.each(['api', 'api-v2', 'a1', '0x'])('accepts the DNS label %j', (subdomain) => {
    expect(
      defineConfig({ serviceRootDir: 'packages', services: { api: { proxy: { subdomain } } } })
        .services.api.proxy?.subdomain,
    ).toBe(subdomain);
  });

  test.each(['', ' api', 'Api', 'a.b', '-api', 'api-', 'api_v2'])(
    'rejects %j, naming the package and the field',
    (subdomain) => {
      expect(() =>
        defineConfig({ serviceRootDir: 'packages', services: { api: { proxy: { subdomain } } } }),
      ).toThrow(/services\.api\.proxy\.subdomain: .*lowercase letters, digits, and hyphens/);
    },
  );

  test('rejects a label longer than the 63-character DNS limit', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { api: { proxy: { subdomain: 'a'.repeat(64) } } },
      }),
    ).toThrow(/services\.api\.proxy\.subdomain: .*at most 63 characters/);
    expect(
      defineConfig({
        serviceRootDir: 'packages',
        services: { api: { proxy: { subdomain: 'a'.repeat(63) } } },
      }).services.api.proxy?.subdomain,
    ).toHaveLength(63);
  });

  test('validates every entry of an array, aliases included', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { api: { proxy: { subdomain: ['api', 'Api-Legacy'] } } },
      }),
    ).toThrow(/services\.api\.proxy\.subdomain\.1: .*lowercase letters, digits, and hyphens/);
  });
});

// The built-in dev reverse proxy: enabled by the presence of the block, resolved once at load,
// validated against the packages it will route to.
describe('devReverseProxy', () => {
  const withProxy = (
    proxy: RootedOpts['devReverseProxy'],
    services: RootedOpts['services'] = { web: { port: 3000, proxy: { subdomain: 'web' } } },
  ) => defineConfig({ serviceRootDir: 'packages', devReverseProxy: proxy, services });

  test('is absent from the resolved config when the block is omitted', () => {
    expect(
      defineConfig({ serviceRootDir: 'packages', services: { web: {} } }).devReverseProxy,
    ).toBeUndefined();
  });

  test('parses literals; a custom rootDomain defaults urlScheme to https', () => {
    const cfg = withProxy({ port: 4000, rootDomain: 'example.test' });
    expect(cfg.devReverseProxy).toEqual({
      port: 4000,
      rootDomain: 'example.test',
      rootDomains: ['example.test'],
      defaultService: undefined,
      urlScheme: 'https',
    });
  });

  test('resolves port and rootDomain callbacks over the workspace context', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      devReverseProxy: {
        port: ({ envs }) => Number(envs.DEVTOOIE_SPEC_PROXY_PORT ?? '4100'),
        rootDomain: ({ tokens }) => `example.${tokens.tld}`,
        urlScheme: 'http',
      },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(cfg.devReverseProxy).toMatchObject({
      port: 4100,
      rootDomain: 'example.test',
      urlScheme: 'http',
    });
  });

  test('rejects a port callback returning NaN, naming the field and the env files loaded', () => {
    expect(() => withProxy({ port: () => Number('nope'), rootDomain: 'example.test' })).toThrow(
      /devReverseProxy\.port: callback returned NaN[\s\S]*env files/,
    );
  });

  test('rejects a rootDomain callback returning an empty string, naming the field', () => {
    expect(() => withProxy({ port: 4000, rootDomain: () => '' })).toThrow(
      /devReverseProxy\.rootDomain: callback returned ""[\s\S]*env files/,
    );
  });

  test.each(['Example.test', 'example_test', '-example.test', 'example-.test', 'ex ample.test'])(
    'rejects the rootDomain %j as not a lowercase hostname',
    (rootDomain) => {
      expect(() => withProxy({ port: 4000, rootDomain })).toThrow(
        /devReverseProxy\.rootDomain .* is not a lowercase hostname/,
      );
    },
  );

  // An array's first entry is the canonical root, the rest aliases: every derived URL uses the
  // canonical one, and the entries must not overlap, so a Host falls under at most one.
  describe('rootDomain as an array', () => {
    test('resolves the first entry as rootDomain and keeps the full list in rootDomains', () => {
      const cfg = withProxy({ port: 4000, rootDomain: ['example.test', 'example.localhost'] });
      expect(cfg.devReverseProxy).toEqual({
        port: 4000,
        rootDomain: 'example.test',
        rootDomains: ['example.test', 'example.localhost'],
        defaultService: undefined,
        urlScheme: 'https',
      });
      expect(cfg.services.web!.publicOrigin).toBe('https://web.example.test');
    });

    test('accepts an array from the callback', () => {
      const cfg = defineConfig({
        serviceRootDir: 'packages',
        tokens: { tld: 'test' },
        devReverseProxy: {
          port: 4000,
          rootDomain: ({ tokens }) => [`example.${tokens.tld}`, 'example.localhost'],
        },
        services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
      });
      expect(cfg.devReverseProxy).toMatchObject({
        rootDomain: 'example.test',
        rootDomains: ['example.test', 'example.localhost'],
      });
    });

    test('derives the urlScheme default from the canonical entry only', () => {
      expect(withProxy({ port: 4000, rootDomain: ['localhost', 'example.test'] })).toMatchObject({
        devReverseProxy: { urlScheme: 'http' },
        services: { web: { publicOrigin: 'http://web.localhost:4000' } },
      });
      expect(withProxy({ port: 4000, rootDomain: ['example.test', 'localhost'] })).toMatchObject({
        devReverseProxy: { urlScheme: 'https' },
        services: { web: { publicOrigin: 'https://web.example.test' } },
      });
    });

    test('rejects an empty array, literal or from the callback', () => {
      expect(() => withProxy({ port: 4000, rootDomain: [] })).toThrow(
        /devReverseProxy\.rootDomain is an empty array/,
      );
      expect(() => withProxy({ port: 4000, rootDomain: () => [] })).toThrow(
        /devReverseProxy\.rootDomain callback returned an empty array/,
      );
    });

    test('rejects an entry that is not a lowercase hostname, naming its index', () => {
      expect(() =>
        withProxy({ port: 4000, rootDomain: ['example.test', 'Example.local'] }),
      ).toThrow(/devReverseProxy\.rootDomain\[1\] "Example\.local" is not a lowercase hostname/);
      expect(() => withProxy({ port: 4000, rootDomain: () => ['example.test', ''] })).toThrow(
        /devReverseProxy\.rootDomain\[1\] "" is not a lowercase hostname/,
      );
    });

    test('rejects an entry listed twice', () => {
      expect(() =>
        withProxy({
          port: 4000,
          rootDomain: ['example.test', 'example.localhost', 'example.test'],
        }),
      ).toThrow(/devReverseProxy\.rootDomain lists "example\.test" twice \(entries 0 and 2\)/);
    });

    test.each([[['example.test', 'dev.example.test']], [['dev.example.test', 'example.test']]])(
      'rejects entries where one is under the other: %j',
      (rootDomain) => {
        expect(() => withProxy({ port: 4000, rootDomain })).toThrow(
          /devReverseProxy\.rootDomain entries "dev\.example\.test" and "example\.test" overlap/,
        );
      },
    );

    test('allows entries that share a string suffix but not a label', () => {
      expect(
        withProxy({ port: 4000, rootDomain: ['example.test', 'myexample.test'] }).devReverseProxy
          ?.rootDomains,
      ).toEqual(['example.test', 'myexample.test']);
    });
  });

  test('rejects an unknown key in the block', () => {
    expect(() =>
      // @ts-expect-error `enabled` is not a field — presence of the block is what enables it
      withProxy({ port: 4000, rootDomain: 'example.test', enabled: true }),
    ).toThrow(/Unrecognized key: "enabled"/);
  });

  test('rejects a defaultService that names no declared service', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error also a compile error — the load-time check is the backstop
        devReverseProxy: { port: 4000, rootDomain: 'example.test', defaultService: 'ghost' },
        services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
      }),
    ).toThrow(/devReverseProxy\.defaultService "ghost" names no declared service/);
  });

  test('rejects a defaultService with no port', () => {
    expect(() =>
      withProxy(
        { port: 4000, rootDomain: 'example.test', defaultService: 'lib' },
        { web: { port: 3000, proxy: { subdomain: 'web' } }, lib: {} },
      ),
    ).toThrow(/devReverseProxy\.defaultService "lib" has no `port`/);
  });

  test('rejects a package that declares a subdomain but no port', () => {
    expect(() =>
      withProxy(
        { port: 4000, rootDomain: 'example.test' },
        { docs: { proxy: { subdomain: 'docs' } } },
      ),
    ).toThrow(/docs declares subdomain "docs" but no `port`/);
  });

  test('leaves a subdomain-without-port package alone when there is no proxy block', () => {
    expect(
      defineConfig({
        serviceRootDir: 'packages',
        services: { docs: { proxy: { subdomain: 'docs' } } },
      }).services.docs.port,
    ).toBe(undefined);
  });

  test("rejects a proxy port equal to a package's port", () => {
    expect(() => withProxy({ port: 3000, rootDomain: 'example.test' })).toThrow(
      /devReverseProxy\.port 3000 is also web's port/,
    );
  });

  test('adds no footer link of its own: urls hold only what the config lists', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'example.test', defaultService: 'web' },
      services: {
        web: { port: 3000, proxy: { subdomain: ['web', 'www'] }, urls: [({ port }) => `http://localhost:${port}`] }, // oxfmt-ignore
        api: { port: 3001, proxy: { subdomain: 'api' } },
        worker: { port: 3002 },
        lib: {},
      },
    });
    expect(cfg.services.web.urls).toEqual(['http://localhost:3000']);
    expect(cfg.services.api.urls).toBeUndefined();
    expect(cfg.services.worker.urls).toBeUndefined();
    expect(cfg.services.lib.urls).toBeUndefined();
    // The public origin is still there for a `''` entry (and PUBLIC_ORIGIN) to build on.
    expect(cfg.services.web.publicOrigin).toBe('https://web.example.test');
  });

  test('uses urlScheme for the public origin (http carries the proxy port)', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'example.test', urlScheme: 'http' },
      services: { web: { port: 3000, proxy: { subdomain: 'web' }, urls: ['/'] } },
    });
    expect(cfg.services.web.publicOrigin).toBe('http://web.example.test:4000');
    expect(cfg.services.web.urls).toEqual(['http://web.example.test:4000']);
  });

  test('exposes the public origin of a routable package on the resolved config, and nothing for the rest', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'example.test' },
      services: {
        web: { port: 3000, proxy: { subdomain: ['web', 'www'] } },
        worker: { port: 3002 },
      },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://web.example.test');
    expect(cfg.services.worker.publicOrigin).toBeUndefined();
    const noProxy = defineConfig({
      serviceRootDir: 'packages',
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(noProxy.services.web.publicOrigin).toBeUndefined();
  });

  test('gives a defaultService with no proxy the bare root as its public origin', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: {
        port: 4000,
        rootDomain: ['example.test', 'example.localhost'],
        defaultService: 'landing',
      },
      services: { landing: { port: 3000, urls: ['', '/pricing'] }, worker: { port: 3001 } },
    });
    expect(cfg.services.landing.publicOrigin).toBe('https://example.test');
    expect(cfg.services.landing.urls).toEqual([
      'https://example.test',
      'https://example.test/pricing',
    ]);
    expect(cfg.services.worker.publicOrigin).toBeUndefined();
    expect(packageEnvLayer(cfg.services.landing, { cwd: os.tmpdir() })).toMatchObject({
      PORT: '3000',
      PUBLIC_ORIGIN: 'https://example.test',
    });
  });

  test('carries the proxy port on the bare-root origin under http', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, defaultService: 'landing' },
      services: { landing: { port: 3000 } },
    });
    expect(cfg.services.landing.publicOrigin).toBe('http://localhost:4000');
  });

  test('keeps the subdomain origin for a defaultService that declares a subdomain', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'example.test', defaultService: 'web' },
      services: { web: { port: 3000, proxy: { subdomain: 'www' } } },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://www.example.test');
  });

  test('injects PUBLIC_ORIGIN next to PORT, and an explicit .env PUBLIC_ORIGIN wins', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-origin-')));
    try {
      fs.mkdirSync(path.join(dir, 'packages/web'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'packages/api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'packages/api/.env'), 'PUBLIC_ORIGIN=https://api.override\n');
      const cfg = defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: dir,
        devReverseProxy: { port: 4000, rootDomain: 'example.test' },
        services: {
          web: { port: 3000, proxy: { subdomain: 'web' } },
          api: { port: 3001, proxy: { subdomain: 'api' } },
        },
      });
      const layer = (pkg: AnyServiceConfig) => packageEnvLayer(pkg, { cwd: dir });
      expect(layer(cfg.services.web)).toMatchObject({
        PORT: '3000',
        PUBLIC_ORIGIN: 'https://web.example.test',
      });
      expect(layer(cfg.services.api)).toMatchObject({
        PORT: '3001',
        PUBLIC_ORIGIN: 'https://api.override',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The port of the public URLs follows the scheme: `http` means the browser hits the proxy itself,
// so its own port (`http://web.localhost:4000`); `https` means a TLS terminator sits in front, so
// no port.
describe('public URL port', () => {
  test('is the proxy port under http', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'localhost', defaultService: 'web' },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(cfg.services.web.publicOrigin).toBe('http://web.localhost:4000');
    expect(cfg.services.web.urls).toBeUndefined();
  });

  test('is absent under https', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'localhost', urlScheme: 'https' },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://web.localhost');
  });
});

// `rootDomain` defaults to `localhost`, and the scheme follows the root: `http` on `localhost`
// (nothing in front, so the URLs carry the proxy port), `https` on any other root (a TLS
// terminator in front, so no port). Both stay overridable.
describe('devReverseProxy defaults from rootDomain', () => {
  test('rootDomain defaults to localhost, with http and the proxy port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000 },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(cfg.devReverseProxy).toEqual({
      port: 4000,
      rootDomain: 'localhost',
      rootDomains: ['localhost'],
      defaultService: undefined,
      urlScheme: 'http',
    });
    expect(cfg.services.web.publicOrigin).toBe('http://web.localhost:4000');
  });

  test('a custom rootDomain implies https with no port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(cfg.devReverseProxy).toMatchObject({ urlScheme: 'https' });
    expect(cfg.devReverseProxy).not.toHaveProperty('urlPort');
    expect(cfg.services.web.publicOrigin).toBe('https://web.myproject.example.test');
  });

  test('an explicit urlScheme overrides the root-derived default', () => {
    const plainTerminator = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test', urlScheme: 'http' },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(plainTerminator.services.web.publicOrigin).toBe(
      'http://web.myproject.example.test:4000',
    );
    const tlsOnLocalhost = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, urlScheme: 'https' },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expect(tlsOnLocalhost.services.web.publicOrigin).toBe('https://web.localhost');
  });
});

// A `urls` entry may be a path: resolved against the package's public origin under the dev
// reverse proxy, else against `http://localhost:<port>` — one link either way, never both.
describe('path urls', () => {
  test('resolve against http://localhost:<port> without a proxy', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, urls: ['/todos', { label: 'health', url: '/health' }] } },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://localhost:3001/todos',
      { label: 'health', url: 'http://localhost:3001/health' },
    ]);
  });

  test('resolve against the public origin under the proxy, and only that', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: {
        api: {
          port: 3001,
          proxy: { subdomain: 'api' },
          urls: ['/todos', [{ label: 'a', url: '/a' }, '/b']],
        },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'https://api.myproject.example.test/todos',
      [
        { label: 'a', url: 'https://api.myproject.example.test/a' },
        'https://api.myproject.example.test/b',
      ],
    ]);
  });

  test('fall back to localhost for a package the proxy does not route', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000 },
      services: { worker: { port: 3002, urls: ['/metrics'] } },
    });
    expect(cfg.services.worker.urls).toEqual(['http://localhost:3002/metrics']);
  });

  test('a callback may return a path too', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, urls: [({ tokens }) => `/${tokens.section ?? 'todos'}`] } },
    });
    expect(cfg.services.api.urls).toEqual(['http://localhost:3001/todos']);
  });

  test('leave absolute urls alone', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000 },
      services: {
        api: { port: 3001, proxy: { subdomain: 'api' }, urls: ['https://status.example.test'] },
      },
    });
    expect(cfg.services.api.urls).toEqual(['https://status.example.test']);
  });

  test('reject a path on a package with no port to base it on, naming both', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { docs: { urls: ['/index.html'] } } }),
    ).toThrow(/docs urls: "\/index\.html" is a path, but this service declares no `port`/);
  });

  test('reject a path in the workspace-wide urls', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', urls: ['/status'], services: { api: {} } }),
    ).toThrow(/top-level url: "\/status" is a path, but workspace-wide urls belong to no service/);
  });
});

// A path `healthcheck` always resolves against the package itself on loopback — never the public
// origin, since devtooie's own proxy holds requests until this very probe passes. The resolved
// `url` is what the status probe polls.
describe('path healthchecks', () => {
  test('resolve against http://localhost:<port>, bare and in the object form', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: '/health' },
        web: { port: 3000, healthcheck: { url: '/', timeout: 5000 } },
      },
    });
    expect(cfg.services.api.healthcheck).toEqual({ url: 'http://localhost:3001/health', timeout: 1500 }); // oxfmt-ignore
    expect(cfg.services.web.healthcheck).toEqual({ url: 'http://localhost:3000', timeout: 5000 });
  });

  test('ignore the public origin even for a package the proxy routes', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: {
        api: { port: 3001, proxy: { subdomain: 'api' }, healthcheck: '/health', urls: ['/todos'] },
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/health');
    expect(cfg.services.api.urls).toContain('https://api.myproject.example.test/todos');
  });

  test('a callback may return a path too', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, healthcheck: () => '/ready' } },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/ready');
  });

  test('reject a path on a package with no port, naming both', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { docs: { healthcheck: '/' } } }),
    ).toThrow(/docs healthcheck: "\/" is a path, but this service declares no `port`/);
  });
});

// A relative path may be written with or without the leading slash; both forms resolve alike.
describe('paths without a leading slash', () => {
  test('urls: `todos` is `/todos`', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: {
        api: {
          port: 3001,
          proxy: { subdomain: 'api' },
          urls: ['todos', { label: 'x', url: 'a/b?c=1' }],
        },
        worker: { port: 3002, urls: ['metrics'] },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'https://api.myproject.example.test/todos',
      { label: 'x', url: 'https://api.myproject.example.test/a/b?c=1' },
    ]);
    expect(cfg.services.worker.urls).toEqual(['http://localhost:3002/metrics']);
  });

  test("'' is the origin itself, with no trailing slash", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: {
        api: { port: 3001, proxy: { subdomain: 'api' }, urls: [''], healthcheck: '' },
        worker: { port: 3002, urls: [{ label: 'root', url: '' }] },
      },
    });
    expect(cfg.services.api.urls).toEqual(['https://api.myproject.example.test']);
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001');
    expect(cfg.services.worker.urls).toEqual([{ label: 'root', url: 'http://localhost:3002' }]);
  });

  test('healthcheck: `health` is `/health`', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, healthcheck: 'health' } },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/health');
  });

  test('anything with a scheme is left alone', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: 'HTTP://127.0.0.1:3001/health', urls: ['ws://localhost:3001/socket'] }, // oxfmt-ignore
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('HTTP://127.0.0.1:3001/health');
    expect(cfg.services.api.urls).toEqual(['ws://localhost:3001/socket']);
  });
});

// A path's trailing slash is dropped, so `/todos/` is `/todos` and `/` is `''` — the origin.
describe('paths with a trailing slash', () => {
  test('urls: `/todos/` is `/todos`, with or without the proxy', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: {
        api: {
          port: 3001,
          proxy: { subdomain: 'api' },
          urls: ['/todos/', { label: 'x', url: 'a/b/' }],
        },
        worker: { port: 3002, urls: ['/metrics/', ['jobs/', '/queues//']] },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'https://api.myproject.example.test/todos',
      { label: 'x', url: 'https://api.myproject.example.test/a/b' },
    ]);
    expect(cfg.services.worker.urls).toEqual([
      'http://localhost:3002/metrics',
      ['http://localhost:3002/jobs', 'http://localhost:3002/queues'],
    ]);
  });

  test("urls: `/` is `''`, the origin itself", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'myproject.example.test' },
      services: {
        api: { port: 3001, proxy: { subdomain: 'api' }, urls: ['/'] },
        worker: { port: 3002, urls: ['/', '//'] },
      },
    });
    expect(cfg.services.api.urls).toEqual(['https://api.myproject.example.test']);
    expect(cfg.services.worker.urls).toEqual(['http://localhost:3002', 'http://localhost:3002']);
  });

  test('healthcheck: `/health/` is `/health`, and `/` the origin', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: '/health/' },
        web: { port: 3000, healthcheck: '/' },
        worker: { port: 3002, healthcheck: () => 'ready/' },
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/health');
    expect(cfg.services.web.healthcheck?.url).toBe('http://localhost:3000');
    expect(cfg.services.worker.healthcheck?.url).toBe('http://localhost:3002/ready');
  });

  test('only the path loses its slash, never a query or fragment', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, urls: ['/a/b/?c=1', '/login?next=/', '/docs/#intro/', '/?tab=/'] },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://localhost:3001/a/b?c=1',
      'http://localhost:3001/login?next=/',
      'http://localhost:3001/docs#intro/',
      'http://localhost:3001?tab=/',
    ]);
  });

  test('an absolute url keeps its trailing slash', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: 'http://127.0.0.1:3001/health/', urls: ['https://status.example.test/'] }, // oxfmt-ignore
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://127.0.0.1:3001/health/');
    expect(cfg.services.api.urls).toEqual(['https://status.example.test/']);
  });
});

describe('infra', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-infra-'));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const withInfra = (infra: unknown) =>
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      infra: infra as RootedOpts['infra'],
      services: { web: {} },
    });

  test('is absent from the resolved config when the block is omitted', () => {
    expect(
      defineConfig({ serviceRootDir: 'packages', services: { web: {} } }).infra,
    ).toBeUndefined();
  });

  test('an empty docker-compose block is a complete config, with defaults applied', () => {
    const cfg = withInfra({ 'docker-compose': {} });
    expect(cfg.infra).toEqual({
      'docker-compose': {
        file: undefined,
        projectName: `${path.basename(ws).toLowerCase()}-development`,
        readyTimeout: 300_000,
        services: {},
      },
    });
  });

  test('`true` for a provider is the same as an empty block', () => {
    expect(withInfra({ 'docker-compose': true }).infra).toEqual(
      withInfra({ 'docker-compose': {} }).infra,
    );
    expect(() => withInfra({ 'docker-compose': false })).toThrow(/infra/);
  });

  test('rejects an infra block naming no provider', () => {
    expect(() => withInfra({})).toThrow(/infra[\s\S]*docker-compose/);
  });

  test('rejects an unknown provider and an unknown service field', () => {
    expect(() => withInfra({ podman: {} })).toThrow(/infra/);
    expect(() => withInfra({ 'docker-compose': { services: { db: { onStarted() {} } } } })).toThrow(
      /infra/,
    );
  });

  test('rejects a callback that is not a function', () => {
    expect(() =>
      withInfra({ 'docker-compose': { services: { db: { afterReady: 'migrate' } } } }),
    ).toThrow(/afterReady[\s\S]*function|function[\s\S]*afterReady/);
  });

  test('rejects a non-positive readyTimeout', () => {
    expect(() => withInfra({ 'docker-compose': { readyTimeout: 0 } })).toThrow(/readyTimeout/);
  });

  test('resolves `file` to an absolute path under the workspace', () => {
    const cfg = withInfra({ 'docker-compose': { file: './infra/compose.yaml', readyTimeout: 5 } });
    expect(cfg.infra?.['docker-compose']).toMatchObject({
      file: path.join(ws, 'infra', 'compose.yaml'),
      readyTimeout: 5,
    });
  });

  test('takes the project name from COMPOSE_PROJECT_NAME in a workspace .env file', () => {
    fs.writeFileSync(path.join(ws, '.env'), 'COMPOSE_PROJECT_NAME=from-env-file\n');
    expect(withInfra({ 'docker-compose': {} }).infra?.['docker-compose']?.projectName).toBe(
      'from-env-file',
    );
  });

  test('keeps the callbacks by identity, and JSON drops them', () => {
    const afterReady = async () => {};
    const cfg = withInfra({ 'docker-compose': { services: { db: { afterReady } } } });
    expect(cfg.infra?.['docker-compose']?.services.db?.afterReady).toBe(afterReady);
    expect(JSON.parse(JSON.stringify(cfg)).infra['docker-compose'].services).toEqual({
      db: { enabled: true },
    });
  });

  test('enabled defaults to true, takes a literal, and resolves a callback over mode, envs and tokens', () => {
    fs.writeFileSync(path.join(ws, '.env'), 'TRACING_KEY=abc\n');
    const seen: unknown[] = [];
    const cfg = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      tokens: { region: 'eu' },
      infra: {
        'docker-compose': {
          services: {
            db: {},
            emulator: { enabled: false },
            tracing: {
              enabled: ({ mode, envs, tokens }) => {
                seen.push({ mode, region: tokens.region });
                return mode !== 'test' && Boolean(envs.TRACING_KEY);
              },
            },
            mailer: { enabled: ({ envs }) => Boolean(envs.DEVTOOIE_SPEC_NO_SUCH_VAR) },
          },
        },
      },
      services: { web: {} },
    });
    const services = cfg.infra!['docker-compose']!.services;
    expect(services.db!.enabled).toBe(true);
    expect(services.emulator!.enabled).toBe(false);
    expect(services.tracing!.enabled).toBe(true);
    expect(services.mailer!.enabled).toBe(false);
    expect(seen).toEqual([{ mode: 'development', region: 'eu' }]);
  });

  test('rejects an enabled callback that does not return a boolean, naming the service', () => {
    expect(() =>
      withInfra({ 'docker-compose': { services: { tracing: { enabled: () => 'yes' } } } }),
    ).toThrow(/infra[\s\S]*enabled[\s\S]*"tracing"[\s\S]*"yes"[\s\S]*boolean/);
    expect(() =>
      withInfra({ 'docker-compose': { services: { tracing: { enabled: 'yes' } } } }),
    ).toThrow(/enabled/);
  });
});

// An infra service's `port` and `proxy`: on the service type every provider shares, resolved over
// the workspace context, and checked against the packages and the dev reverse proxy.
describe('infra service port and proxy', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-infra-proxy-'));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  type Services = NonNullable<
    Exclude<NonNullable<RootedOpts['infra']>['docker-compose'], true | undefined>['services']
  >;
  const withServices = (
    services: Services,
    opts: Partial<Pick<RootedOpts, 'devReverseProxy' | 'services'>> = {},
  ) =>
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      devReverseProxy: opts.devReverseProxy,
      infra: { 'docker-compose': { services } },
      services: opts.services ?? { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
  const proxied = { devReverseProxy: { port: 4000, rootDomain: 'example.test' } };

  test('resolves a literal port, a port callback over envs and tokens, and the proxy', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'MAIL_UI_PORT=8025\n');
    const seen: unknown[] = [];
    const cfg = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      devReverseProxy: { port: 4000, rootDomain: 'example.test' },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: ({ envs, tokens }) => {
                seen.push(tokens.tld);
                return Number(envs.MAIL_UI_PORT);
              },
              proxy: { subdomain: true },
            },
            store: { port: 9000, proxy: { subdomain: ['s3', 'files'] } },
            db: { port: 5432 },
          },
        },
      },
      services: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    const services = cfg.infra!['docker-compose']!.services;
    expect(seen).toEqual(['test']);
    expect(services.mail).toMatchObject({
      enabled: true,
      port: 8025,
      proxy: { subdomain: 'mail' },
      publicOrigin: 'https://mail.example.test',
    });
    // The canonical subdomain is the first; aliases route but don't make the origin.
    expect(services.store).toMatchObject({ port: 9000, publicOrigin: 'https://s3.example.test' });
    expect(services.db).toMatchObject({ port: 5432, publicOrigin: undefined });
    // What show-config prints and outside tooling reads.
    expect(JSON.parse(JSON.stringify(cfg)).infra['docker-compose'].services.mail).toEqual({
      enabled: true,
      port: 8025,
      proxy: { subdomain: 'mail' },
      publicOrigin: 'https://mail.example.test',
    });
  });

  test('has no public origin without a devReverseProxy, but keeps port and proxy as data', () => {
    const mail = withServices({ mail: { port: 8025, proxy: { subdomain: 'mail' } } }).infra![
      'docker-compose'
    ]!.services.mail!;
    expect(mail).toMatchObject({ port: 8025, proxy: { subdomain: 'mail' }, publicOrigin: undefined }); // oxfmt-ignore
  });

  test('uses the proxy port in the public origin under http', () => {
    const cfg = withServices(
      { mail: { port: 8025, proxy: { subdomain: 'mail' } } },
      { devReverseProxy: { port: 4000 } },
    );
    expect(cfg.infra!['docker-compose']!.services.mail!.publicOrigin).toBe(
      'http://mail.localhost:4000',
    );
  });

  test('resolves `urls` like a package: paths on the public origin, labels and absolute urls kept', () => {
    const services = withServices(
      {
        mail: { port: 8025, proxy: { subdomain: 'mail' }, urls: ['', { label: 'inbox', url: '/inbox' }] }, // oxfmt-ignore
        store: { port: 9000, urls: [['https://console.example.test', '/minio']] },
        db: { port: 5432 },
      },
      proxied,
    ).infra!['docker-compose']!.services;
    expect(services.mail!.urls).toEqual([
      'https://mail.example.test',
      { label: 'inbox', url: 'https://mail.example.test/inbox' },
    ]);
    // Not routed by the proxy: a path is based on the service's port on loopback.
    expect(services.store!.urls).toEqual([
      ['https://console.example.test', 'http://localhost:9000/minio'],
    ]);
    // No `urls`, no links: devtooie adds none of its own.
    expect(services.db!.urls).toBeUndefined();
  });

  test("a `urls` callback gets the workspace context with the service's port and subdomain", () => {
    const seen: unknown[] = [];
    withServices(
      {
        mail: {
          port: 8025,
          proxy: { subdomain: ['mail', 'smtp'] },
          urls: [
            (ctx) => {
              seen.push({ port: ctx.port, subdomain: ctx.subdomain, mode: ctx.envs.DEVTOOIE_MODE });
              return '/';
            },
          ],
        },
      },
      proxied,
    );
    expect(seen).toEqual([{ port: 8025, subdomain: 'mail', mode: 'development' }]);
  });

  test("rejects a path in a service's `urls` when it has no port, naming the service", () => {
    expect(() => withServices({ mail: { urls: ['/'] } })).toThrow(
      /infra service "mail" urls: "\/" is a path, but this service declares no `port`/,
    );
    expect(() =>
      withServices({ mail: { urls: [({ port }) => `http://localhost:${port}`] } }),
    ).toThrow(
      /infra service "mail" urls: a callback read `port`, but this service declares no `port`/,
    );
  });

  test("doesn't resolve a disabled service's `urls`", () => {
    let calls = 0;
    const mail = withServices({
      mail: {
        enabled: false,
        urls: [
          () => {
            calls += 1;
            return '/';
          },
        ],
      },
    }).infra!['docker-compose']!.services.mail!;
    expect(calls).toBe(0);
    expect(mail.urls).toBeUndefined();
  });

  test("a service switched off for the mode gets no public origin, and its port callback doesn't run", () => {
    let calls = 0;
    const cfg = withServices(
      {
        mail: {
          enabled: false,
          port: () => {
            calls += 1;
            return Number(undefined);
          },
          proxy: { subdomain: 'mail' },
        },
      },
      proxied,
    );
    expect(calls).toBe(0);
    expect(cfg.infra!['docker-compose']!.services.mail).toMatchObject({
      enabled: false,
      port: undefined,
      proxy: { subdomain: 'mail' },
      publicOrigin: undefined,
    });
  });

  test('rejects a port callback returning NaN, naming the service and the env files loaded', () => {
    expect(() =>
      withServices({ mail: { port: () => Number(undefined), proxy: { subdomain: 'mail' } } }),
    ).toThrow(/infra service "mail": port callback returned NaN[\s\S]*env files/);
  });

  test('rejects a proxy with no port, naming the service — enabled or not, proxy block or not', () => {
    expect(() => withServices({ mail: { proxy: { subdomain: 'mail' } } }, proxied)).toThrow(
      /infra service "mail" declares `proxy` but no `port`/,
    );
    expect(() => withServices({ mail: { proxy: { subdomain: 'mail' } } })).toThrow(
      /infra service "mail" declares `proxy` but no `port`/,
    );
    expect(() =>
      withServices({ mail: { enabled: false, proxy: { subdomain: 'mail' } } }, proxied),
    ).toThrow(/infra service "mail" declares `proxy` but no `port`/);
    // A port callback that answers "no port" is the same mistake.
    expect(() =>
      withServices({ mail: { port: () => undefined, proxy: { subdomain: 'mail' } } }, proxied),
    ).toThrow(/infra service "mail" declares subdomain "mail" but no `port`/);
  });

  test("rejects a service port equal to the proxy's, naming the service", () => {
    expect(() =>
      withServices({ mail: { port: 4000, proxy: { subdomain: 'mail' } } }, proxied),
    ).toThrow(/devReverseProxy\.port 4000 is also infra service "mail"'s port/);
  });

  test("rejects a service port equal to a package's, naming both — with or without a proxy", () => {
    for (const opts of [{}, proxied]) {
      expect(() =>
        withServices({ mail: { port: 3000, proxy: { subdomain: 'mail' } } }, opts),
      ).toThrow(/infra service "mail" has port 3000, which is also the service web's/);
    }
    // A service with no proxy still claims its port on the host.
    expect(() => withServices({ db: { port: 3000 } })).toThrow(
      /infra service "db" has port 3000, which is also the service web's/,
    );
  });

  test('rejects two services on one port, naming both', () => {
    expect(() => withServices({ a: { port: 9000 }, b: { port: 9000 } })).toThrow(
      /infra service "b" has port 9000, which is also infra service "a"'s/,
    );
  });

  test('ignores a disabled service in the port checks: it claims no port', () => {
    expect(
      withServices({ mail: { enabled: false, port: 3000, proxy: { subdomain: 'mail' } } }, proxied)
        .infra!['docker-compose']!.services.mail!.enabled,
    ).toBe(false);
  });

  test('rejects a service subdomain or alias another package or service declares, naming both', () => {
    expect(() => withServices({ mail: { port: 8025, proxy: { subdomain: 'web' } } })).toThrow(
      /web and infra service "mail" both declare the subdomain "web"/,
    );
    expect(() =>
      withServices({ mail: { port: 8025, proxy: { subdomain: ['mail', 'web'] } } }),
    ).toThrow(/web and infra service "mail" both declare the subdomain "web"/);
    expect(() =>
      withServices({
        mail: { port: 8025, proxy: { subdomain: 'mail' } },
        store: { port: 9000, proxy: { subdomain: ['s3', 'mail'] } },
      }),
    ).toThrow(/infra service "mail" and infra service "store" both declare the subdomain "mail"/);
    // `true` is the key, and collides like any other label — even for a disabled service.
    expect(() =>
      withServices({ web: { enabled: false, port: 8025, proxy: { subdomain: true } } }),
    ).toThrow(/web and infra service "web" both declare the subdomain "web"/);
  });

  test('applies the DNS-label rules to a service subdomain, naming the field', () => {
    expect(() => withServices({ mail: { port: 8025, proxy: { subdomain: 'Mail' } } })).toThrow(
      /infra\.docker-compose\.services\.mail\.proxy\.subdomain: .*lowercase letters, digits, and hyphens/,
    );
    expect(() =>
      withServices({ mail: { port: 8025, proxy: { subdomain: ['mail', 'a'.repeat(64)] } } }),
    ).toThrow(/infra\.docker-compose\.services\.mail\.proxy\.subdomain\.1: .*at most 63/);
  });

  test("`true` on a service key that isn't a DNS label asks for an explicit subdomain", () => {
    expect(() =>
      withServices({ object_store: { port: 9000, proxy: { subdomain: true } } }),
    ).toThrow(
      /infra service "object_store": `subdomain: true` uses the service's key[\s\S]*explicit/,
    );
  });

  test('rejects an unknown option in a service proxy block', () => {
    expect(() =>
      // @ts-expect-error `proxy` takes `subdomain` only
      withServices({ mail: { port: 8025, proxy: { subdomain: 'mail', scheme: 'https' } } }),
    ).toThrow(/infra\.docker-compose\.services\.mail\.proxy: Unrecognized key: "scheme"/);
  });
});

describe('env vars', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-env-vars-'));
    fs.mkdirSync(path.join(ws, 'packages/api'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.DEVTOOIE_TEST_AMBIENT;
  });

  const base = () => ({ serviceRootDir: 'packages' as const, workspaceDir: ws });

  test('stores a literal env.vars record on the resolved config', () => {
    const cfg = defineConfig({
      ...base(),
      env: { vars: { DATA_DIR: '/srv/data' } },
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ DATA_DIR: '/srv/data' });
  });

  test('is undefined on a config that declares none', () => {
    const cfg = defineConfig({ ...base(), env: { override: true }, services: { api: {} } });
    expect(cfg.envVars).toBeUndefined();
  });

  test('hands an env.vars callback the workspace env and the top-level tokens', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'REGION=eu\n');
    process.env.DEVTOOIE_TEST_AMBIENT = 'from-shell';
    const cfg = defineConfig({
      ...base(),
      tokens: { tier: 'dev' },
      env: {
        vars: ({ envs, tokens }) => ({
          BUCKET: `${tokens.tier}-${String(envs.REGION)}-${String(envs.DEVTOOIE_TEST_AMBIENT)}`,
        }),
      },
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ BUCKET: 'dev-eu-from-shell' });
  });

  test('takes the callback itself as `env`, shorthand for `env.vars`', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'REGION=eu\n');
    const cfg = defineConfig({
      ...base(),
      env: ({ envs }) => ({ BUCKET: `dev-${String(envs.REGION)}` }),
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ BUCKET: 'dev-eu' });
    expect(cfg.envOverride).toBeUndefined();
  });

  test('keeps env.override next to env.vars', () => {
    const cfg = defineConfig({
      ...base(),
      env: { vars: { DATA_DIR: '/srv/data' }, override: ['NODE_OPTIONS'] },
      services: { api: {} },
    });
    expect(cfg.envOverride).toEqual(['NODE_OPTIONS']);
  });

  test('drops a variable whose value is undefined', () => {
    const cfg = defineConfig({
      ...base(),
      env: ({ envs }) => ({ KEPT: 'yes', DROPPED: envs.DEVTOOIE_SPEC_NO_SUCH_VAR }),
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ KEPT: 'yes' });
  });

  test('rejects a callback value that is not a string, naming the variable and the env files', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=5432\n');
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - a variable's value must be a string (or undefined).
        env: ({ envs }) => ({ DB_PORT: Number(envs.DB_PORT) }),
        services: { api: {} },
      }),
    ).toThrow(
      /env\.vars: DB_PORT is 5432 \(a number\) — an environment variable must be a string[\s\S]*env files loaded: .*\.env\.development/,
    );
  });

  test('rejects a literal value that is not a string, naming the variable', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - a variable's value must be a string (or undefined).
        env: { vars: { DB_PORT: 5432 } },
        services: { api: {} },
      }),
    ).toThrow(
      /env\.vars: DB_PORT is 5432 \(a number\) — an environment variable must be a string$/,
    );
  });

  test('rejects an env.vars that is neither a record nor a callback', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - `vars` is a record of variables or a callback.
        env: { vars: 'DATA_DIR=/srv/data' },
        services: { api: {} },
      }),
    ).toThrow(/env\.vars: env\.vars must be an object of variables or a function/);
  });

  test('rejects a callback that returns a promise rather than a record', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - callbacks are synchronous.
        env: async () => ({ DATA_DIR: '/srv/data' }),
        services: { api: {} },
      }),
    ).toThrow(
      /env\.vars: callback returned \[object Promise\] \(expected an object of variables\)/,
    );
  });

  test('rejects a name no .env file could carry', () => {
    expect(() =>
      defineConfig({
        ...base(),
        env: { vars: { 'DATA DIR': '/srv/data' } },
        services: { api: {} },
      }),
    ).toThrow(/env\.vars: "DATA DIR" is not a valid environment variable name/);
  });

  describe('with no devtooie CLI around the config', () => {
    const names = ['DEVTOOIE_MODE', 'DEVTOOIE_CWD', 'DEVTOOIE_WORKSPACE_DIR'] as const;
    let before: (string | undefined)[];

    beforeEach(() => {
      before = names.map((name) => process.env[name]);
      for (const name of names) {
        delete process.env[name];
      }
    });

    afterEach(() => {
      names.forEach((name, i) => {
        if (before[i] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = before[i];
        }
      });
    });

    test('still hands a callback the variables devtooie sets', () => {
      const cfg = defineConfig({
        ...base(),
        env: ({ envs }) => ({
          SEEN: [envs.DEVTOOIE_MODE, envs.DEVTOOIE_CWD, envs.DEVTOOIE_WORKSPACE_DIR].join('|'),
        }),
        services: {
          api: { urls: [({ envs }) => `file://${String(envs.DEVTOOIE_WORKSPACE_DIR)}`] },
        },
      });
      expect(cfg.envVars).toEqual({ SEEN: `development|${process.cwd()}|${path.resolve(ws)}` });
      expect(cfg.services.api.urls).toEqual([`file://${path.resolve(ws)}`]);
    });

    test('leaves the ones the environment already has as they are', () => {
      process.env.DEVTOOIE_WORKSPACE_DIR = '/from/the/cli';
      const cfg = defineConfig({
        ...base(),
        env: ({ envs }) => ({ SEEN: envs.DEVTOOIE_WORKSPACE_DIR }),
        services: { api: {} },
      });
      expect(cfg.envVars).toEqual({ SEEN: '/from/the/cli' });
    });
  });

  test('rejects a callback that returns no record', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - the callback must return a record of variables.
        env: () => 'DATA_DIR=/srv/data',
        services: { api: {} },
      }),
    ).toThrow(/env\.vars: callback returned "DATA_DIR=\/srv\/data" \(expected an object/);
  });

  test("puts the variables in every later callback's envs", () => {
    const seen: Record<string, string | undefined> = {};
    const cfg = defineConfig({
      ...base(),
      env: { vars: { BASE_PORT: '4100', HOST: 'dev.example' } },
      devReverseProxy: {
        port: ({ envs }) => Number(envs.BASE_PORT) + 50,
        rootDomain: ({ envs }) => envs.HOST!,
      },
      urls: [({ envs }) => `https://docs.${envs.HOST!}`],
      infra: {
        'docker-compose': {
          services: {
            db: {
              enabled: ({ envs }) => {
                seen.infra = envs.HOST;
                return true;
              },
            },
          },
        },
      },
      services: {
        api: {
          port: ({ envs }) => Number(envs.BASE_PORT),
          urls: [({ envs, port }) => `http://${envs.HOST!}:${String(port)}`],
        },
      },
    });
    expect(cfg.devReverseProxy).toMatchObject({ port: 4150, rootDomain: 'dev.example' });
    expect(cfg.urls).toEqual(['https://docs.dev.example']);
    expect(cfg.services.api.port).toBe(4100);
    expect(cfg.services.api.urls).toEqual(['http://dev.example:4100']);
    expect(seen.infra).toBe('dev.example');
  });

  test("loses to an env file in a later callback: the workspace's, then the package's", () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'REGION=eu\nBACKEND_PORT=6666\n');
    fs.writeFileSync(path.join(ws, 'packages/api/.env.development'), 'BACKEND_PORT=7777\n');
    const seen: Record<string, string | undefined> = {};
    const cfg = defineConfig({
      ...base(),
      env: { vars: { BACKEND_PORT: '4321', REGION: 'us', TIER: 'dev' } },
      urls: [({ envs }) => `https://${envs.REGION!}.example:${envs.BACKEND_PORT!}`],
      services: {
        api: {
          port: ({ envs }) => {
            seen.region = envs.REGION;
            seen.tier = envs.TIER;
            return Number(envs.BACKEND_PORT);
          },
        },
      },
    });
    expect(cfg.urls).toEqual(['https://eu.example:6666']);
    expect(cfg.services.api.port).toBe(7777);
    expect(seen).toEqual({ region: 'eu', tier: 'dev' });
  });

  test('loses to the ambient environment in a later callback, unless env.override names it', () => {
    process.env.DEVTOOIE_TEST_AMBIENT = 'from-shell';
    const seenBy = (override?: string[]) => {
      let seen: string | undefined;
      defineConfig({
        ...base(),
        env: { vars: { DEVTOOIE_TEST_AMBIENT: 'from-config' }, override },
        services: {
          api: {
            port: ({ envs }) => {
              seen = envs.DEVTOOIE_TEST_AMBIENT;
              return 4321;
            },
          },
        },
      });
      return seen;
    };
    expect(seenBy()).toBe('from-shell');
    expect(seenBy(['DEVTOOIE_TEST_AMBIENT'])).toBe('from-config');
  });

  test("expands an env file's reference to a variable, for a later callback", () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'API_URL=http://${HOST}:4100\n');
    const cfg = defineConfig({
      ...base(),
      env: { vars: { HOST: 'dev.example' } },
      urls: [({ envs }) => envs.API_URL!],
      services: { api: {} },
    });
    expect(cfg.urls).toEqual(['http://dev.example:4100']);
  });

  test('names the compose project from a variable it sets', () => {
    const cfg = defineConfig({
      ...base(),
      env: { vars: { COMPOSE_PROJECT_NAME: 'pinned' } },
      infra: { 'docker-compose': true },
      services: { api: {} },
    });
    expect(cfg.infra?.['docker-compose']?.projectName).toBe('pinned');
  });

  test('still rejects an unknown key next to env.vars', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - `files` was removed; the schema must say so rather than strip it.
        env: { vars: { DATA_DIR: '/srv/data' }, files: ['.env'] },
        services: { api: {} },
      }),
    ).toThrow(/Unrecognized key: "files"/);
  });
});

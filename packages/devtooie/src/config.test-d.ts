/**
 * Type-level tests for `defineConfig`'s inference. Run with `pnpm test:types`.
 *
 * These assert **specific types**, not merely "this line errors" — a `@ts-expect-error` passes
 * for any reason at all, which once hid a bug here (a token-typo assertion was passing only
 * because the value was `string | undefined`, not because the key was unknown).
 *
 * `expectTypeOf` is erased at runtime, so the surrounding `defineConfig` calls still execute;
 * that's deliberate, since it keeps the assertions on the real inference path. Note the
 * type-only form `expectTypeOf<(typeof ctx)['port']>()` for a package with no `port` — the
 * value form would *read* `port` and throw at load time by design.
 */
import { describe, it, test, expectTypeOf } from 'vitest';
import { defineConfig, type PackageConfigInput, type ProxyInput, type ResolvedDevReverseProxy, type ResolvedProxy } from './config.js'; // prettier-ignore
import type { PackageConfig } from './register.js';
import type { InfraRunResult, InfraServiceInput, ResolvedInfra, ResolvedInfraService } from './infra/types.js'; // prettier-ignore
import type { Envs, Mode } from './env.js';

describe('per-package tokens', () => {
  it('gives each package the config tokens plus its own, and nothing from a sibling', () => {
    defineConfig({
      packageRootDir: 'packages',
      tokens: { domain: 'example.test', proto: 'https' },
      packages: {
        api: {
          tokens: { region: 'us-east', proto: 'http' },
          healthcheck: (ctx) => {
            expectTypeOf(ctx.tokens).toHaveProperty('domain');
            expectTypeOf(ctx.tokens).toHaveProperty('region');
            // the package's own value overrides the config's — and is not `never`
            expectTypeOf(ctx.tokens.proto).toEqualTypeOf<string>();
            expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
            expectTypeOf(ctx.tokens.region).toEqualTypeOf<string>();
            return 'http://localhost/health';
          },
        },
        // declares no tokens: sees the config's exactly, and NOT api's
        web: {
          healthcheck: (ctx) => {
            expectTypeOf(ctx.tokens).toHaveProperty('domain');
            expectTypeOf(ctx.tokens).not.toHaveProperty('region');
            // not overridden here, so it keeps the config's literal
            expectTypeOf(ctx.tokens.proto).toEqualTypeOf<'https'>();
            return 'http://localhost/health';
          },
        },
      },
    });
  });

  it('exposes each package resolved tokens on the returned config', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      tokens: { domain: 'example.test' },
      packages: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    expectTypeOf(config.packages.api.tokens).toHaveProperty('region');
    expectTypeOf(config.packages.web.tokens).not.toHaveProperty('region');
    expectTypeOf(config.packages.api.tokens.domain).toEqualTypeOf<'example.test'>();
    expectTypeOf(config.packages).toHaveProperty('web');
    expectTypeOf(config.packages).not.toHaveProperty('ghost');
  });
});

describe('package names', () => {
  it('narrows every name reference to the keys of `packages`', () => {
    type Opts = Parameters<
      typeof defineConfig<
        Record<never, never>,
        { api: unknown; web: unknown; worker: unknown },
        'api' | 'web' | 'worker'
      >
    >[0];
    type Names = 'api' | 'web' | 'worker';

    // the exact union, not just "some string" — this is what regressed in 0.7.0 before
    expectTypeOf<NonNullable<Opts['packages']['api']['waitFor']>>().toEqualTypeOf<Names[]>();
    expectTypeOf<
      NonNullable<NonNullable<Opts['packages']['api']['deps']>['runtime']>
    >().toEqualTypeOf<Names[]>();
    expectTypeOf<
      NonNullable<NonNullable<Opts['packages']['api']['deps']>['build']>
    >().toEqualTypeOf<Names[]>();
  });

  it('types the resolved package name as its own key', () => {
    const config = defineConfig({ packageRootDir: 'packages', packages: { api: {}, web: {} } });
    expectTypeOf(config.packages.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(config.packages.web.name).toEqualTypeOf<'web'>();
  });
});

describe('port', () => {
  it('hands callbacks a plain `number`, never `number | undefined`', () => {
    defineConfig({
      packageRootDir: 'packages',
      packages: {
        literal: {
          port: 3000,
          healthcheck: (ctx) => {
            expectTypeOf(ctx.port).toEqualTypeOf<number>();
            return `http://localhost:${ctx.port}/health`;
          },
          urls: [
            (ctx) => {
              expectTypeOf(ctx.port).toEqualTypeOf<number>();
              return `http://localhost:${ctx.port}`;
            },
          ],
        },
        derived: {
          port: ({ envs }) => Number(envs.DERIVED_PORT),
          healthcheck: (ctx) => {
            expectTypeOf(ctx.port).toEqualTypeOf<number>();
            return `http://localhost:${ctx.port}/health`;
          },
        },
        // no `port` declared: still typed `number` (unverifiable at the type level), and
        // reading it throws at load time — so assert the type without touching the value.
        portless: {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-only assertion
          healthcheck: (ctx) => {
            expectTypeOf<(typeof ctx)['port']>().toEqualTypeOf<number>();
            return 'http://localhost/health';
          },
        },
      },
    });
  });

  it('offers no port to a `port` callback or to workspace-wide urls', () => {
    defineConfig({
      packageRootDir: 'packages',
      tokens: { domain: 'example.test' },
      urls: [
        (ctx) => {
          // workspace-wide links belong to no package
          expectTypeOf(ctx).not.toHaveProperty('port');
          expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
          return `https://${ctx.tokens.domain}`;
        },
      ],
      packages: {
        api: {
          // a port callback can't see the port it is computing
          port: (ctx) => {
            expectTypeOf(ctx).not.toHaveProperty('port');
            return Number(ctx.envs.API_PORT);
          },
        },
      },
    });
  });

  it('keeps the resolved port optional on the config, where it really can be absent', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      packages: { api: { port: 3001 }, lib: {} },
    });
    expectTypeOf(config.packages.api.port).toEqualTypeOf<number | undefined>();
    expectTypeOf(config.packages.lib.port).toEqualTypeOf<number | undefined>();
  });
});

describe('envs', () => {
  it('is a plain string record in every callback', () => {
    defineConfig({
      packageRootDir: 'packages',
      packages: {
        api: {
          port: ({ envs }) => {
            expectTypeOf(envs).toEqualTypeOf<Envs>();
            return Number(envs.PORT);
          },
        },
      },
    });
  });
});

describe('key narrowing survives a config of nothing but callbacks', () => {
  // Regression guard. A package literal made up only of callbacks is context-sensitive, and
  // TypeScript skips it in the pass that registers its key — so with the reverse-mapped type
  // alone, a config where EVERY package declared only callbacks inferred no keys and the name
  // union silently widened to `string`, dropping the `waitFor`/`deps` checks. The
  // `& Record<K, unknown>` channel in `DefineConfigOptions` is what fixes it; each assertion
  // below demands the exact key union, so a regression fails loudly instead of quietly widening.

  it('a single package with only a port callback and a healthcheck callback', () => {
    const c = defineConfig({
      packageRootDir: 'packages',
      packages: {
        api: {
          port: ({ envs }) => Number(envs.API_PORT),
          healthcheck: ({ port }) => `http://localhost:${port}/health`,
        },
      },
    });
    expectTypeOf(c.packages.api.name).toEqualTypeOf<'api'>();
  });

  it('a urls-only package', () => {
    const c = defineConfig({
      packageRootDir: 'packages',
      packages: { api: { urls: [({ port }) => `http://localhost:${port}`] } },
    });
    expectTypeOf(c.packages.api.name).toEqualTypeOf<'api'>();
  });

  it('several packages, every one of them callbacks only', () => {
    const c = defineConfig({
      packageRootDir: 'packages',
      packages: {
        api: { healthcheck: ({ port }) => `http://localhost:${port}/health` },
        web: { healthcheck: ({ port }) => `http://localhost:${port}/` },
      },
    });
    expectTypeOf(c.packages.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(c.packages.web.name).toEqualTypeOf<'web'>();
    // and the name references are still checked against those keys
    expectTypeOf<
      NonNullable<
        Parameters<
          typeof defineConfig<Record<never, never>, { api: unknown; web: unknown }, 'api' | 'web'>
        >[0]['packages']['api']['waitFor']
      >
    >().toEqualTypeOf<('api' | 'web')[]>();
  });

  it('still narrows when only some packages are callbacks only', () => {
    const c = defineConfig({
      packageRootDir: 'packages',
      packages: {
        api: { healthcheck: ({ port }) => `http://localhost:${port}/health` },
        lib: { selectable: false },
      },
    });
    expectTypeOf(c.packages.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(c.packages.lib.name).toEqualTypeOf<'lib'>();
  });
});

describe('proxy', () => {
  test('is typed on the resolved package, and on `PackageConfig<name>`', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      packages: {
        api: { proxy: { subdomain: 'api' } },
        web: { proxy: { subdomain: ['web', 'www'] } },
        lib: {},
      },
    });
    expectTypeOf(config.packages.api.proxy).toEqualTypeOf<ResolvedProxy | undefined>();
    expectTypeOf(config.packages.web.proxy).toEqualTypeOf<ResolvedProxy | undefined>();
    expectTypeOf(config.packages.lib.proxy).toEqualTypeOf<ResolvedProxy | undefined>();
    expectTypeOf<ResolvedProxy['subdomain']>().toEqualTypeOf<string | string[]>();
    // Unaugmented, `PackageConfig<'api'>` is the generic resolved package — the field is there.
    expectTypeOf<PackageConfig<'api'>['proxy']>().toEqualTypeOf<ResolvedProxy | undefined>();
  });

  test('is one type, shared by packages and infra services', () => {
    expectTypeOf<PackageConfigInput['proxy']>().toEqualTypeOf<ProxyInput | undefined>();
    expectTypeOf<InfraServiceInput['proxy']>().toEqualTypeOf<ProxyInput | undefined>();
    expectTypeOf<ProxyInput['subdomain']>().toEqualTypeOf<true | string | string[]>();
  });

  test('a package has no top-level subdomain: it goes under proxy', () => {
    // Typed `never`, so any value is rejected for this field — and only for this field.
    expectTypeOf<PackageConfigInput['subdomain']>().toEqualTypeOf<undefined>();
    defineConfig({
      packageRootDir: 'packages',
      // @ts-expect-error a package's subdomain goes under `proxy`
      packages: { api: { subdomain: 'api' } },
    });
  });

  test('hands the canonical subdomain to a package callback, but not to workspace-wide urls', () => {
    defineConfig({
      packageRootDir: 'packages',
      urls: [
        (ctx) => {
          expectTypeOf(ctx).not.toHaveProperty('subdomain');
          return 'https://example.test';
        },
      ],
      packages: {
        api: {
          proxy: { subdomain: ['api', 'api-legacy'] },
          healthcheck: (ctx) => {
            expectTypeOf(ctx.subdomain).toEqualTypeOf<string | undefined>();
            return `https://${ctx.subdomain}.example.test/health`;
          },
          urls: [
            (ctx) => {
              expectTypeOf(ctx.subdomain).toEqualTypeOf<string | undefined>();
              return `https://${ctx.subdomain}.example.test`;
            },
          ],
          // a port callback can't see it either — it gets the base context
          port: (ctx) => {
            expectTypeOf(ctx).not.toHaveProperty('subdomain');
            return 3000;
          },
        },
        // no `proxy` declared: unlike `port`, the value really is `undefined` (no throwing
        // getter), so the optional type is honest and the value form is safe to read
        bare: {
          healthcheck: (ctx) => {
            expectTypeOf(ctx.subdomain).toEqualTypeOf<string | undefined>();
            return ctx.subdomain === undefined
              ? 'http://localhost/health'
              : `https://${ctx.subdomain}/health`;
          },
        },
      },
    });
  });
});

describe('infra service port and proxy', () => {
  test('a port callback gets the workspace context; both resolve on the service', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      tokens: { tld: 'test' },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: (ctx) => {
                expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
                expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
                // a service is no package: no port of its own to read, no subdomain handed in
                expectTypeOf(ctx).not.toHaveProperty('port');
                expectTypeOf(ctx).not.toHaveProperty('subdomain');
                return Number(ctx.envs.MAIL_UI_PORT);
              },
              proxy: { subdomain: true },
            },
            store: { port: 9000, proxy: { subdomain: ['s3', 'files'] } },
          },
        },
      },
      packages: { web: {} },
    });
    const service = config.infra!['docker-compose']!.services.mail!;
    expectTypeOf(service.port).toEqualTypeOf<number | undefined>();
    expectTypeOf(service.proxy).toEqualTypeOf<ResolvedProxy | undefined>();
    expectTypeOf(service.publicOrigin).toEqualTypeOf<string | undefined>();
    expectTypeOf<ResolvedInfraService['port']>().toEqualTypeOf<number | undefined>();
  });

  test('rejects an unknown proxy option', () => {
    defineConfig({
      packageRootDir: 'packages',
      infra: {
        'docker-compose': {
          // @ts-expect-error `proxy` takes `subdomain` only
          services: { mail: { port: 8025, proxy: { subdomain: 'mail', path: '/ui' } } },
        },
      },
      packages: { web: {} },
    });
  });
});

describe('devReverseProxy', () => {
  test('types the block on the options, with callbacks over the workspace context', () => {
    defineConfig({
      packageRootDir: 'packages',
      tokens: { tld: 'test' },
      devReverseProxy: {
        port: (ctx) => {
          expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
          expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
          expectTypeOf(ctx).not.toHaveProperty('port');
          expectTypeOf(ctx).not.toHaveProperty('subdomain');
          return Number(ctx.envs.DEV_REVERSE_PROXY_PORT);
        },
        rootDomain: (ctx) => `example.${ctx.tokens.tld}`,
        defaultPackage: 'web',
        urlScheme: 'http',
      },
      packages: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    type Opts = Parameters<
      typeof defineConfig<Record<never, never>, { web: unknown; api: unknown }, 'web' | 'api'>
    >[0];
    type Proxy = NonNullable<Opts['devReverseProxy']>;
    expectTypeOf<Proxy['defaultPackage']>().toEqualTypeOf<'web' | 'api' | undefined>();
    expectTypeOf<Proxy['urlScheme']>().toEqualTypeOf<'http' | 'https' | undefined>();
  });

  test('exposes the resolved block on the returned config', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      devReverseProxy: { port: 4000, rootDomain: 'example.test' },
      packages: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expectTypeOf(config.devReverseProxy).toEqualTypeOf<ResolvedDevReverseProxy | undefined>();
    expectTypeOf(config.devReverseProxy!.port).toEqualTypeOf<number>();
    expectTypeOf(config.devReverseProxy!.rootDomain).toEqualTypeOf<string>();
    expectTypeOf(config.devReverseProxy!.urlScheme).toEqualTypeOf<'http' | 'https'>();
    expectTypeOf(config.devReverseProxy!.defaultPackage).toEqualTypeOf<string | undefined>();
    expectTypeOf(config.packages.web.publicOrigin).toEqualTypeOf<string | undefined>();
  });
});

describe('devReverseProxy rootDomain', () => {
  test('is optional on the options and a plain string on the resolved config', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      devReverseProxy: { port: 4000 },
      packages: { web: { port: 3000, proxy: { subdomain: 'web' } } },
    });
    expectTypeOf(config.devReverseProxy!.rootDomain).toEqualTypeOf<string>();
  });
});

describe('packageRootDir', () => {
  test('makes relativeDir optional when set, required otherwise', () => {
    type WithRoot = Parameters<
      typeof defineConfig<Record<never, never>, { api: unknown }, 'api', 'packages'>
    >[0]['packages']['api'];
    type WithoutRoot = Parameters<
      typeof defineConfig<Record<never, never>, { api: unknown }, 'api'>
    >[0]['packages']['api'];
    expectTypeOf<Pick<WithRoot, 'relativeDir'>>().toEqualTypeOf<{ relativeDir?: string }>();
    expectTypeOf<Pick<WithoutRoot, 'relativeDir'>>().toEqualTypeOf<{ relativeDir: string }>();
  });

  test('infers from a literal packageRootDir, and the resolved relativeDir is always a string', () => {
    const config = defineConfig({ packageRootDir: 'packages', packages: { api: {} } });
    expectTypeOf(config.packages.api.relativeDir).toEqualTypeOf<string>();
    expectTypeOf(config.packageRootDir).toEqualTypeOf<string | undefined>();
  });
});

describe('infra callbacks', () => {
  test("type the context from the config's own tokens", () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      tokens: { domain: 'example.test' },
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: async (ctx) => {
                expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
                expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
                expectTypeOf(ctx.tokens).not.toHaveProperty('region');
                expectTypeOf(ctx.reset).toEqualTypeOf<boolean>();
                expectTypeOf(ctx.fresh).toEqualTypeOf<boolean>();
                expectTypeOf(ctx.service).toEqualTypeOf<string>();
                expectTypeOf(ctx.workspaceDir).toEqualTypeOf<string>();
                expectTypeOf(ctx.compose).returns.toEqualTypeOf<Promise<InfraRunResult>>();
                expectTypeOf(ctx.run).returns.toEqualTypeOf<Promise<InfraRunResult>>();
                expectTypeOf(ctx.log).parameters.toEqualTypeOf<[message: string]>();
              },
              // a synchronous callback is fine too
              beforeUp: (ctx) => {
                expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
                // only afterReady knows: before the start there is nothing to be fresh yet
                expectTypeOf(ctx).not.toHaveProperty('fresh');
              },
              enabled: (ctx) => {
                expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
                expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
                expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
                // decided when the config loads: no service to act on, nothing to run
                expectTypeOf(ctx).not.toHaveProperty('compose');
                return ctx.mode !== 'test';
              },
            },
          },
        },
      },
      packages: { web: {} },
    });
    expectTypeOf(config.infra).toEqualTypeOf<ResolvedInfra | undefined>();
  });
});

describe('Mode', () => {
  test('suggests the usual names without closing the set: any string is a mode', () => {
    expectTypeOf<'development'>().toExtend<Mode>();
    expectTypeOf<'test'>().toExtend<Mode>();
    expectTypeOf<'staging'>().toExtend<Mode>();
    expectTypeOf<string>().toExtend<Mode>();
    expectTypeOf<Mode>().toExtend<string>();
    // …and it has not collapsed into plain `string`, which is what would drop the suggestions.
    expectTypeOf<Mode>().not.toEqualTypeOf<string>();
  });
});

describe('shorthands', () => {
  test('subdomain: true resolves to a string, and a provider takes true for {}', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      infra: { 'docker-compose': true },
      packages: { web: { proxy: { subdomain: true } } },
    });
    // `true` never survives resolution: readers of the config get the label itself.
    expectTypeOf(config.packages.web.proxy!.subdomain).toEqualTypeOf<string | string[]>();
    expectTypeOf(config.infra).toEqualTypeOf<ResolvedInfra | undefined>();
  });
});

describe('env', () => {
  test('types the shorthand callback over the workspace context', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      tokens: { tier: 'dev' },
      env: (ctx) => {
        expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
        // the variables devtooie sets are known by name, so an editor offers them
        expectTypeOf(ctx.envs.DEVTOOIE_MODE).toEqualTypeOf<Mode>();
        expectTypeOf(ctx.envs.DEVTOOIE_CWD).toEqualTypeOf<string>();
        expectTypeOf(ctx.envs.DEVTOOIE_WORKSPACE_DIR).toEqualTypeOf<string>();
        // any other name is still there to read, and may be unset
        expectTypeOf(ctx.envs.ANYTHING_ELSE).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx.tokens.tier).toEqualTypeOf<'dev'>();
        expectTypeOf(ctx).not.toHaveProperty('port');
        expectTypeOf(ctx).not.toHaveProperty('subdomain');
        return { DATA_DIR: `/srv/${ctx.tokens.tier}`, MAYBE: ctx.envs.MAYBE as string | undefined };
      },
      packages: { api: { waitFor: ['web'] }, web: { healthcheck: 'http://localhost/health' } },
    });
    // The callback is context-sensitive; it must not cost the package names their narrowing.
    expectTypeOf(config.packages).toHaveProperty('api');
    expectTypeOf(config.packages).not.toHaveProperty('ghost');
  });

  test('types env.vars the same way, next to override', () => {
    defineConfig({
      packageRootDir: 'packages',
      tokens: { tier: 'dev' },
      env: {
        vars: (ctx) => {
          expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
          expectTypeOf(ctx.tokens.tier).toEqualTypeOf<'dev'>();
          return { DATA_DIR: '/srv/data' };
        },
        override: ['NODE_OPTIONS'],
      },
      packages: { api: {} },
    });
  });

  test('accepts a record, an undefined value included, and only strings otherwise', () => {
    type Opts = Parameters<typeof defineConfig<Record<never, never>, { api: unknown }>>[0];
    type Vars = Exclude<NonNullable<Opts['env']>, (...args: never[]) => unknown>['vars'];
    expectTypeOf<{ A: string; B: undefined }>().toExtend<Vars>();
    expectTypeOf<{ A: number }>().not.toExtend<Vars>();
    expectTypeOf<(ctx: { envs: Record<string, string> }) => { A: number }>().not.toExtend<Vars>();
  });

  test('exposes the resolved variables on the returned config', () => {
    const config = defineConfig({
      packageRootDir: 'packages',
      env: { vars: { DATA_DIR: '/srv/data' } },
      packages: { api: {} },
    });
    expectTypeOf(config.envVars).toEqualTypeOf<Record<string, string> | undefined>();
  });
});

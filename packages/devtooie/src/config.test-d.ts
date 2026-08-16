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
import { describe, it, expectTypeOf } from 'vitest';
import { defineConfig } from './config.js';

describe('per-package tokens', () => {
  it('gives each package the config tokens plus its own, and nothing from a sibling', () => {
    defineConfig({
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
    const config = defineConfig({ packages: { api: {}, web: {} } });
    expectTypeOf(config.packages.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(config.packages.web.name).toEqualTypeOf<'web'>();
  });
});

describe('port', () => {
  it('hands callbacks a plain `number`, never `number | undefined`', () => {
    defineConfig({
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
    const config = defineConfig({ packages: { api: { port: 3001 }, lib: {} } });
    expectTypeOf(config.packages.api.port).toEqualTypeOf<number | undefined>();
    expectTypeOf(config.packages.lib.port).toEqualTypeOf<number | undefined>();
  });
});

describe('envs', () => {
  it('is a plain string record in every callback', () => {
    defineConfig({
      packages: {
        api: {
          port: ({ envs }) => {
            expectTypeOf(envs).toEqualTypeOf<Record<string, string>>();
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
      packages: { api: { urls: [({ port }) => `http://localhost:${port}`] } },
    });
    expectTypeOf(c.packages.api.name).toEqualTypeOf<'api'>();
  });

  it('several packages, every one of them callbacks only', () => {
    const c = defineConfig({
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
      packages: {
        api: { healthcheck: ({ port }) => `http://localhost:${port}/health` },
        lib: { selectable: false },
      },
    });
    expectTypeOf(c.packages.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(c.packages.lib.name).toEqualTypeOf<'lib'>();
  });
});

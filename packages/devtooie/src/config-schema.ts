import { z } from 'zod';
// Type-only — erased at compile time, so `config-schema.ts` still imports nothing but `zod`
// at runtime and `scripts/gen-config-types.ts` can keep executing it without a build.
import type { ConfigContext, PortResolver, UrlResolver } from './config.js';

// The Zod schemas — the single source of the config's shape, defaults, validation, AND field
// docs (via `.describe()`). `scripts/gen-config-types.ts` reads this file (it imports only
// `zod`, so it runs without a build) and emits `config.generated.ts` with the descriptions as
// JSDoc. `config.ts` then composes the public types from the generated ones, overriding the
// fields Zod can't represent well (`command`, and the name-referencing `name`/`waitFor`/`deps`).
//
// So: `.describe()` on a *kept* field flows to consumer hover automatically; *overridden*
// fields are documented in `config.ts` and need no `.describe()` here.

// A URL anywhere in the config: a literal string, or a callback devtooie invokes once at load
// time with the package's context (`{ envs, tokens, port, subdomain }`). Overridden in config.ts,
// since `z.custom` erases the callback to `any`; `defineConfig` resolves every callback to a string
// before anything downstream sees it.
export const UrlValueSchema = z.union([
  z.string(),
  z.custom<UrlResolver>((v) => typeof v === 'function', {
    message: 'a url must be a string or a function',
  }),
]);

export const UrlLinkSchema = z.union([
  UrlValueSchema,
  z.object({ label: z.string(), url: UrlValueSchema }),
]);
export const UrlEntrySchema = z.union([UrlLinkSchema, z.array(UrlLinkSchema)]);

/** How long a healthcheck probe may take before it's aborted, when the package doesn't say. */
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 1500;

// A `healthcheck`: the URL on its own (string or callback), or an object adding `timeout`.
// Strict so a misspelled `timout` fails at load rather than silently leaving the default in
// place. Overridden in config.ts (the callback erases to `any`); `defineConfig` normalizes
// every form to `{ url: string; timeout: number }` before anything downstream sees it.
export const HealthcheckSchema = z.union([
  UrlValueSchema,
  z.strictObject({
    url: UrlValueSchema,
    timeout: z.number().int().positive().optional(),
  }),
]);

// `command` options. `watches`/`cleans` both imply building, so `builds: false` is only legal
// when the command neither watches nor cleans — rejected at parse time otherwise (e.g.
// `{ watches: true, builds: false }`, `{ builds: false }` since watches then defaults true, and
// `{ cleans: true, builds: false }`).
export const CommandOptionsSchema = z
  .strictObject({
    watches: z.boolean().optional(),
    builds: z.boolean().optional(),
    cleans: z.boolean().optional(),
  })
  .refine((o) => (o.builds ?? true) || (!(o.watches ?? true) && !(o.cleans ?? false)), {
    message: 'a command that watches or cleans must also build (builds cannot be false)',
  });

export const CommandSchema = z
  // `null` = the package has no dev process; devtooie never starts it (build/dep-only).
  .union([z.string(), z.tuple([z.string(), CommandOptionsSchema]), z.null()])
  .default('dev')
  .transform((c) =>
    c === null
      ? null
      : typeof c === 'string'
        ? { name: c, watches: true, builds: true, cleans: false }
        : {
            name: c[0],
            watches: c[1].watches ?? true,
            builds: c[1].builds ?? true,
            cleans: c[1].cleans ?? false,
          },
  );

// One `subdomain` entry: a DNS label, since a reverse proxy routes on it. Lowercase only (two
// casings of one label would be two spellings of one route), no dots (a label, not a domain), and
// non-empty — an empty one would silently route the bare root domain. Sixty-three characters is the
// DNS limit.
export const SubdomainLabelSchema = z
  .string()
  .max(63, 'a subdomain is at most 63 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'a subdomain is a DNS label: lowercase letters, digits, and hyphens, not starting or ending with a hyphen',
  );

// All per-package config is flat (no `run` nesting). The package's *name* is the key it's
// declared under in `packages` (injected by `defineConfig` after parsing), so it isn't a field
// here; the rest describe how to run/select/link it (omit them all for a build-only lib).
export const PackageConfigSchema = z.object({
  relativeDir: z
    .string()
    .optional()
    .describe(
      'Directory holding the package, relative to `workspaceDir`. Inferred as `<packageRootDir>/<key>` when the config sets `packageRootDir`; required otherwise. Set it to override the inferred one.',
    ),
  selectable: z.boolean().optional().describe('Show in the interactive picker (default `true`).'),
  shortName: z.string().optional().describe('Shorter label used in the TUI in place of `name`.'),
  color: z
    .string()
    .optional()
    .describe(
      "Color for this package's log-prefix label, overriding the auto-assigned palette color. Any Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`), `'rgb(175,135,255)'`, or `'ansi256(140)'`.",
    ),
  subdomain: z
    .union([SubdomainLabelSchema, z.array(SubdomainLabelSchema)])
    .optional()
    .describe(
      "The package's dev subdomain(s). With a top-level `devReverseProxy`, devtooie routes `<subdomain>.<rootDomain>` to this package's `port`; without one it is data for tooling that reads the exported config (a reverse proxy of your own, say). Each entry is a DNS label — lowercase letters, digits, and hyphens — that no other package declares. An array's first entry is the canonical subdomain, handed to this package's callbacks as `subdomain`; the rest are aliases that route too.",
    ),
  // Overridden in config.ts (pinned to the keys the package declares); documented there.
  // Must be parsed, not stripped — it's what a callback's `tokens` is built from.
  tokens: z.record(z.string(), z.string().optional()).optional(),
  // Overridden in config.ts (a callback Zod can't usefully type — `z.custom` erases to `any`);
  // documented there. `defineConfig` resolves a callback to a number before anything downstream
  // sees it, so the *resolved* type is still `number | undefined`.
  port: z
    .union([
      z.number(),
      z.custom<PortResolver>((v) => typeof v === 'function', {
        message: 'port must be a number or a function',
      }),
    ])
    .optional(),
  // Overridden in config.ts (transform → `any`); documented there.
  command: CommandSchema,
  autostart: z
    .boolean()
    .optional()
    .describe(
      'Automatically start this package during the run phase (default `true`). When `false`, devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API `restart`). Ignored when `command` is `null` (that package never starts).',
    ),
  // Overridden in config.ts (urls/healthcheck admit callbacks `z.custom` erases to `any`);
  // documented there. Both are resolved to plain strings by `defineConfig`.
  urls: z.array(UrlEntrySchema).optional(),
  healthcheck: HealthcheckSchema.optional(),
  // Overridden in config.ts (pinned to package names); documented there.
  waitFor: z.array(z.string()).optional(),
  tsconfig: z
    .string()
    .optional()
    .describe(
      'tsconfig file (relative to the package dir) devtooie reads for project references to infer build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`.',
    ),
  deps: z
    .object({
      build: z.array(z.string()).optional(),
      dev: z.array(z.string()).optional(),
      runtime: z.array(z.string()).optional(),
    })
    .optional(),
  // Overridden in config.ts — `logs.formatter` is a function Zod can't usefully type (`z.custom`
  // erases to `any`), so the whole object is re-typed there. `z.custom` validates it's a function
  // and passes it through untouched, so the exact user callback (not a validating wrapper) reaches
  // the runtime.
  logs: z
    .object({
      timestamps: z.boolean().optional(),
      formatter: z
        .custom<(line: string) => string>((v) => typeof v === 'function', {
          message: 'logs.formatter must be a function',
        })
        .optional(),
    })
    .optional(),
});

// The built-in dev reverse proxy. Strict, so a misspelled field (or an `enabled` flag — the
// block's presence is what enables it) fails at load. `port`/`rootDomain` callbacks erase to
// `any` here and are re-typed in config.ts; `defineConfig` resolves both before anything
// downstream sees them.
export const DevReverseProxySchema = z.strictObject({
  port: z.union([
    z.number(),
    z.custom<(ctx: ConfigContext) => number>((v) => typeof v === 'function', {
      message: 'devReverseProxy.port must be a number or a function',
    }),
  ]),
  rootDomain: z
    .union([
      z.string(),
      z.custom<(ctx: ConfigContext) => string>((v) => typeof v === 'function', {
        message: 'devReverseProxy.rootDomain must be a string or a function',
      }),
    ])
    .optional(),
  defaultPackage: z
    .string()
    .optional()
    .describe(
      'The package the bare `rootDomain` routes to. Must declare a `port`. Omit for a 404 there.',
    ),
  urlScheme: z
    .enum(['http', 'https'])
    .optional()
    .describe(
      'Scheme of the public URLs devtooie derives (footer links, `PUBLIC_ORIGIN`). Defaults from `rootDomain`: `http` on `localhost` (the browser hits the proxy directly, so the URLs carry its `port`), `https` on any other root (a TLS terminator in front, so no port).',
    ),
});

export const DefineConfigSchema = z.object({
  apiPort: z
    .number()
    .optional()
    .describe(
      'Fixed control-API port; omit to let devtooie pick one (recorded in `running.json`).',
    ),
  // Keyed by package name; the key becomes the package's `name`. Overridden in config.ts (a
  // mapped type carrying each package's own token types); documented there.
  packages: z.record(z.string().min(1), PackageConfigSchema),
  // Overridden in config.ts (its presence is what makes each package's `relativeDir` optional
  // at the type level); documented there.
  packageRootDir: z.string().optional(),
  // Overridden in config.ts (callbacks `z.custom` erases to `any`); documented there.
  urls: z.array(UrlEntrySchema).optional(),
  // Overridden in config.ts (callbacks erase to `any`); documented there.
  devReverseProxy: DevReverseProxySchema.optional(),
  workspaceDir: z
    .string()
    .optional()
    .describe("Root each package's `relativeDir` resolves against. Defaults to `process.cwd()`."),
  tokens: z
    .record(z.string(), z.string().optional())
    .optional()
    .describe('Arbitrary values handed to every `port`/`healthcheck`/`urls` callback as `tokens`.'),
  env: z
    // Strict so a config still passing the removed `files` option fails loudly. Stripping it
    // would leave the config looking fine while loading a different set of files than it asks for.
    .strictObject({
      override: z
        .union([z.boolean(), z.array(z.string())])
        .optional()
        .describe(
          'Variables whose `.env` value may beat the ambient environment (`true` for all). By default the ambient environment wins, as in Next.js/Vite/`node --env-file`.',
        ),
    })
    .optional()
    .describe('Environment-loading options. Which files load is chosen with `--mode`.'),
  logs: z
    .object({
      timestamps: z
        .boolean()
        .optional()
        .describe(
          'Prefix each on-screen log line with a local-time (24-hour) timestamp — `HH:MM:SS` while everything on screen is from one day, `YYYY-MM-DD HH:MM:SS` once two days are visible. Defaults to `true`. The on-disk log file always includes timestamps regardless of this setting.',
        ),
    })
    .optional()
    .describe('Log display options.'),
});

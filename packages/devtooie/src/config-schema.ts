import { z } from 'zod';
import type {
  ConfigContext,
  EnvVars,
  EnvVarsResolver,
  PortResolver,
  UrlResolver,
} from './config.js';

// The Zod schemas: the config's shape, defaults and validation. They hold no docs. The types a
// config is written against — `ServiceConfigInput` and `DefineConfigOptions` in config.ts — are
// declared by hand, because they carry what a schema can't: the service names a `waitFor` may
// list, and each callback's context typed from the config's own `tokens`. Every field's JSDoc
// lives there. `config.test-d.ts` checks that those types and these schemas accept the same
// fields, so one can't change without the other.

// A URL anywhere in the config: a literal string, or a callback devtooie invokes once at load
// time with the service's context (`{ envs, tokens, port, subdomain }`). `defineConfig` resolves
// every callback to a string before anything downstream sees it.
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

/** How long a healthcheck probe may take before it's aborted, when the service doesn't say. */
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 1500;

// A `healthcheck`: the URL on its own (string or callback), or an object adding `timeout`.
// Strict so a misspelled `timout` fails at load rather than silently leaving the default in
// place. `defineConfig` normalizes every form to `{ url: string; timeout: number }` before
// anything downstream sees it.
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
  // `null` = the service has no dev process; devtooie never starts it (build/dep-only).
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

// The `proxy` block services and infra services share: how a reverse proxy routes to the thing
// declaring it. Strict, so a misspelled option fails at load. `subdomain` is required — it is the
// block's only option, and `proxy: {}` would route nothing. `true` is shorthand for the declaring
// service's or service's own key; `defineConfig` replaces it with that string (checking it is a
// label) before anything else reads the field.
export const ProxySchema = z.strictObject({
  subdomain: z.union([z.literal(true), SubdomainLabelSchema, z.array(SubdomainLabelSchema).min(1)]),
});

// A `port`: a literal, or a callback `defineConfig` resolves to a number before anything
// downstream sees it.
const PortSchema = z.union([
  z.number(),
  z.custom<PortResolver>((v) => typeof v === 'function', {
    message: 'port must be a number or a function',
  }),
]);

// All per-service config is flat (no `run` nesting). The service's *name* is the key it's
// declared under in `services` (injected by `defineConfig` after parsing), so it isn't a field
// here; the rest describe how to run/select/link it (omit them all for a build-only lib).
export const ServiceConfigSchema = z.object({
  relativeDir: z.string().optional(),
  selectable: z.boolean().optional(),
  shortName: z.string().optional(),
  color: z.string().optional(),
  proxy: ProxySchema.optional(),
  // A service's subdomain lives under `proxy`. Named here only so a config that sets it at the
  // top level fails with directions, rather than having it stripped and the service silently
  // unrouted. The input type in config.ts types it `never`.
  subdomain: z
    .undefined({ error: "a service's subdomain goes under `proxy` — `proxy: { subdomain: … }`" })
    .optional(),
  // Must be parsed, not stripped — it's what a callback's `tokens` is built from.
  tokens: z.record(z.string(), z.string().optional()).optional(),
  // `defineConfig` resolves a callback to a number before anything downstream sees it, so the
  // *resolved* type is still `number | undefined`.
  port: PortSchema.optional(),
  command: CommandSchema,
  autostart: z.boolean().optional(),
  // Both resolved to plain strings by `defineConfig`.
  urls: z.array(UrlEntrySchema).optional(),
  healthcheck: HealthcheckSchema.optional(),
  waitFor: z.array(z.string()).optional(),
  tsconfig: z.string().optional(),
  deps: z
    .object({
      build: z.array(z.string()).optional(),
      dev: z.array(z.string()).optional(),
      runtime: z.array(z.string()).optional(),
    })
    .optional(),
  // `z.custom` validates `formatter` is a function and passes it through untouched, so the exact
  // user callback (not a validating wrapper) reaches the runtime.
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
// block's presence is what enables it) fails at load. `defineConfig` resolves the `port` and
// `rootDomain` callbacks before anything downstream sees them.
export const DevReverseProxySchema = z.strictObject({
  port: z.union([
    z.number(),
    z.custom<(ctx: ConfigContext) => number>((v) => typeof v === 'function', {
      message: 'devReverseProxy.port must be a number or a function',
    }),
  ]),
  // An array's first entry is the canonical root, the rest aliases. Emptiness, hostname shape,
  // duplicates and overlap are checked once the callback (if any) has run, in `defineConfig`.
  rootDomain: z
    .union([
      z.string(),
      z.array(z.string()),
      z.custom<(ctx: ConfigContext) => string | string[]>((v) => typeof v === 'function', {
        message: 'devReverseProxy.rootDomain must be a string, an array of strings, or a function',
      }),
    ])
    .optional(),
  defaultService: z.string().optional(),
  urlScheme: z.enum(['http', 'https']).optional(),
});

// One callback an infra service can attach. Zod only checks it's a function and passes it
// through untouched; its real signature is in infra/types.ts.
const infraCallback = (name: string) =>
  z
    .custom<(...args: never[]) => unknown>((v) => typeof v === 'function', {
      message: `infra: ${name} must be a function`,
    })
    .optional();

// Strict throughout: a misspelled callback (`onReady`) must be an error, not a silently ignored key.
export const InfraServiceSchema = z.strictObject({
  // A literal, or a callback `defineConfig` resolves to a boolean while the config loads.
  enabled: z
    .union([
      z.boolean(),
      z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function', {
        message: 'infra: enabled must be a boolean or a function',
      }),
    ])
    .optional(),
  // The service's port on the host, and how a reverse proxy routes to it. Here, not on a
  // provider's options, so every provider has them.
  port: PortSchema.optional(),
  proxy: ProxySchema.optional(),
  // The service's footer links, as for a service.
  urls: z.array(UrlEntrySchema).optional(),
  beforeDestroy: infraCallback('beforeDestroy'),
  afterDestroy: infraCallback('afterDestroy'),
  beforeUp: infraCallback('beforeUp'),
  afterReady: infraCallback('afterReady'),
});

export const DockerComposeInfraSchema = z.strictObject({
  file: z.string().min(1).optional(),
  readyTimeout: z.number().positive().optional(),
  services: z.record(z.string().min(1), InfraServiceSchema).optional(),
});

// Keyed by provider.
export const InfraSchema = z
  // `true` is shorthand for a provider with nothing to configure: `{}`. Rewritten before the
  // object schema sees it rather than offered as a union alternative, because a union reports a
  // mistake inside the block as a bare "Invalid input" — losing the field's path and message.
  // The parameter's type is what the schema's input type says it accepts.
  .strictObject({
    'docker-compose': z
      .preprocess(
        (value: true | z.input<typeof DockerComposeInfraSchema>) => (value === true ? {} : value),
        DockerComposeInfraSchema,
      )
      .optional(),
  })
  .refine((infra) => Object.values(infra).some((provider) => provider !== undefined), {
    message: "infra must name a provider — `infra: { 'docker-compose': true }`",
  });

// The `env` options. Strict so a config still passing the removed `files` option fails loudly.
// Stripping it would leave the config looking fine while loading a different set of files than it
// asks for.
const EnvOptionsSchema = z.strictObject({
  // The values are checked where a callback's result is, in `defineConfig`, so a bad one
  // is reported the same way — by variable name — whichever form declared it.
  vars: z
    .custom<EnvVars | EnvVarsResolver>(
      (v) => typeof v === 'function' || (typeof v === 'object' && v !== null && !Array.isArray(v)), // oxfmt-ignore
      { message: 'env.vars must be an object of variables or a function' },
    )
    .optional(),
  override: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export const DefineConfigSchema = z.object({
  apiPort: z.number().optional(),
  // Keyed by service name; the key becomes the service's `name`.
  services: z.record(z.string().min(1), ServiceConfigSchema),
  serviceRootDir: z.string().optional(),
  urls: z.array(UrlEntrySchema).optional(),
  devReverseProxy: DevReverseProxySchema.optional(),
  infra: InfraSchema.optional(),
  workspaceDir: z.string().optional(),
  tokens: z.record(z.string(), z.string().optional()).optional(),
  env: z
    .preprocess(
      // The callback on its own is shorthand for `{ vars: callback }`. The parameter's type is
      // what the schema's input type says it accepts.
      (value: EnvVarsResolver | z.input<typeof EnvOptionsSchema>) =>
        typeof value === 'function' ? { vars: value } : value,
      EnvOptionsSchema,
    )
    .optional(),
  logs: z.object({ timestamps: z.boolean().optional() }).optional(),
});

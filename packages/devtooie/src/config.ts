import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_ENV_FILES } from './env.js';

export const PackageType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type PackageType = (typeof PackageType)[keyof typeof PackageType];
export type PackageTypeValue = 'backend' | 'browser' | 'lib';

// ---------------------------------------------------------------------------
// Zod schemas — the single source of the config's shape, defaults, and
// validation. Public types are derived from these (`z.input` for what
// `defineConfig` accepts, `z.infer` for the resolved config), with a thin
// generic overlay (`WithNames`) re-adding package-name type-safety.
// ---------------------------------------------------------------------------

const UrlLinkSchema = z.union([z.string(), z.object({ label: z.string(), url: z.string() })]);
const UrlEntrySchema = z.union([UrlLinkSchema, z.array(UrlLinkSchema)]);

/** A single link: a bare URL, or a labeled URL (the label is shown in place of the URL). */
export type UrlLink = z.infer<typeof UrlLinkSchema>;
/**
 * One footer line's worth of links: a single link, or an array of links rendered on the
 * same line separated by a space. `urls` is a list of these entries, one line each.
 */
export type UrlEntry = z.infer<typeof UrlEntrySchema>;

/** One footer line after normalization: the links to render on it (label falls back to url). */
export type UrlLine = { label?: string; url: string }[];

/** Flattens a resolved `urls` entry into the links shown on a single footer line. */
export function normalizeUrlEntry(entry: UrlEntry): UrlLine {
  const links = Array.isArray(entry) ? entry : [entry];
  return links.map((link) => (typeof link === 'string' ? { url: link } : link));
}

// `command` options as a union of the two *legal* shapes, so `{ watches: true, builds: false }`
// (and `{ builds: false }`, since watches then defaults true) is rejected at the type level
// AND at parse time: a watching command must also build.
const CommandOptionsSchema = z.union([
  z.strictObject({ watches: z.literal(true).optional(), builds: z.literal(true).optional() }),
  z.strictObject({ watches: z.literal(false), builds: z.boolean().optional() }),
]);

const CommandSchema = z
  .union([z.string(), z.tuple([z.string(), CommandOptionsSchema])])
  .default('dev')
  .transform((c) =>
    typeof c === 'string'
      ? { name: c, watches: true, builds: true }
      : { name: c[0], watches: c[1].watches ?? true, builds: c[1].builds ?? true },
  );

/** A resolved `run.command`: which script to run and how it behaves on file changes. */
export type Command = z.infer<typeof CommandSchema>;

const RunConfigSchema = z.object({
  selectable: z.boolean().optional().describe('Show in the interactive picker (default true).'),
  shortName: z.string().optional().describe('Shorter label used in the TUI in place of `name`.'),
  subdomain: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Reverse-proxy subdomain(s); the first feeds `$subdomain` substitution.'),
  port: z.number().optional().describe('Dev port; injected as `PORT` and feeds `$port`.'),
  hmrPort: z.number().optional().describe("A browser package's HMR socket port."),
  command: CommandSchema.describe(
    'The dev process to run and how it behaves. A script/target name, or `[name, { watches, ' +
      "builds }]`. Default `['dev', { watches: true, builds: true }]`. `watches`: the script " +
      'watches files and reloads itself. `builds`: the script (re)builds on start. ' +
      '`watches:true` requires `builds:true`. Drives what to do after editing this package: ' +
      'watches→nothing, else builds→restart, else rebuild.',
  ),
  urls: z
    .array(UrlEntrySchema)
    .optional()
    .describe(
      'Footer links; each entry is one line (string, {label,url}, or an array on one line).',
    ),
  healthcheck: z
    .string()
    .optional()
    .describe('URL polled for readiness; required by `waitFor` targets.'),
  waitFor: z
    .array(z.string())
    .optional()
    .describe('Package names whose `healthcheck` must pass before this one starts.'),
  deps: z
    .object({
      build: z.array(z.string()).optional(),
      dev: z.array(z.string()).optional(),
      runtime: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Other packages this one depends on (build / dev / runtime).'),
});

const PackageConfigSchema = z.object({
  name: z.string(),
  relativeDir: z.string().optional(),
  types: z.array(z.enum(['backend', 'browser', 'lib'])),
  run: RunConfigSchema.optional(),
});

const DefineConfigSchema = z.object({
  apiPort: z.number().optional(),
  packages: z.array(PackageConfigSchema),
  urls: z.array(UrlEntrySchema).optional(),
  workspaceDir: z.string().optional(),
  tokens: z.record(z.string(), z.string().optional()).optional(),
  env: z.object({ files: z.array(z.string()).optional() }).optional(),
});

// ---------------------------------------------------------------------------
// Types: Zod-derived base + a generic overlay that re-adds package-name safety
// on the relational fields (`name`, `waitFor`, `deps.*`). Everything else keeps
// the Zod-inferred type verbatim.
// ---------------------------------------------------------------------------

/**
 * Overlays a package's name-referencing fields with the concrete name union `N`. `NoInfer`
 * keeps these values out of `N`'s inference, so a typo'd name is a compile error rather
 * than silently widening `N`.
 */
type RunWithNames<R, N extends string> = Omit<R, 'waitFor' | 'deps'> & {
  waitFor?: NoInfer<N>[];
  deps?: { build?: NoInfer<N>[]; dev?: NoInfer<N>[]; runtime?: NoInfer<N>[] };
};

/** A package's `run` block as authored (loose `command`, name-checked `waitFor`/`deps`). */
export type RunConfig<N extends string> = RunWithNames<z.input<typeof RunConfigSchema>, N>;

/** A package's resolved `run` block (normalized `command`, substituted urls). */
type ResolvedRun<N extends string> = RunWithNames<z.infer<typeof RunConfigSchema>, N>;

export type PackageConfigInput<N extends string> = Omit<
  z.input<typeof PackageConfigSchema>,
  'name' | 'run'
> & { name: N; run?: RunConfig<N> };

/**
 * The argument to {@link defineConfig}. Everything is typed straight from the Zod schema
 * except the relational fields, which are pinned to your package names for autocomplete
 * and typo errors.
 */
export type DefineConfigOptions<N extends string> = Omit<
  z.input<typeof DefineConfigSchema>,
  'packages'
> & { packages: PackageConfigInput<N>[] };

export type ResolvedPackageConfig<N extends string> = Omit<
  z.infer<typeof PackageConfigSchema>,
  'name' | 'run'
> & { name: N; relativeDir: string; path: string; run?: ResolvedRun<N> };

export type AnyPackageConfig = ResolvedPackageConfig<string>;

export interface Config<N extends string> {
  /** User-pinned control-API port, or `undefined` to let devtooie pick a random one at startup. */
  apiPort?: number;
  packages: ResolvedPackageConfig<N>[];
  /** Resolved workspace-wide URLs (extrinsic tokens substituted), or `undefined` if none. */
  urls?: UrlEntry[];
  /** Resolved `.env` filenames loaded per package (defaults to {@link DEFAULT_ENV_FILES}). */
  envFiles: string[];
}

// ---------------------------------------------------------------------------
// State + lookups
// ---------------------------------------------------------------------------

let registeredPackages: AnyPackageConfig[] = [];
let loadedConfig: Config<string> | null = null;

export function getRegisteredPackages(): AnyPackageConfig[] {
  return registeredPackages;
}

/** The most recently defined config (meta + packages), or null before any `defineConfig` runs. */
export function getLoadedConfig(): Config<string> | null {
  return loadedConfig;
}

export function findPackage(name: string): AnyPackageConfig {
  const pkg = registeredPackages.find((p) => p.name === name);
  if (!pkg) throw new Error(`package ${name} not found`);
  return pkg;
}

/** The dev-process script/target name for a package (`run.command.name`, default `'dev'`). */
export function getDevScript(pkg: AnyPackageConfig): string {
  return pkg.run?.command.name ?? 'dev';
}

// ---------------------------------------------------------------------------
// Token substitution (post-parse; Zod can't express intrinsic/extrinsic tokens)
// ---------------------------------------------------------------------------

/**
 * Replaces every remaining `$key` in `input` with `tokens[key]`, throwing (naming
 * `context` and the token) when the key is absent or its value is `undefined`. Used both
 * for a package's extrinsic pass (after intrinsic tokens are resolved) and for top-level
 * urls, which have only extrinsic tokens.
 */
function substituteTokens(
  input: string,
  tokens: Record<string, string | undefined>,
  context: string,
): string {
  return input.replace(/\$([a-z][a-z0-9_]*)/gi, (_match, key: string) => {
    if (key in tokens) {
      const val = tokens[key];
      if (val === undefined) {
        throw new Error(`${context} uses $${key} but tokens.${key} is undefined`);
      }
      return val;
    }
    throw new Error(`${context} uses $${key} but no such token was provided`);
  });
}

/** Substitutes tokens in one link (bare string or `{ label, url }`), preserving its shape. */
function substituteUrlLink(link: UrlLink, replace: (s: string) => string): UrlLink {
  return typeof link === 'string' ? replace(link) : { ...link, url: replace(link.url) };
}

/** Substitutes tokens across a `urls` entry, which may be a single link or an array of links. */
function substituteUrlEntry(entry: UrlEntry, replace: (s: string) => string): UrlEntry {
  return Array.isArray(entry)
    ? entry.map((link) => substituteUrlLink(link, replace))
    : substituteUrlLink(entry, replace);
}

type ResolvedRunAny = z.infer<typeof RunConfigSchema>;

function substituteRun(
  name: string,
  run: ResolvedRunAny,
  tokens: Record<string, string | undefined>,
): ResolvedRunAny {
  const primarySubdomain = Array.isArray(run.subdomain) ? run.subdomain[0] : run.subdomain;
  const replace = (s: string): string => {
    let out = s.replaceAll('$name', name);
    if (out.includes('$subdomain')) {
      if (!primarySubdomain) {
        throw new Error(`${name} uses $subdomain but run.subdomain is not defined`);
      }
      out = out.replaceAll('$subdomain', primarySubdomain);
    }
    if (out.includes('$port')) {
      if (run.port === undefined) {
        throw new Error(`${name} uses $port but run.port is not defined`);
      }
      out = out.replaceAll('$port', String(run.port));
    }
    // Extrinsic tokens: any remaining $key must resolve from tokens.
    return substituteTokens(out, tokens, name);
  };
  return {
    ...run,
    urls: run.urls?.map((entry) => substituteUrlEntry(entry, replace)),
    healthcheck: run.healthcheck ? replace(run.healthcheck) : undefined,
  };
}

/** Renders a Zod parse failure into a readable, multi-line message. */
function formatConfigError(err: z.ZodError): string {
  const lines = err.issues.map((issue) => {
    const at = issue.path.length ? issue.path.join('.') : '(root)';
    const hint = issue.path.includes('command')
      ? ' — a command that watches must also build (watches:true requires builds:true)'
      : '';
    return `  - ${at}: ${issue.message}${hint}`;
  });
  return `invalid devtooie config:\n${lines.join('\n')}`;
}

export function defineConfig<const N extends string>(opts: DefineConfigOptions<N>): Config<N> {
  const result = DefineConfigSchema.safeParse(opts);
  if (!result.success) {
    throw new Error(formatConfigError(result.error));
  }
  const parsed = result.data;

  const workspaceDir = parsed.workspaceDir ?? process.cwd();

  // Validate waitFor targets: each must exist and define a healthcheck.
  const healthcheckPackages = new Set(parsed.packages.filter((c) => c.run?.healthcheck).map((c) => c.name)); // prettier-ignore
  const allNames = new Set(parsed.packages.map((c) => c.name));
  for (const config of parsed.packages) {
    for (const waitName of config.run?.waitFor ?? []) {
      if (!allNames.has(waitName)) {
        throw new Error(`${config.name} has waitFor "${waitName}" but no such package exists`);
      }
      if (!healthcheckPackages.has(waitName)) {
        throw new Error(
          `${config.name} has waitFor "${waitName}" but that package has no healthcheck defined`,
        );
      }
    }
  }

  const tokens = parsed.tokens ?? {};

  const packages = parsed.packages.map((config) => {
    const relativeDir = config.relativeDir ?? `packages/${config.name}`;
    return {
      ...config,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
      run: config.run ? substituteRun(config.name, config.run, tokens) : undefined,
    };
  });

  const urls = parsed.urls?.map((entry) =>
    substituteUrlEntry(entry, (s) => substituteTokens(s, tokens, 'top-level url')),
  );

  const resolved: Config<N> = {
    apiPort: parsed.apiPort,
    packages: packages as unknown as ResolvedPackageConfig<N>[],
    urls,
    envFiles: parsed.env?.files ?? DEFAULT_ENV_FILES,
  };
  registeredPackages = resolved.packages as AnyPackageConfig[];
  loadedConfig = resolved as Config<string>;
  return resolved;
}

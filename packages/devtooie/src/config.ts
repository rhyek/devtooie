import path from 'node:path';
import type { z } from 'zod';
import { DEFAULT_ENV_FILES } from './env.js';
import {
  type UrlLinkSchema,
  type UrlEntrySchema,
  type CommandSchema,
  type PackageConfigSchema,
  DefineConfigSchema,
} from './config-schema.js';
import type { GeneratedPackageConfig, GeneratedDefineConfig } from './config.generated.js';

export const PackageType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type PackageType = (typeof PackageType)[keyof typeof PackageType];
export type PackageTypeValue = 'backend' | 'browser' | 'lib';

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

/** A resolved `command`: which script to run and how it behaves on file changes. */
export type Command = z.infer<typeof CommandSchema>;

// ---------------------------------------------------------------------------
// Documented input types = generated types (JSDoc from the schema `.describe()`) with the
// fields Zod can't represent well overridden here: `command` (a transform → `any`) and the
// name-referencing `name`/`waitFor`/`deps` (pinned to the package names `N`, `NoInfer` so a
// typo is a compile error). Docs on kept fields flow from `config.generated.ts`.
// ---------------------------------------------------------------------------

/**
 * `command` options. `watches` and `cleans` both imply building, so `builds: false` is only
 * legal when the command neither watches nor cleans.
 */
export type CommandOptions =
  | { watches?: boolean; builds?: true; cleans?: boolean }
  | { watches: false; builds: false; cleans?: false };

/**
 * The dev process to run and how it behaves: a script/target name, or
 * `[name, { watches, builds, cleans }]`.
 */
export type CommandInput = string | [string, CommandOptions];

/** Name-referencing fields shared by the input and resolved package types (pinned to `N`). */
type PackageNameRefs<N extends string> = {
  /** Package names whose `healthcheck` must pass before this package starts. */
  waitFor?: NoInfer<N>[];
  /** Other packages this one depends on, by category. */
  deps?: {
    /** Extends the build-time deps inferred from `tsconfig.build.json` (transitive). */
    build?: NoInfer<N>[];
    /** Compiled before running (currently like `build`). */
    dev?: NoInfer<N>[];
    /** Packages that must be running alongside this one (not transitive). */
    runtime?: NoInfer<N>[];
  };
};

export type PackageConfigInput<N extends string> = Omit<
  GeneratedPackageConfig,
  'name' | 'command' | 'waitFor' | 'deps' | 'logs'
> &
  PackageNameRefs<N> & {
    /** Unique identifier; referenced from the CLI (`-p`), `waitFor`, and `deps`. */
    name: N;
    /** Per-package log options, overriding the top-level {@link DefineConfigOptions.logs}. */
    logs?: {
      /**
       * Prefix this package's on-screen log lines with a `YYYY-MM-DD HH:MM:SS` (24-hour)
       * timestamp. Overrides the top-level `logs.timestamps` for this package; when omitted, it
       * inherits that setting (which itself defaults to `false`). The on-disk log file is always
       * timestamped regardless of this option.
       */
      timestamps?: boolean;
      /**
       * Transform each raw output line from this package's dev process before it's shown and
       * logged. Receives one line of the process's stdout/stderr (no devtooie prefix or
       * timestamp) and returns the string to display. Ideal for pretty-printing a "production"
       * **structured (JSON) logger** — parse the line, and on a match return a compact
       * human-readable form; otherwise return it unchanged:
       *
       * ```ts
       * import { defineConfig, z } from 'devtooie';
       * const Log = z.object({ level: z.string(), msg: z.string() });
       * // ...
       * logs: {
       *   formatter: (line) => {
       *     try {
       *       const o = JSON.parse(line);
       *       if (!Log.safeParse(o).success) return line;
       *       return `${o.level} ${o.msg}`;
       *     } catch {
       *       return line; // not JSON — leave it as-is
       *     }
       *   },
       * },
       * ```
       *
       * devtooie owns the timestamp (its own, shown per `logs.timestamps` and always in the log
       * file), so drop the log's own time field rather than printing it. The returned string
       * (ANSI color allowed) is what's buffered, displayed, and written to the log file. A
       * formatter that throws or returns a non-string falls back to the raw line.
       */
      formatter?: (line: string) => string;
    };
    /**
     * The dev process to run and how it behaves. A script/target name, or
     * `[name, { watches, builds, cleans }]`. Default `['dev', { watches: true, builds: true }]`.
     * Pass `null` for a package with no dev process — devtooie never starts it (it's build/dep-only)
     * and it's hidden from the interactive picker.
     *
     * - `watches` — the script watches files and reloads itself.
     * - `builds` — the script (re)builds on start. `watches: true` requires `builds: true`.
     * - `cleans` — the script does a *clean* rebuild on start (no stale output to clear). Enables
     *   the `rebuild` command even without separate `clean`/`build` scripts; requires `builds: true`.
     *
     * Drives what to do after editing this package's code: `watches`→nothing, else
     * `builds`→restart, else rebuild.
     */
    command?: CommandInput | null;
  };

export type DefineConfigOptions<N extends string> = Omit<GeneratedDefineConfig, 'packages'> & {
  /** Your package definitions. */
  packages: PackageConfigInput<N>[];
};

// ---------------------------------------------------------------------------
// Resolved (runtime) types — normalized `command`, substituted urls. Derived from the
// schema via `z.infer`; name-referencing fields overlaid with `N`.
// ---------------------------------------------------------------------------

export type ResolvedPackageConfig<N extends string> = Omit<
  z.infer<typeof PackageConfigSchema>,
  'name' | 'waitFor' | 'deps'
> &
  PackageNameRefs<N> & { name: N; relativeDir: string; path: string };

export type AnyPackageConfig = ResolvedPackageConfig<string>;

export interface Config<N extends string> {
  /** User-pinned control-API port, or `undefined` to let devtooie pick a random one at startup. */
  apiPort?: number;
  packages: ResolvedPackageConfig<N>[];
  /** Resolved workspace-wide URLs (extrinsic tokens substituted), or `undefined` if none. */
  urls?: UrlEntry[];
  /** Resolved `.env` filenames loaded per package (defaults to {@link DEFAULT_ENV_FILES}). */
  envFiles: string[];
  /** Whether to prefix on-screen log lines with a timestamp (defaults to `false`). */
  logTimestamps: boolean;
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
  if (!pkg) {
    throw new Error(`package ${name} not found`);
  }
  return pkg;
}

/** The dev-process script/target name for a package (`command.name`, default `'dev'`). */
export function getDevScript(pkg: AnyPackageConfig): string {
  return pkg.command?.name ?? 'dev';
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

type ParsedPackage = z.infer<typeof PackageConfigSchema>;

/** Substitutes intrinsic (`$name`/`$subdomain`/`$port`) then extrinsic tokens in a package's
 * token-bearing fields (`urls`, `healthcheck`), returning just those resolved fields. */
function substitutePackageTokens(
  pkg: ParsedPackage,
  tokens: Record<string, string | undefined>,
): Pick<ParsedPackage, 'urls' | 'healthcheck'> {
  const primarySubdomain = Array.isArray(pkg.subdomain) ? pkg.subdomain[0] : pkg.subdomain;
  const replace = (s: string): string => {
    let out = s.replaceAll('$name', pkg.name);
    if (out.includes('$subdomain')) {
      if (!primarySubdomain) {
        throw new Error(`${pkg.name} uses $subdomain but subdomain is not defined`);
      }
      out = out.replaceAll('$subdomain', primarySubdomain);
    }
    if (out.includes('$port')) {
      if (pkg.port === undefined) {
        throw new Error(`${pkg.name} uses $port but port is not defined`);
      }
      out = out.replaceAll('$port', String(pkg.port));
    }
    // Extrinsic tokens: any remaining $key must resolve from tokens.
    return substituteTokens(out, tokens, pkg.name);
  };
  return {
    urls: pkg.urls?.map((entry) => substituteUrlEntry(entry, replace)),
    healthcheck: pkg.healthcheck ? replace(pkg.healthcheck) : undefined,
  };
}

/** Renders a Zod parse failure into a readable, multi-line message. */
function formatConfigError(err: z.ZodError): string {
  const lines = err.issues.map((issue) => {
    const at = issue.path.length ? issue.path.join('.') : '(root)';
    const hint = issue.path.includes('command')
      ? ' — a command that watches or cleans must also build (builds:false requires watches:false and cleans:false)'
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
  const healthcheckPackages = new Set(parsed.packages.filter((c) => c.healthcheck).map((c) => c.name)); // prettier-ignore
  const allNames = new Set(parsed.packages.map((c) => c.name));
  for (const config of parsed.packages) {
    for (const waitName of config.waitFor ?? []) {
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
      ...substitutePackageTokens(config, tokens),
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
    logTimestamps: parsed.logs?.timestamps ?? false,
  };
  registeredPackages = resolved.packages as AnyPackageConfig[];
  loadedConfig = resolved as Config<string>;
  return resolved;
}

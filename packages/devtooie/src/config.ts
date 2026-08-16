import path from 'node:path';
import type { z } from 'zod';
import { ambientEnv, resolveEnv, envFileNames, currentMode, type EnvOverride } from './env.js';
import { type CommandSchema, type PackageConfigSchema, DefineConfigSchema, DEFAULT_HEALTHCHECK_TIMEOUT_MS } from './config-schema.js'; // prettier-ignore
import type { GeneratedPackageConfig, GeneratedDefineConfig } from './config.generated.js';

export const PackageType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type PackageType = (typeof PackageType)[keyof typeof PackageType];
export type PackageTypeValue = 'backend' | 'browser' | 'lib';

/** A single link: a bare URL, or a labeled URL (the label is shown in place of the URL). */
export type UrlLink = string | { label: string; url: string };
/**
 * One footer line's worth of links: a single link, or an array of links rendered on the
 * same line separated by a space. `urls` is a list of these entries, one line each.
 */
export type UrlEntry = UrlLink | UrlLink[];

/** One footer line after normalization: the links to render on it (label falls back to url). */
export type UrlLine = { label?: string; url: string }[];

/** Flattens a resolved `urls` entry into the links shown on a single footer line. */
export function normalizeUrlEntry(entry: UrlEntry): UrlLine {
  const links = Array.isArray(entry) ? entry : [entry];
  return links.map((link) => (typeof link === 'string' ? { url: link } : link));
}

/** A resolved `command`: which script to run and how it behaves on file changes. */
export type Command = z.infer<typeof CommandSchema>;

/**
 * What every config callback receives. devtooie does no string interpolation — a value that
 * depends on the environment is a function of this context, evaluated once while the config
 * is being defined.
 *
 * An object (rather than positional arguments) so more context can be added later without
 * breaking existing configs.
 */
export interface ConfigContext<T = TokenRecord> {
  /**
   * The package's resolved `.env` files merged **over** `process.env` — the same environment
   * its dev process will be spawned with, minus the `PORT` devtooie injects. File values win
   * over ambient ones, and package-scope files win over workspace-scope ones. (For the
   * workspace-wide `urls`, which belong to no package, this is the workspace scope alone.)
   */
  envs: Record<string, string>;
  /**
   * The config's top-level `tokens` merged with this package's own `tokens` (the package's
   * win), **typed from what you declared** — so `tokens.domain` is known and a typo is a
   * compile error. The workspace-wide `urls` see only the top-level ones.
   */
  tokens: T;
}

/** What a package's `healthcheck`/`urls` callbacks receive: {@link ConfigContext} plus the port. */
export interface PackageContext<T = TokenRecord> extends ConfigContext<T> {
  /**
   * The package's resolved `port` — a literal, or its `port` callback's result (already
   * validated to be a finite number). Typed as `number`, not `number | undefined`, so it drops
   * straight into a URL or arithmetic with no `!` or `??`.
   *
   * That is **enforced at load time rather than by the type system**: whether a package declared
   * a `port` can't be reflected here (a mapped type infers exactly one type parameter, and this
   * config spends it on per-package `tokens`). So for a package with no `port`, reading `port`
   * in a callback throws immediately when the config loads, naming the package — instead of
   * silently interpolating `undefined` into a URL. A portless package whose callbacks never
   * read `port` is unaffected.
   */
  port: number;
}

/** Any `tokens` record: your own string values, keyed however you like. */
export type TokenRecord = Record<string, string | undefined>;

/**
 * A package's own `tokens` as inferred from the config, normalized. A package that declares
 * none infers `unknown` for its slot, which becomes the empty record here.
 *
 * The type parameter `P` in {@link defineConfig} is constrained to `Record<K, unknown>` rather
 * than `Record<K, TokenRecord>` on purpose: TypeScript validates an inferred type against its
 * constraint and, on failure, **throws the inference away and substitutes the constraint**. A
 * package with no `tokens` doesn't infer a `TokenRecord`, so the tighter constraint discarded
 * the inference for *every* package at once (see microsoft/TypeScript#52262). Keeping the
 * constraint permissive and normalizing here is what lets one package declare `tokens` while
 * its siblings declare nothing.
 */
export type OwnTokens<Own> = unknown extends Own
  ? Record<never, never>
  : Own extends TokenRecord
    ? Own
    : Record<never, never>;

/**
 * The token type a package's callbacks see: the config's top-level `tokens` with this
 * package's own merged **over** them.
 */
export type PackageTokens<Top, Own> =
  // An override, not a merge: a key the package redeclares replaces the config's, so the
  // config's must be removed rather than intersected (`'https' & 'http'` would be `never`).
  Omit<Top, keyof OwnTokens<Own>> & OwnTokens<Own>;

/** A package `port` computed from the package's environment. */
export type PortResolver<T = TokenRecord> = (ctx: ConfigContext<T>) => number | undefined;

/** A URL computed from the package's environment. */
export type UrlResolver<T = TokenRecord> = (ctx: PackageContext<T>) => string;

/**
 * A URL in the config: a literal string, or a callback devtooie invokes once at load time.
 * `C` is the context the callback gets — {@link PackageContext} for a package's fields,
 * {@link ConfigContext} for the workspace-wide `urls` (which have no port).
 */
export type UrlValue<C = PackageContext> = string | ((ctx: C) => string);
/**
 * A `healthcheck` as written in the config: the URL on its own (a string or a callback), or an
 * object pairing it with a `timeout`. {@link defineConfig} normalizes both to
 * {@link ResolvedHealthcheck}.
 */
export type HealthcheckInput<C = PackageContext> =
  | UrlValue<C>
  | {
      /**
       * The URL devtooie polls for readiness — a literal, or a callback over
       * `{ envs, tokens, port }` invoked once at load time:
       * `url: ({ port }) => \`http://localhost:${port}/health\``.
       */
      url: UrlValue<C>;
      /**
       * **Milliseconds** a single probe may take before devtooie aborts it. Defaults to
       * `1500`.
       *
       * Raise it for a service slow to answer on a cold start: aborting the request is
       * itself what makes such a server log a dropped connection (`ECONNRESET`), and the
       * abandoned probe leaves the package showing `starting` until a later one lands.
       *
       * Probes for a package never overlap — the next starts 2 s after the previous one
       * *started*, or immediately if that has already passed — so a longer timeout slows
       * this package's polling instead of stacking requests, and affects no other package.
       */
      timeout?: number;
    };
/** A package's `healthcheck` after resolution: the URL to probe, and how long a probe may take. */
export interface ResolvedHealthcheck {
  /** The URL devtooie polls, with any callback already resolved to a string. */
  url: string;
  /** **Milliseconds** a single probe may take before it's aborted (default `1500`). */
  timeout: number;
}
/** One link as written in the config: a URL, or a labeled URL. */
export type UrlLinkInput<C = PackageContext> = UrlValue<C> | { label: string; url: UrlValue<C> };
/** One `urls` entry as written in the config: a single link, or several rendered on one line. */
export type UrlEntryInput<C = PackageContext> = UrlLinkInput<C> | UrlLinkInput<C>[];

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

/**
 * Name-referencing fields shared by the input and resolved package types. Every name is
 * validated against the real package list by `defineConfig` at load time.
 */
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

/**
 * One package as written in the config. `Own` is that package's own `tokens` and `Top` the
 * config's — both inferred from what you wrote, so the callbacks below see the merged record
 * with real keys.
 */
export type PackageConfigInput<Own = unknown, Top = object, N extends string = string> = Omit<
  GeneratedPackageConfig,
  'name' | 'command' | 'waitFor' | 'deps' | 'logs' | 'port' | 'urls' | 'healthcheck' | 'tokens'
> &
  PackageNameRefs<N> & {
    /**
     * Values of your own for this package's callbacks, merged **over** the config's top-level
     * `tokens` and handed to them as `tokens` — typed from what you declare here, so
     * `tokens.region` is known and a typo is a compile error.
     *
     * Only this package's callbacks see these; a sibling that doesn't declare `region` gets a
     * compile error for `tokens.region`. Packages with no tokens of their own simply omit the
     * field.
     *
     * (`NoInfer` on the value type keeps the declaration checked — a non-string token value is
     * an error here — without that check re-entering inference.)
     */
    tokens?: Own & NoInfer<TokenRecord>;
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
       * logged. Receives one line of the process's stdout/stderr (no devtooie prefix or timestamp)
       * and returns the string to display. **This is the general hook** — it sees the whole line as
       * a plain string and assumes nothing about its format, so it's what you use to reshape
       * *any* output, structured or not.
       *
       * If the process logs **structured JSON**, don't write this by hand — `logging.formatter`
       * (and its ecosystem presets) already builds one, and devtooie applies the default to every
       * package automatically. Reach for a hand-written formatter when the output isn't JSON, or
       * when you want a rendering the built-in one can't express:
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
       * Return the line unchanged to pass it through — a formatter that reshapes only some lines
       * is normal, and is how the built-in one behaves.
       *
       * devtooie owns the timestamp (its own, shown per `logs.timestamps` and always in the log
       * file), so drop the log's own time field rather than printing it. The returned string
       * (ANSI color allowed) is what's buffered, displayed, and written to the log file. A
       * formatter that throws or returns a non-string falls back to the raw line.
       */
      formatter?: (line: string) => string;
    };
    /**
     * The package's dev port. Injected into its dev process as `PORT` (an explicit `.env`
     * `PORT` still wins), handed to this package's `healthcheck`/`urls` callbacks, and swept
     * on session handoff.
     *
     * Pass a **callback** to derive it from the package's environment. It receives the
     * package's `.env` files already resolved and merged over `process.env` — the same
     * environment the dev process will get — so the port can live in an env file instead of
     * being hardcoded:
     *
     * ```ts
     * {
     *   name: 'backend',
     *   port: ({ envs }) => Number(envs.BACKEND_PORT),
     *   healthcheck: ({ port }) => `http://localhost:${port}/health`,
     * }
     * ```
     *
     * The callback runs once, while the config is being defined, and must return a number
     * synchronously (or `undefined` for "no port", the same as omitting the field).
     */
    port?: number | PortResolver<PackageTokens<Top, Own>>;
    /**
     * Links shown in the running footer, one entry per line. An entry is a URL, a
     * `{ label, url }`, or an **array** of those (rendered on one line, space-separated).
     *
     * Any URL — bare or inside `{ label, url }` — may instead be a **callback** receiving
     * `{ envs, tokens, port }`, so a link can be built from this package's resolved port or
     * environment rather than hardcoded:
     *
     * ```ts
     * urls: [
     *   ({ port }) => `http://localhost:${port}/todos`,
     *   { label: 'home', url: ({ tokens }) => `https://app.${tokens.domain}` },
     * ]
     * ```
     */
    urls?: UrlEntryInput<PackageContext<PackageTokens<Top, Own>>>[];
    /**
     * A URL polled for readiness; also required by anything that lists this package in its
     * `waitFor`. Like `urls`, it may be a callback over `{ envs, tokens, port }`:
     * `healthcheck: ({ port }) => \`http://localhost:${port}/health\``.
     *
     * Pass an object to give this package's probes a longer deadline than the 1500 ms default —
     * worth doing for a service slow to answer on a cold start, since devtooie aborting the
     * request is itself what makes the server log a dropped connection:
     *
     * ```ts
     * healthcheck: { url: ({ port }) => `http://localhost:${port}/health`, timeout: 10_000 }
     * ```
     *
     * devtooie probes one package at a time, no more often than every 2 s (measured from the
     * start of the previous probe), so a longer `timeout` slows this package's polling rather
     * than stacking requests — and affects no other package.
     */
    healthcheck?: HealthcheckInput<PackageContext<PackageTokens<Top, Own>>>;
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

/**
 * `defineConfig`'s options. `Top` is the config's own `tokens` and `P` the per-package ones,
 * keyed by package name — `packages` is a mapped type over `P` so each package's callbacks are
 * typed with *its* tokens merged over `Top`, and `K` (the keys) types every name reference.
 */
export type DefineConfigOptions<
  Top extends TokenRecord,
  P extends Record<string, unknown>,
  K extends string = Extract<keyof P, string>,
> = Omit<GeneratedDefineConfig, 'packages' | 'urls' | 'tokens'> & {
  /**
   * Your package definitions, **keyed by package name**. The key is the package's name —
   * what `-p` takes, what `waitFor`/`deps` reference, and what `relativeDir` defaults from
   * (`packages/<key>`).
   */
  // `& Record<K, unknown>` is a second, **key-only** inference channel, and it is what keeps the
  // package names narrowed. The mapped type infers `P` from each package's `tokens`, but a
  // package literal made up entirely of callbacks is context-sensitive: TypeScript skips it in
  // the pass that would register its key, so with the mapped type alone a config where *every*
  // package declares nothing but callbacks inferred no keys at all and `K` widened to `string`
  // (dropping the `waitFor`/`deps` checks). `Record<K, unknown>` has `unknown` values, so it
  // needs no contextual typing and infers the keys regardless — without competing with `P`.
  packages: { [Q in keyof P]: PackageConfigInput<P[Q], Top, K> } & Record<K, unknown>;
  /**
   * Values of your own, handed to every callback as `tokens` (merged under each package's own
   * `tokens`) and typed from what you declare here.
   */
  tokens?: Top;
  /**
   * Workspace-wide footer links, not tied to a package — same entry shape as a package's
   * `urls`, but a callback here gets only `{ envs, tokens }` (there's no package, so no
   * `port`, and only the top-level tokens), with `envs` resolved at the workspace scope.
   */
  urls?: UrlEntryInput<ConfigContext<Top>>[];
};

// ---------------------------------------------------------------------------
// Resolved (runtime) types — normalized `command`, callbacks already invoked. Derived from the
// schema via `z.infer`; name-referencing fields overlaid with `N`.
// ---------------------------------------------------------------------------

export type ResolvedPackageConfig<N extends string, T = TokenRecord> = Omit<
  z.infer<typeof PackageConfigSchema>,
  'waitFor' | 'deps' | 'port' | 'urls' | 'healthcheck' | 'tokens'
> &
  PackageNameRefs<N> & {
    /** The package's name — the key it was declared under. */
    name: N;
    /**
     * The config's top-level `tokens` with this package's own merged over them, typed from
     * what was declared. Available on the exported config, so other scripts can read a
     * package's tokens: `config.packages.api.tokens.region`.
     */
    tokens: T;
    relativeDir: string;
    path: string;
    /** The package's dev port, with any `port` callback already resolved. */
    port?: number;
    /** Footer links, with every callback already resolved to a string. */
    urls?: UrlEntry[];
    /** The readiness probe, normalized from whichever form the config wrote. */
    healthcheck?: ResolvedHealthcheck;
  };

export type AnyPackageConfig = ResolvedPackageConfig<string>;

/**
 * The resolved config `defineConfig` returns (and a config file exports). `P` carries each
 * package's declared tokens, so `packages` is keyed by name with per-package token types.
 */
export interface Config<
  N extends string,
  P extends Record<N, unknown> = Record<N, TokenRecord>,
  Top = TokenRecord,
> {
  /** User-pinned control-API port, or `undefined` to let devtooie pick a random one at startup. */
  apiPort?: number;
  /**
   * The resolved packages, **keyed by name** — the same keys the config declared, so
   * `config.packages.api.tokens` is that package's tokens and `config.packages.ghost` is a
   * compile error. Use `Object.values(config.packages)` to iterate.
   */
  packages: { [Q in N]: ResolvedPackageConfig<Q, PackageTokens<Top, P[Q]>> };
  /** Workspace-wide URLs, with every callback resolved to a string, or `undefined` if none. */
  urls?: UrlEntry[];
  /** Resolved `.env` filenames loaded per package, for the active mode. */
  envFiles: string[];
  /** The active mode (`--mode`, else `DEVTOOIE_MODE`, else `development`). */
  envMode: string;
  /** Variables whose `.env` value may beat the ambient environment. */
  envOverride?: EnvOverride;
  /** Whether to prefix on-screen log lines with a timestamp (defaults to `false`). */
  logTimestamps: boolean;
}

// ---------------------------------------------------------------------------
// State + lookups
// ---------------------------------------------------------------------------

let registeredPackages: AnyPackageConfig[] = [];
let loadedConfig: Config<string> | null = null;
/**
 * Absolute directory package paths resolve against. Set when a config loads; until then the
 * process cwd, which is what `defineConfig` itself defaults to.
 */
let workspaceRoot: string = process.cwd();

export function getRegisteredPackages(): AnyPackageConfig[] {
  return registeredPackages;
}

/** The most recently defined config (meta + packages), or null before any `defineConfig` runs. */
export function getLoadedConfig(): Config<string> | null {
  return loadedConfig;
}

/**
 * The workspace root every package path was resolved against — the config's `workspaceDir`, or
 * the cwd when it doesn't set one. Not the config file's own directory: a config in a subdirectory
 * can point `workspaceDir` elsewhere, and anything reasoning about "is this process ours?" has to
 * ask about the same tree the packages actually live in.
 */
export function getWorkspaceDir(): string {
  return workspaceRoot;
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
// Callback resolution (post-parse) — every `port`/`healthcheck`/`urls` callback is invoked
// exactly once here, so nothing downstream ever encounters a function.
// ---------------------------------------------------------------------------

/**
 * Memoizes a synchronous factory. Every context is built through one of these, so a config
 * whose values are all literals never reads an `.env` file, and one that has ten callbacks
 * reads them once.
 */
function once<T>(factory: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => (cached ??= { value: factory() }).value;
}

/**
 * A URL as written in the config, resolved to a string: returned as-is when it's already one,
 * otherwise the callback's return value. `where` names the field in the error a callback that
 * doesn't return a string produces.
 */
function resolveUrlValue(value: UrlValue, ctx: () => PackageContext, where: string): string {
  if (typeof value !== 'function') {
    return value;
  }
  const url = value(ctx());
  if (typeof url !== 'string') {
    throw new Error(`${where}: callback returned ${String(url)} (expected a string)`);
  }
  return url;
}

/** Resolves one link (bare URL or `{ label, url }`), preserving its shape. */
function resolveUrlLink(link: UrlLinkInput, ctx: () => PackageContext, where: string): UrlLink {
  return typeof link === 'object'
    ? { ...link, url: resolveUrlValue(link.url, ctx, where) }
    : resolveUrlValue(link, ctx, where);
}

/**
 * Normalizes a `healthcheck` to `{ url, timeout }`: the bare-URL form takes the default
 * timeout, and either form's URL may be a callback.
 */
function resolveHealthcheck(
  value: HealthcheckInput,
  ctx: () => PackageContext,
  where: string,
): ResolvedHealthcheck {
  const spec = typeof value === 'object' ? value : { url: value, timeout: undefined };
  return {
    url: resolveUrlValue(spec.url, ctx, where),
    timeout: spec.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS,
  };
}

/** Resolves a `urls` entry, which may be a single link or an array rendered on one line. */
function resolveUrlEntry(entry: UrlEntryInput, ctx: () => PackageContext, where: string): UrlEntry {
  return Array.isArray(entry)
    ? entry.map((link) => resolveUrlLink(link, ctx, where))
    : resolveUrlLink(entry, ctx, where);
}

/** A parsed package plus the `name` taken from the key it was declared under. */
type ParsedPackage = z.infer<typeof PackageConfigSchema> & { name: string };

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

/**
 * A package's effective port: the literal number, or the result of its `port` callback. The
 * callback can't see `port` itself, so it gets the base {@link ConfigContext}.
 */
function resolvePort(
  pkg: ParsedPackage,
  ctx: () => ConfigContext,
  envFilesLoaded: () => string[],
): number | undefined {
  if (typeof pkg.port !== 'function') {
    return pkg.port;
  }
  const port = pkg.port(ctx());
  if (port === undefined) {
    return undefined;
  }
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    const files = envFilesLoaded();
    const where = files.length
      ? `env files loaded: ${files.join(', ')}`
      : 'no env files were found';
    throw new Error(
      `${pkg.name}: port callback returned ${String(port)} (check the env vars it reads)\n  ${where}`,
    );
  }
  return port;
}

/**
 * Builds the context a package's `healthcheck`/`urls` callbacks get.
 *
 * {@link PackageContext.port} is typed `number` so callbacks don't have to unwrap it, which the
 * type system can't verify — a mapped type infers only one type parameter and this config spends
 * it on per-package `tokens`. So when the package has no port, `port` becomes a getter that
 * throws. Callbacks all run here, once, while the config loads, so a package that reads a port it
 * never declared fails immediately with its own name in the message rather than quietly producing
 * `…:undefined`. Non-enumerable so a spread or a debug log of the context can't trip it.
 */
function withPort(
  base: ConfigContext,
  port: number | undefined,
  whyMissing: () => string,
): PackageContext {
  if (port !== undefined) {
    return { ...base, port };
  }
  return Object.defineProperty({ ...base } as PackageContext, 'port', {
    enumerable: false,
    configurable: true,
    get(): never {
      throw new Error(whyMissing());
    },
  });
}

export function defineConfig<
  const Top extends TokenRecord,
  P extends Record<string, unknown>,
  K extends string = Extract<keyof P, string>,
>(opts: DefineConfigOptions<Top, P, K>): Config<K, P, Top> {
  const result = DefineConfigSchema.safeParse(opts);
  if (!result.success) {
    throw new Error(formatConfigError(result.error));
  }
  const parsed = result.data;

  const workspaceDir = parsed.workspaceDir ?? process.cwd();
  workspaceRoot = path.resolve(workspaceDir);

  // The key IS the package name. Everything downstream works on an array, so flatten here.
  const parsedPackages = Object.entries(parsed.packages).map(([name, config]) => ({
    ...config,
    name,
  }));

  // JavaScript enumerates integer-like keys first, in ascending numeric order, regardless of
  // where they were written — which would silently reorder startup and the TUI. Reject them
  // rather than surprise anyone with a package that jumps the queue.
  for (const { name } of parsedPackages) {
    if (/^(0|[1-9]\d*)$/.test(name)) {
      throw new Error(
        `package name "${name}" is a number — object keys that look like integers are reordered ` +
          'by JavaScript, which would change the order packages start in. Use a non-numeric name.',
      );
    }
  }

  // `waitFor`/`deps` names are type-checked against the package keys, so a bad name is normally
  // a compile error. Re-checked here for configs that reach `defineConfig` unchecked (plain JS,
  // a `satisfies`-free dynamic build) and to enforce the healthcheck rule types can't express.
  const healthcheckPackages = new Set(parsedPackages.filter((c) => c.healthcheck).map((c) => c.name)); // prettier-ignore
  const allNames = new Set(parsedPackages.map((c) => c.name));
  for (const config of parsedPackages) {
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
    for (const [kind, names] of Object.entries(config.deps ?? {})) {
      for (const depName of names ?? []) {
        if (!allNames.has(depName)) {
          throw new Error(
            `${config.name} has deps.${kind} "${depName}" but no such package exists`,
          );
        }
      }
    }
  }

  const tokens = parsed.tokens ?? {};

  const envFiles = envFileNames();
  const envOverride = parsed.env?.override;

  /** A scope's `.env` files merged over `process.env` — the environment a callback sees. */
  const envsFor = (relativeDir: string) => {
    const load = once(() =>
      resolveEnv({ cwd: workspaceDir, relativeDir, files: envFiles, override: envOverride }),
    );
    return {
      envs: once(() => Object.assign(ambientEnv(), load().env)),
      files: () => load().files,
    };
  };

  const packages = parsedPackages.map((config) => {
    const relativeDir = config.relativeDir ?? `packages/${config.name}`;
    const env = envsFor(relativeDir);
    // The package's own tokens win over the config's, so a package can override a shared value.
    const pkgTokens = config.tokens ? { ...tokens, ...config.tokens } : tokens;
    const baseCtx = once((): ConfigContext => ({ envs: env.envs(), tokens: pkgTokens }));
    // Resolved first so the `healthcheck`/`urls` callbacks below can read it, and stored on the
    // resolved package so nothing downstream ever encounters a callback.
    const port = resolvePort(config, baseCtx, env.files);
    const ctx = once((): PackageContext =>
      withPort(
        baseCtx(),
        port,
        () =>
          `${config.name}: a callback read \`port\`, but this package declares no \`port\`. ` +
          `Add \`port\` to ${config.name} in devtooie.config.ts, or drop \`port\` from the callback.`,
      ),
    );
    return {
      ...config,
      // Stored resolved (config tokens + this package's own) so the exported config exposes
      // each package's tokens: `config.packages.api.tokens`.
      tokens: pkgTokens,
      port,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
      urls: config.urls?.map((entry) => resolveUrlEntry(entry, ctx, `${config.name} urls`)),
      healthcheck:
        config.healthcheck === undefined
          ? undefined
          : resolveHealthcheck(config.healthcheck, ctx, `${config.name} healthcheck`),
    };
  });

  // Workspace-wide urls belong to no package: workspace-scope env, and no `port` to offer.
  const workspaceCtx = once((): PackageContext =>
    withPort(
      { envs: envsFor('.').envs(), tokens },
      undefined,
      () =>
        'a workspace-wide `urls` callback read `port`, but those links belong to no package, so ' +
        "there's no port to give them. Move the link into a package's `urls`, or drop `port`.",
    ),
  );
  const urls = parsed.urls?.map((entry) => resolveUrlEntry(entry, workspaceCtx, 'top-level url'));

  const resolved: Config<string> = {
    apiPort: parsed.apiPort,
    // Back to a record, keyed by name, preserving the declaration order of the keys.
    packages: Object.fromEntries(
      packages.map((pkg) => [pkg.name, pkg]),
    ) as unknown as Config<string>['packages'],
    urls,
    envFiles,
    envMode: currentMode(),
    envOverride,
    logTimestamps: parsed.logs?.timestamps ?? false,
  };
  registeredPackages = packages as unknown as AnyPackageConfig[];
  loadedConfig = resolved;
  // The runtime shape is identical; only the key/token types are sharper for the caller.
  return resolved as unknown as Config<K, P, Top>;
}

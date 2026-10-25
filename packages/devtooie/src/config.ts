import path from 'node:path';
import { inspect } from 'node:util';
import type { z } from 'zod';
import {
  type CommandSchema,
  type InfraServiceSchema,
  type ServiceConfigSchema,
  type ProxySchema,
  DefineConfigSchema,
  SubdomainLabelSchema,
  DEFAULT_HEALTHCHECK_TIMEOUT_MS,
} from './config-schema.js';
import {
  ENV_NAME_RE,
  baseEnvs,
  resolveEnv,
  envFileNames,
  currentMode,
  type Envs,
  type EnvOverride,
  type Mode,
} from './env.js';
import { composeProjectName } from './infra/project-name.js';
import {
  DEFAULT_READY_TIMEOUT_MS,
  type InfraEnabledContext,
  type InfraInput,
  type InfraServiceCallbacks,
  type ResolvedInfra,
  type ResolvedInfraService,
} from './infra/types.js';

export const ServiceType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type ServiceType = (typeof ServiceType)[keyof typeof ServiceType];
export type ServiceTypeValue = 'backend' | 'browser' | 'lib';

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
   * The service's resolved `.env` files merged **over** `process.env` — the same environment
   * its dev process will be spawned with, minus the `PORT` (and, under the dev reverse proxy,
   * `PUBLIC_ORIGIN`) devtooie injects. File values win
   * over ambient ones, and service-scope files win over workspace-scope ones. (For the
   * workspace-wide `urls`, which belong to no service, this is the workspace scope alone.)
   * The config's own `env.vars` are in it too, ranked as a file below every real one — except
   * for the `env.vars` callback itself, which is what computes them. The variables devtooie
   * sets (`DEVTOOIE_MODE`, `DEVTOOIE_CWD`, `DEVTOOIE_WORKSPACE_DIR`) are always in it, by name.
   */
  envs: Envs;
  /**
   * The config's top-level `tokens` merged with this service's own `tokens` (the service's
   * win), **typed from what you declared** — so `tokens.domain` is known and a typo is a
   * compile error. The workspace-wide `urls` see only the top-level ones.
   */
  tokens: T;
}

/**
 * What a service's `healthcheck`/`urls` callbacks receive: {@link ConfigContext} plus the
 * service's own `port` and `subdomain`.
 */
export interface ServiceContext<T = TokenRecord> extends ConfigContext<T> {
  /**
   * The service's resolved `port` — a literal, or its `port` callback's result (already
   * validated to be a finite number). Typed as `number`, not `number | undefined`, so it drops
   * straight into a URL or arithmetic with no `!` or `??`.
   *
   * That is **enforced at load time rather than by the type system**: whether a service declared
   * a `port` can't be reflected here (a mapped type infers exactly one type parameter, and this
   * config spends it on per-service `tokens`). So for a service with no `port`, reading `port`
   * in a callback throws immediately when the config loads, naming the service — instead of
   * silently interpolating `undefined` into a URL. A portless service whose callbacks never
   * read `port` is unaffected.
   */
  port: number;
  /**
   * The service's canonical `proxy.subdomain` — the first entry when it declared several — so
   * a URL can be built from it without repeating it: `` ({ subdomain, envs }) =>
   * `https://${subdomain}.${envs.LOCALDEV_DOMAIN}` ``.
   *
   * Plain data, unlike `port`: a service that declares no `proxy` hands its callbacks
   * `undefined` here, and the optional type says so. Branch on it if a callback has to work
   * either way.
   */
  subdomain?: string;
}

/** Any `tokens` record: your own string values, keyed however you like. */
export type TokenRecord = Record<string, string | undefined>;

/**
 * A service's own `tokens` as inferred from the config, normalized. A service that declares
 * none infers `unknown` for its slot, which becomes the empty record here.
 *
 * The type parameter `P` in {@link defineConfig} is constrained to `Record<K, unknown>` rather
 * than `Record<K, TokenRecord>` on purpose: TypeScript validates an inferred type against its
 * constraint and, on failure, **throws the inference away and substitutes the constraint**. A
 * service with no `tokens` doesn't infer a `TokenRecord`, so the tighter constraint discarded
 * the inference for *every* service at once (see microsoft/TypeScript#52262). Keeping the
 * constraint permissive and normalizing here is what lets one service declare `tokens` while
 * its siblings declare nothing.
 */
export type OwnTokens<Own> = unknown extends Own
  ? Record<never, never>
  : Own extends TokenRecord
    ? Own
    : Record<never, never>;

/**
 * The token type a service's callbacks see: the config's top-level `tokens` with this
 * service's own merged **over** them.
 */
export type ServiceTokens<Top, Own> =
  // An override, not a merge: a key the service redeclares replaces the config's, so the
  // config's must be removed rather than intersected (`'https' & 'http'` would be `never`).
  Omit<Top, keyof OwnTokens<Own>> & OwnTokens<Own>;

/** A service `port` computed from the service's environment. */
export type PortResolver<T = TokenRecord> = (ctx: ConfigContext<T>) => number | undefined;

/** Environment variables a config declares; an `undefined` value leaves the variable out. */
export type EnvVars = Record<string, string | undefined>;

/** `env.vars` computed from the workspace's environment. */
export type EnvVarsResolver<T = TokenRecord> = (ctx: ConfigContext<T>) => EnvVars;

/**
 * The config's `env`: its options, or the `vars` callback on its own —
 * `env: ({ envs }) => ({ … })` is `env: { vars: ({ envs }) => ({ … }) }`.
 */
export type EnvInput<T = TokenRecord> =
  | EnvVarsResolver<T>
  | {
      /**
       * Environment variables of the config's own, for every service devtooie runs, `devtooie
       * exec` / `run`, and infra. A record, or a callback over the workspace context
       * `{ envs, tokens }` invoked once at load, before anything else in the config resolves —
       * so every other callback finds the result in its `envs`. They rank as a `.env` file read
       * before every real one, under the same rules: any file replaces them, the ambient
       * environment wins over them unless `override` names them, and a file's `${VAR}` can
       * reference them. A value is taken literally; one that is `undefined` is left out.
       */
      vars?: EnvVars | EnvVarsResolver<T>;
      /**
       * Variables whose `.env` or `env.vars` value may beat the ambient environment (`true` for all). By
       * default the ambient environment wins, as in Next.js/Vite/`node --env-file`.
       */
      override?: EnvOverride;
    };

/** A URL computed from the service's environment. */
export type UrlResolver<T = TokenRecord> = (ctx: ServiceContext<T>) => string;

/**
 * A URL in the config: a literal string, or a callback devtooie invokes once at load time.
 * `C` is the context the callback gets — {@link ServiceContext} for a service's fields,
 * {@link ConfigContext} for the workspace-wide `urls` (which have no port).
 */
export type UrlValue<C = ServiceContext> = string | ((ctx: C) => string);
/**
 * A `healthcheck` as written in the config: the URL on its own (a string or a callback), or an
 * object pairing it with a `timeout`. {@link defineConfig} normalizes both to
 * {@link ResolvedHealthcheck}.
 */
export type HealthcheckInput<C = ServiceContext> =
  | UrlValue<C>
  | {
      /**
       * The URL devtooie polls for readiness — a literal, or a callback over
       * `{ envs, tokens, port, subdomain }` invoked once at load time:
       * `url: ({ port }) => \`http://localhost:${port}/health\``.
       */
      url: UrlValue<C>;
      /**
       * **Milliseconds** a single probe may take before devtooie aborts it. Defaults to
       * `1500`.
       *
       * Raise it for a service slow to answer on a cold start: aborting the request is
       * itself what makes such a server log a dropped connection (`ECONNRESET`), and the
       * abandoned probe leaves the service showing `starting` until a later one lands.
       *
       * Probes for a service never overlap — the next starts 2 s after the previous one
       * *started*, or immediately if that has already passed — so a longer timeout slows
       * this service's polling instead of stacking requests, and affects no other service.
       */
      timeout?: number;
    };
/** A service's `healthcheck` after resolution: the URL to probe, and how long a probe may take. */
export interface ResolvedHealthcheck {
  /** The URL devtooie polls, with any callback already resolved to a string. */
  url: string;
  /** **Milliseconds** a single probe may take before it's aborted (default `1500`). */
  timeout: number;
}
/** One link as written in the config: a URL, or a labeled URL. */
export type UrlLinkInput<C = ServiceContext> = UrlValue<C> | { label: string; url: UrlValue<C> };
/** One `urls` entry as written in the config: a single link, or several rendered on one line. */
export type UrlEntryInput<C = ServiceContext> = UrlLinkInput<C> | UrlLinkInput<C>[];

// ---------------------------------------------------------------------------
// The types a config is written against, and every field's docs. Declared here rather than
// inferred from the schemas in config-schema.ts, because they carry what a schema can't: the
// service names `N` that `waitFor`/`deps` may list (`NoInfer`, so a typo is a compile error),
// and each callback's context typed from the config's own `tokens`. config.test-d.ts checks
// that they and the schemas accept the same fields.
//
// Each field is declared on a plain object type, never reached through `Omit`/`Pick` or another
// mapped type: TypeScript 7.0's editor shows no docs on hover for a field reached that way.
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
 * Name-referencing fields shared by the input and resolved service types. Every name is
 * validated against the real service list by `defineConfig` at load time.
 */
type ServiceNameRefs<N extends string> = {
  /** Service names whose `healthcheck` must pass before this service starts. */
  waitFor?: NoInfer<N>[];
  /** Other services this one depends on, by category. */
  deps?: {
    /** Extends the build-time deps inferred from `tsconfig.build.json` (transitive). */
    build?: NoInfer<N>[];
    /** Compiled before running (currently like `build`). */
    dev?: NoInfer<N>[];
    /** Services that must be running alongside this one (not transitive). */
    runtime?: NoInfer<N>[];
  };
};

/**
 * One service as written in the config. `Own` is that service's own `tokens` and `Top` the
 * config's — both inferred from what you wrote, so the callbacks below see the merged record
 * with real keys.
 */
export type ServiceConfigInput<
  Own = unknown,
  Top = object,
  N extends string = string,
  RootDir extends string | undefined = undefined,
> = ServiceNameRefs<N> &
  RelativeDirField<RootDir> & {
    /**
     * Directory holding the service, relative to `workspaceDir`. Inferred as
     * `<serviceRootDir>/<key>` when the config sets `serviceRootDir`; required otherwise. Set it
     * to override the inferred one.
     */
    relativeDir?: string;
    /** Show in the interactive picker (default `true`). */
    selectable?: boolean | undefined;
    /** Shorter label used in the TUI in place of `name`. */
    shortName?: string | undefined;
    /**
     * Color for this service's log-prefix label, overriding the auto-assigned palette color. Any
     * Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`),
     * `'rgb(175,135,255)'`, or `'ansi256(140)'`.
     */
    color?: string | undefined;
    /**
     * Automatically start this service during the run phase (default `true`). When `false`,
     * devtooie leaves it stopped — start it yourself with the `s` hotkey (or a control-API
     * `start`). Ignored when `command` is `null` (that service never starts).
     */
    autostart?: boolean | undefined;
    /**
     * tsconfig file (relative to the service dir) devtooie reads for project references to infer
     * build-time deps. Defaults to `tsconfig.build.json`, then `tsconfig.json`.
     */
    tsconfig?: string | undefined;
    /**
     * Route `<subdomain>.<rootDomain>` to this service's `port` through the dev reverse proxy.
     * See {@link ProxyInput}.
     */
    proxy?: ProxyInput;
    /** Not a service field: a service's subdomain goes under `proxy` — `proxy: { subdomain }`. */
    subdomain?: never;
    /**
     * Values of your own for this service's callbacks, merged **over** the config's top-level
     * `tokens` and handed to them as `tokens` — typed from what you declare here, so
     * `tokens.region` is known and a typo is a compile error.
     *
     * Only this service's callbacks see these; a sibling that doesn't declare `region` gets a
     * compile error for `tokens.region`. Services with no tokens of their own simply omit the
     * field.
     *
     * (`NoInfer` on the value type keeps the declaration checked — a non-string token value is
     * an error here — without that check re-entering inference.)
     */
    tokens?: Own & NoInfer<TokenRecord>;
    /** Per-service log options, overriding the top-level {@link DefineConfigOptions.logs}. */
    logs?: {
      /**
       * Prefix this service's on-screen log lines with a `YYYY-MM-DD HH:MM:SS` (24-hour)
       * timestamp. Overrides the top-level `logs.timestamps` for this service; when omitted, it
       * inherits that setting (which itself defaults to `true`). The on-disk log file is always
       * timestamped regardless of this option.
       */
      timestamps?: boolean;
      /**
       * Transform each raw output line from this service's dev process before it's shown and
       * logged. Receives one line of the process's stdout/stderr (no devtooie prefix or timestamp)
       * and returns the string to display. **This is the general hook** — it sees the whole line as
       * a plain string and assumes nothing about its format, so it's what you use to reshape
       * *any* output, structured or not.
       *
       * If the process logs **structured JSON**, don't write this by hand — `logging.formatter`
       * (and its ecosystem presets) already builds one, and devtooie applies the default to every
       * service automatically. Reach for a hand-written formatter when the output isn't JSON, or
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
     * The service's dev port. Injected into its dev process as `PORT` (only a `PORT` in the
     * service's own `.env` file overrides it), handed to this service's `healthcheck`/`urls`
     * callbacks, and swept on session handoff.
     *
     * Pass a **callback** to derive it from the service's environment. It receives the
     * service's `.env` files already resolved and merged over `process.env` — the same
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
    port?: number | PortResolver<ServiceTokens<Top, Own>>;
    /**
     * Links shown in the running footer, one entry per line. An entry is a URL, a
     * `{ label, url }`, or an **array** of those (rendered on one line, space-separated).
     *
     * Any URL — bare or inside `{ label, url }` — may instead be a **callback** receiving
     * `{ envs, tokens, port, subdomain }`, so a link can be built from this service's resolved
     * port, subdomain, or environment rather than hardcoded:
     *
     * ```ts
     * urls: [
     *   ({ port }) => `http://localhost:${port}/todos`,
     *   { label: 'home', url: ({ subdomain, tokens }) => `https://${subdomain}.${tokens.domain}` },
     * ]
     * ```
     */
    urls?: UrlEntryInput<ServiceContext<ServiceTokens<Top, Own>>>[];
    /**
     * A URL polled for readiness; also required by anything that lists this service in its
     * `waitFor`. A bare path (`'/health'`) is probed at `http://localhost:<port>/health` — always
     * the service itself on loopback, never the dev reverse proxy, which holds requests until
     * this very probe passes. Like `urls`, it may instead be a callback over
     * `{ envs, tokens, port, subdomain }`.
     *
     * Pass an object to give this service's probes a longer deadline than the 1500 ms default —
     * worth doing for a service slow to answer on a cold start, since devtooie aborting the
     * request is itself what makes the server log a dropped connection:
     *
     * ```ts
     * healthcheck: { url: ({ port }) => `http://localhost:${port}/health`, timeout: 10_000 }
     * ```
     *
     * devtooie probes one service at a time, no more often than every 2 s (measured from the
     * start of the previous probe), so a longer `timeout` slows this service's polling rather
     * than stacking requests — and affects no other service.
     */
    healthcheck?: HealthcheckInput<ServiceContext<ServiceTokens<Top, Own>>>;
    /**
     * The dev process to run and how it behaves. A script/target name, or
     * `[name, { watches, builds, cleans }]`. Default `['dev', { watches: true, builds: true }]`.
     * Pass `null` for a service with no dev process — devtooie never starts it (it's build/dep-only)
     * and it's hidden from the interactive picker.
     *
     * - `watches` — the script watches files and reloads itself.
     * - `builds` — the script (re)builds on start. `watches: true` requires `builds: true`.
     * - `cleans` — the script does a *clean* rebuild on start (no stale output to clear). Enables
     *   the `rebuild` command even without separate `clean`/`build` scripts; requires `builds: true`.
     *
     * Drives what to do after editing this service's code: `watches`→nothing, else
     * `builds`→restart, else rebuild.
     */
    command?: CommandInput | null;
  };

/**
 * How a reverse proxy reaches a service or an infra service — the same block for both. With a
 * top-level `devReverseProxy`, devtooie routes `<subdomain>.<rootDomain>` (aliases included) to
 * the declaring service's or service's `port` on `localhost`; without one it is data for
 * tooling that reads the exported config (a reverse proxy of your own, say).
 */
export interface ProxyInput {
  /**
   * The dev subdomain(s): a label, an array of them, or `true` for the declaring service's or
   * service's own key. Each entry is a DNS label — lowercase letters, digits, and hyphens, at
   * most 63 characters, not starting or ending with a hyphen — that no other service or service
   * declares. An array's first entry is the canonical subdomain (the one a service's callbacks
   * get as `subdomain`, and its public origin's); the rest are aliases that route too.
   */
  subdomain: true | string | string[];
}

/** A `proxy` block after resolution: `subdomain: true` replaced by the declaring key. */
export interface ResolvedProxy {
  /** The subdomain(s) as labels. An array's first entry is the canonical one. */
  subdomain: string | string[];
}

/**
 * The built-in dev reverse proxy, as written in the config. Its presence enables the proxy:
 * devtooie listens on `port` (loopback only) and routes each request by the first label of its
 * `Host` to the service or infra service whose `proxy` declares that subdomain, on its resolved
 * `port`. A TLS
 * terminator in front (Caddy, say) forwards `*.<rootDomain>` here; the proxy does no TLS itself.
 */
export interface DevReverseProxyInput<Top = TokenRecord, N extends string = string> {
  /**
   * The loopback port the proxy listens on — what the TLS terminator forwards to. A literal, or
   * a callback over the workspace context `{ envs, tokens }` resolved once at load, like a
   * service `port`: `port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT)`. Must differ from
   * every service's and infra service's port.
   */
  port: number | ((ctx: ConfigContext<Top>) => number);
  /**
   * The domain the services and services live under: `<subdomain>.<rootDomain>` routes to the
   * one whose `proxy` declares that subdomain. Defaults to `localhost`, which browsers resolve to loopback with nothing
   * in front. A lowercase hostname, literal or a callback over `{ envs, tokens }`:
   * `rootDomain: ({ envs }) => \`myproject.${envs.LOCALDEV_DOMAIN}\``.
   *
   * An array (or a callback returning one) adds aliases: the first entry is the canonical root,
   * the one every derived URL uses (`PUBLIC_ORIGIN`, footer links, the `urlScheme` default); a
   * Host under any other entry routes exactly as under the canonical one. No two entries may be
   * equal, and none may be a suffix of another.
   */
  rootDomain?: string | string[] | ((ctx: ConfigContext<Top>) => string | string[]);
  /**
   * The service the bare `rootDomain` routes to. Must declare a `port`; needs no `proxy`, and
   * without one its `PUBLIC_ORIGIN` is the bare root. Omit for a 404 there.
   */
  defaultService?: NoInfer<N>;
  /**
   * Scheme of the public URLs devtooie derives (footer links, `PUBLIC_ORIGIN`). Defaults from
   * the canonical `rootDomain`: `http` on `localhost`, `https` on any other root. `http` means the browser
   * hits the proxy directly, so the URLs carry its `port` (`http://web.localhost:4000`);
   * `https` means a TLS terminator sits in front, so they carry no port.
   */
  urlScheme?: 'http' | 'https';
}

/** The dev reverse proxy after resolution: callbacks invoked, `rootDomain`/`urlScheme` defaulted. */
export interface ResolvedDevReverseProxy {
  /** The loopback port the proxy listens on — and the port of the public URLs under `http`. */
  port: number;
  /**
   * The canonical domain services are routed under (`localhost` unless the config says
   * otherwise): the first entry when the config gives an array. Every derived URL uses it.
   */
  rootDomain: string;
  /** Every root domain the proxy routes under, canonical first, then its aliases. */
  rootDomains: string[];
  /** The service the bare `rootDomain` routes to, if any. */
  defaultService?: string;
  /** Scheme of the public URLs devtooie derives; `https` means they carry no port. */
  urlScheme: 'http' | 'https';
}

/**
 * Makes a service's `relativeDir` required when the config sets no `serviceRootDir`, and adds
 * nothing when it does (the directory is then inferred as `<serviceRootDir>/<key>`). `RootDir` is
 * the type of the config's `serviceRootDir` — `undefined` when it isn't set. The field and its
 * docs are declared in {@link ServiceConfigInput}: a field declared only inside a conditional
 * type shows no docs on hover.
 */
type RelativeDirField<RootDir extends string | undefined> = undefined extends RootDir
  ? { relativeDir: string }
  : unknown;

/**
 * `defineConfig`'s options. `Top` is the config's own `tokens` and `P` the per-service ones,
 * keyed by service name — `services` is a mapped type over `P` so each service's callbacks are
 * typed with *its* tokens merged over `Top`, and `K` (the keys) types every name reference.
 */
export type DefineConfigOptions<
  Top extends TokenRecord,
  P extends Record<string, unknown>,
  K extends string = Extract<keyof P, string>,
  RootDir extends string | undefined = undefined,
> = {
  /**
   * Fixed control-API port; omit to let devtooie pick one (recorded in `running.<mode>.json`). A
   * fixed port serves the session of one mode at a time.
   */
  apiPort?: number | undefined;
  /** Root each service's `relativeDir` resolves against. Defaults to `process.cwd()`. */
  workspaceDir?: string | undefined;
  /** Log display options. */
  logs?:
    | {
        /**
         * Prefix each on-screen log line with a local-time (24-hour) timestamp — `HH:MM:SS`
         * while everything on screen is from one day, `YYYY-MM-DD HH:MM:SS` once two days are
         * visible. Defaults to `true`. The on-disk log file always includes timestamps
         * regardless of this setting.
         */
        timestamps?: boolean | undefined;
      }
    | undefined;
  /**
   * Environment options: `vars`, variables of the config's own, and `override`, which `.env`
   * values may beat the ambient environment. Which files load is chosen with `--mode`. A
   * callback here is shorthand for `vars`. See {@link EnvInput}.
   */
  env?: EnvInput<Top>;
  /**
   * Infrastructure that isn't an application service — a database, a cache, a broker — keyed by
   * provider (`'docker-compose'` is the only one). `devtooie infra up` brings it up and waits until
   * it is ready, and a dev session does the same before starting the services; quitting devtooie
   * leaves it running. `infra: { 'docker-compose': true }` is a complete config.
   * See {@link InfraInput}.
   */
  infra?: InfraInput<Top>;
  /**
   * The directory the services live under, relative to `workspaceDir` — `'apps'`, say. With
   * it set, a service's directory is inferred as `<serviceRootDir>/<key>` and its `relativeDir`
   * becomes optional (an override); without it, every service must set `relativeDir`.
   */
  serviceRootDir?: RootDir;
  /**
   * Run devtooie's own dev reverse proxy: a loopback listener routing `<subdomain>.<rootDomain>`
   * to the service or infra service whose `proxy` declares that subdomain. Present = enabled;
   * there is no `enabled` flag.
   * See {@link DevReverseProxyInput}.
   */
  devReverseProxy?: DevReverseProxyInput<Top, K>;
  /**
   * Your application services, **keyed by service name**. The key is the service's name —
   * what `-s` takes, what `waitFor`/`deps` reference, and what `relativeDir` defaults from
   * (`<serviceRootDir>/<key>`).
   */
  // `& Record<K, unknown>` is a second, **key-only** inference channel, and it is what keeps the
  // service names narrowed. The mapped type infers `P` from each service's `tokens`, but a
  // service literal made up entirely of callbacks is context-sensitive: TypeScript skips it in
  // the pass that would register its key, so with the mapped type alone a config where *every*
  // service declares nothing but callbacks inferred no keys at all and `K` widened to `string`
  // (dropping the `waitFor`/`deps` checks). `Record<K, unknown>` has `unknown` values, so it
  // needs no contextual typing and infers the keys regardless — without competing with `P`.
  services: { [Q in keyof P]: ServiceConfigInput<P[Q], Top, K, RootDir> } & Record<K, unknown>;
  /**
   * Values of your own, handed to every callback as `tokens` (merged under each service's own
   * `tokens`) and typed from what you declare here.
   */
  tokens?: Top;
  /**
   * Workspace-wide footer links, not tied to a service — same entry shape as a service's
   * `urls`, but a callback here gets only `{ envs, tokens }` (there's no service, so no
   * `port`, and only the top-level tokens), with `envs` resolved at the workspace scope.
   */
  urls?: UrlEntryInput<ConfigContext<Top>>[];
};

// ---------------------------------------------------------------------------
// Resolved (runtime) types — normalized `command`, callbacks already invoked. Derived from the
// schema via `z.infer`; name-referencing fields overlaid with `N`.
// ---------------------------------------------------------------------------

export type ResolvedServiceConfig<N extends string, T = TokenRecord> = Omit<
  z.infer<typeof ServiceConfigSchema>,
  'waitFor' | 'deps' | 'port' | 'urls' | 'healthcheck' | 'tokens' | 'proxy' | 'subdomain'
> &
  ServiceNameRefs<N> & {
    /** The service's name — the key it was declared under. */
    name: N;
    /**
     * How the dev reverse proxy routes to the service: what the config wrote, with
     * `subdomain: true` already replaced by the service's name.
     */
    proxy?: ResolvedProxy;
    /**
     * The config's top-level `tokens` with this service's own merged over them, typed from
     * what was declared. Available on the exported config, so other scripts can read a
     * service's tokens: `config.services.api.tokens.region`.
     */
    tokens: T;
    /** The service directory relative to `workspaceDir`: as written, or `<serviceRootDir>/<key>`. */
    relativeDir: string;
    /** The service directory, absolute (`workspaceDir` + `relativeDir`). */
    absoluteDir: string;
    /** The service's dev port, with any `port` callback already resolved. */
    port?: number;
    /** Footer links, with every callback already resolved to a string. */
    urls?: UrlEntry[];
    /** The readiness probe, normalized from whichever form the config wrote. */
    healthcheck?: ResolvedHealthcheck;
    /**
     * The service's public origin under the dev reverse proxy —
     * `<urlScheme>://<canonical subdomain>.<rootDomain>[:<port>]`, or the bare
     * `<urlScheme>://<rootDomain>[:<port>]` for a `defaultService` that declares no subdomain —
     * or `undefined` when the config has no `devReverseProxy` or the proxy doesn't route this
     * service (no `port`, or neither a `proxy` nor `defaultService`). Injected into the service's process as `PUBLIC_ORIGIN` (only one in the
     * service's own `.env` file overrides it), and what the proxy's footer links are built from.
     */
    publicOrigin?: string;
  };

export type AnyServiceConfig = ResolvedServiceConfig<string>;

/**
 * The resolved config `defineConfig` returns (and a config file exports). `P` carries each
 * service's declared tokens, so `services` is keyed by name with per-service token types.
 */
export interface Config<
  N extends string,
  P extends Record<N, unknown> = Record<N, TokenRecord>,
  Top = TokenRecord,
> {
  /** User-pinned control-API port, or `undefined` to let devtooie pick a random one at startup. */
  apiPort?: number;
  /** The directory service directories were inferred under, when the config set one. */
  serviceRootDir?: string;
  /**
   * The resolved services, **keyed by name** — the same keys the config declared, so
   * `config.services.api.tokens` is that service's tokens and `config.services.ghost` is a
   * compile error. Use `Object.values(config.services)` to iterate.
   */
  services: { [Q in N]: ResolvedServiceConfig<Q, ServiceTokens<Top, P[Q]>> };
  /** Workspace-wide URLs, with every callback resolved to a string, or `undefined` if none. */
  urls?: UrlEntry[];
  /** The dev reverse proxy, resolved, or `undefined` when the config declares none. */
  devReverseProxy?: ResolvedDevReverseProxy;
  /** The infra providers, resolved, or `undefined` when the config declares none. */
  infra?: ResolvedInfra;
  /** Resolved `.env` filenames loaded per service, for the active mode. */
  envFiles: string[];
  /** The active mode (`--mode`, else `DEVTOOIE_MODE`, else `development`). */
  envMode: Mode;
  /** Variables whose `.env` or `env.vars` value may beat the ambient environment. */
  envOverride?: EnvOverride;
  /** The config's own variables (`env.vars`), resolved, or `undefined` when it declares none. */
  envVars?: Record<string, string>;
  /** Whether to prefix on-screen log lines with a timestamp (defaults to `false`). */
  logTimestamps: boolean;
}

// ---------------------------------------------------------------------------
// State + lookups
// ---------------------------------------------------------------------------

let registeredPackages: AnyServiceConfig[] = [];
let loadedConfig: Config<string> | null = null;
/** The loaded config's top-level `tokens` — what an infra callback receives as `tokens`. */
let loadedTokens: TokenRecord = {};
/**
 * Absolute directory service paths resolve against. Set when a config loads; until then the
 * process cwd, which is what `defineConfig` itself defaults to.
 */
let workspaceRoot: string = process.cwd();

export function getRegisteredPackages(): AnyServiceConfig[] {
  return registeredPackages;
}

/** The most recently defined config (meta + services), or null before any `defineConfig` runs. */
export function getLoadedConfig(): Config<string> | null {
  return loadedConfig;
}

/**
 * The workspace root every service path was resolved against — the config's `workspaceDir`, or
 * the cwd when it doesn't set one. Not the config file's own directory: a config in a subdirectory
 * can point `workspaceDir` elsewhere, and anything reasoning about "is this process ours?" has to
 * ask about the same tree the services actually live in.
 */
export function getWorkspaceDir(): string {
  return workspaceRoot;
}

/** The loaded config's top-level `tokens` (empty until a config loads, or when it declares none). */
export function getConfigTokens(): TokenRecord {
  return loadedTokens;
}

export function findService(name: string): AnyServiceConfig {
  const pkg = registeredPackages.find((p) => p.name === name);
  if (!pkg) {
    throw new Error(`service ${name} not found`);
  }
  return pkg;
}

/** The dev-process script/target name for a service (`command.name`, default `'dev'`). */
export function getDevScript(pkg: AnyServiceConfig): string {
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
 * What a URL is resolved against: the context its callback gets, the service's `port` and (under
 * the dev reverse proxy) public origin that a relative path is based on, and `where`, naming the
 * field in error messages. The workspace-wide `urls` have neither port nor origin.
 */
interface UrlScope {
  ctx: () => ServiceContext;
  port: number | undefined;
  publicOrigin: string | undefined;
  where: string;
  /** What declares the URL, for an error message: a service unless it says otherwise. */
  owner?: 'package' | 'service';
}

/**
 * Every form a resolved URL can take. Identical for an absolute URL; for a relative path they
 * differ once the dev reverse proxy routes the service — and each call site picks: `urls` show
 * `public` (one link, not a loopback twin), a `healthcheck` probes `private` (the service itself;
 * the proxy holds requests until that very probe passes, so probing through it would never pass).
 */
export interface ResolvedUrlForms {
  /** Under the dev reverse proxy, `<publicOrigin>/path`; otherwise the same as `private`. */
  public: string;
  /** The service itself on loopback: `http://localhost:<port>/path`. */
  private: string;
}

/** `true` for anything with a scheme (`https://…`, `ws://…`, `mailto:…`) — left exactly as written. */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A URL as written in the config, resolved into its {@link ResolvedUrlForms}: a literal or a
 * callback's return value, absolute as-is, or a relative path — with or without the leading
 * slash (`/todos` and `todos` alike), or `''` for the origin itself — based on the service. A
 * path's trailing slash is dropped (`/todos/` is `/todos`), which makes `/` the origin too.
 */
function resolveUrlForms(value: UrlValue, scope: UrlScope): ResolvedUrlForms {
  let url: unknown = value;
  if (typeof value === 'function') {
    url = value(scope.ctx());
    if (typeof url !== 'string') {
      throw new Error(`${scope.where}: callback returned ${String(url)} (expected a string)`);
    }
  }
  const text = url as string;
  if (ABSOLUTE_URL_RE.test(text)) {
    return { public: text, private: text };
  }
  // `''` is the origin itself; anything else is a path, leading slash optional and trailing
  // slash dropped — from the path alone, so a query or fragment stays exactly as written.
  const suffixAt = text.search(/[?#]/);
  const pathname = (suffixAt === -1 ? text : text.slice(0, suffixAt)).replace(/\/+$/, '');
  const suffix = suffixAt === -1 ? '' : text.slice(suffixAt);
  const path = `${pathname === '' || pathname.startsWith('/') ? pathname : `/${pathname}`}${suffix}`;
  if (scope.port === undefined) {
    throw new Error(
      scope.publicOrigin === undefined && scope.where === 'top-level url'
        ? `${scope.where}: ${JSON.stringify(text)} is a path, but workspace-wide urls belong to no ` +
            "service, so there's nothing to base it on. Move it into a service's `urls`, or write the full URL."
        : `${scope.where}: ${JSON.stringify(text)} is a path, but this ${scope.owner ?? 'service'} declares no \`port\` to ` +
            'base it on. Add `port` to it, or write the full URL.',
    );
  }
  const priv = `http://localhost:${String(scope.port)}${path}`;
  return {
    public: scope.publicOrigin === undefined ? priv : `${scope.publicOrigin}${path}`,
    private: priv,
  };
}

/** Resolves one link (bare URL or `{ label, url }`) to its public form, preserving its shape. */
function resolveUrlLink(link: UrlLinkInput, scope: UrlScope): UrlLink {
  return typeof link === 'object'
    ? { ...link, url: resolveUrlForms(link.url, scope).public }
    : resolveUrlForms(link, scope).public;
}

/**
 * Normalizes a `healthcheck` to `{ url, timeout }`: the bare-URL form takes the default
 * timeout, either form's URL may be a callback or a path, and the URL is the *private* one —
 * what the status probe polls.
 */
function resolveHealthcheck(value: HealthcheckInput, scope: UrlScope): ResolvedHealthcheck {
  const spec = typeof value === 'object' ? value : { url: value, timeout: undefined };
  return {
    url: resolveUrlForms(spec.url, scope).private,
    timeout: spec.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS,
  };
}

/** Resolves a `urls` entry, which may be a single link or an array rendered on one line. */
function resolveUrlEntry(entry: UrlEntryInput, scope: UrlScope): UrlEntry {
  return Array.isArray(entry)
    ? entry.map((link) => resolveUrlLink(link, scope))
    : resolveUrlLink(entry, scope);
}

/** A parsed service plus the `name` taken from the key it was declared under. */
type ParsedPackage = z.infer<typeof ServiceConfigSchema> & { name: string };

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

/** Which `.env` files a failed callback had to read from, for its error message. */
function envFilesNote(files: string[]): string {
  return files.length ? `env files loaded: ${files.join(', ')}` : 'no env files were found';
}

/**
 * The config's own variables: the `env.vars` record, or its callback's result. A value that
 * isn't a string is an error naming the variable — and, for a callback, the env files loaded,
 * in the style of a service `port`. An `undefined` one is left out.
 */
function resolveEnvVars(
  vars: NonNullable<z.infer<typeof DefineConfigSchema>['env']>['vars'],
  ctx: () => ConfigContext,
  envFilesLoaded: () => string[],
): Record<string, string> | undefined {
  if (vars === undefined) {
    return undefined;
  }
  const computed = typeof vars === 'function';
  const fail = (problem: string): never => {
    const where = computed ? `\n  ${envFilesNote(envFilesLoaded())}` : '';
    throw new Error(`env.vars: ${problem}${where}`);
  };
  const result: unknown = typeof vars === 'function' ? vars(ctx()) : vars;
  // A plain object only: a promise (an `async` callback) or a `Map` has no entries to read, and
  // would otherwise resolve to no variables at all without a word.
  const proto: unknown =
    typeof result === 'object' && result !== null ? Object.getPrototypeOf(result) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    const shown = typeof result === 'string' ? JSON.stringify(result) : String(result);
    return fail(
      `${computed ? 'callback returned' : 'got'} ${shown} (expected an object of variables)`,
    );
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!ENV_NAME_RE.test(key)) {
      throw new Error(
        `env.vars: ${JSON.stringify(key)} is not a valid environment variable name ` +
          '(letters, digits, "_", "." and "-")',
      );
    }
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      return fail(
        `${key} is ${inspect(value)} (a ${typeof value}) — an environment variable must be a string`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * A service's effective port: the literal number, or the result of its `port` callback. The
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
    throw new Error(
      `${pkg.name}: port callback returned ${String(port)} (check the env vars it reads)\n  ${envFilesNote(envFilesLoaded())}`,
    );
  }
  return port;
}

/**
 * Whether an infra service runs: its `enabled` literal, or its callback's answer, defaulting
 * to `true`. The callback must return a real boolean — `envs.SOME_KEY` (a string, or undefined)
 * is the easy slip, and quietly reading either as a yes or a no would be a guess.
 */
function resolveInfraEnabled(
  service: string,
  enabled: unknown,
  ctx: () => InfraEnabledContext,
): boolean {
  if (typeof enabled !== 'function') {
    return (enabled as boolean | undefined) ?? true;
  }
  const result: unknown = (enabled as (ctx: InfraEnabledContext) => unknown)(ctx());
  if (typeof result !== 'boolean') {
    throw new Error(
      `infra: the \`enabled\` callback of "${service}" returned ` +
        `${typeof result === 'string' ? JSON.stringify(result) : String(result)}, not a boolean — ` +
        'wrap it, e.g. `Boolean(envs.SOME_KEY)`.',
    );
  }
  return result;
}

/** An infra service as parsed, before anything about it is resolved. */
type ParsedInfraService = z.infer<typeof InfraServiceSchema>;

/**
 * Resolves one infra service: `enabled` first, then — only for a service that runs — its `port`
 * and `urls` callbacks, over the workspace context. A service disabled in a mode is often exactly
 * the one whose variables that mode doesn't set, so its callbacks must not run there. The infra
 * callbacks are kept as written.
 */
function resolveInfraService(
  name: string,
  { enabled, port, proxy: _, urls, ...callbacks }: ParsedInfraService,
  opts: {
    /** The service's `proxy`, already settled (see `resolveProxy`). */
    proxy: ResolvedProxy | undefined;
    devReverseProxy: ResolvedDevReverseProxy | undefined;
    ctx: () => ConfigContext;
    enabledCtx: () => InfraEnabledContext;
    envFilesLoaded: () => string[];
  },
): ResolvedInfraService {
  // Before `enabled` is read: a `proxy` with nothing to point at is a config bug in every mode.
  if (opts.proxy !== undefined && port === undefined) {
    throw new Error(
      `infra service "${name}" declares \`proxy\` but no \`port\`, so the dev reverse proxy ` +
        "can't route to it — devtooie doesn't read the port from the provider's file. Add " +
        '`port` to it (the host side of its port mapping), or drop its `proxy`.',
    );
  }
  const isEnabled = resolveInfraEnabled(name, enabled, opts.enabledCtx);
  let resolvedPort: number | undefined;
  if (isEnabled && port !== undefined) {
    resolvedPort = typeof port === 'function' ? port(opts.ctx()) : port;
    if (
      resolvedPort !== undefined &&
      (typeof resolvedPort !== 'number' || !Number.isFinite(resolvedPort))
    ) {
      throw new Error(
        `infra service "${name}": port callback returned ${String(resolvedPort)} (check the env vars it reads)\n  ${envFilesNote(opts.envFilesLoaded())}`,
      );
    }
  }
  const publicOrigin = isEnabled
    ? publicOriginOf(opts.devReverseProxy, { port: resolvedPort, proxy: opts.proxy })
    : undefined;
  const where = `infra service "${name}" urls`;
  // What a `urls` callback gets: a service's context, with the service's port and subdomain.
  const ctx = once((): ServiceContext =>
    packageContext(
      opts.ctx(),
      resolvedPort,
      subdomainsOf({ proxy: opts.proxy })[0],
      () =>
        `${where}: a callback read \`port\`, but this service declares no \`port\`. Add ` +
        '`port` to it, or drop `port` from the callback.',
    ),
  );
  return {
    ...(callbacks as InfraServiceCallbacks),
    enabled: isEnabled,
    port: resolvedPort,
    proxy: opts.proxy,
    publicOrigin,
    urls: isEnabled
      ? urls?.map((entry) =>
          resolveUrlEntry(entry, {
            ctx,
            port: resolvedPort,
            publicOrigin,
            where,
            owner: 'service',
          }),
        )
      : undefined,
  };
}

/** Whatever declares a `proxy`, as an error message names it: `api`, `infra service "mail"`. */
interface ProxyOwner {
  kind: 'package' | 'service';
  name: string;
}

function ownerLabel(owner: ProxyOwner): string {
  return owner.kind === 'package' ? owner.name : `infra service "${owner.name}"`;
}

/**
 * Settles a `proxy` block: `subdomain: true` stands for the owner's own key. A key that isn't a
 * DNS label (a scoped `@scope/web`, an uppercase or underscored one) can't be one, and guessing a
 * cleaned-up version would put it at a hostname nobody wrote down.
 */
function resolveProxy(
  proxy: z.infer<typeof ProxySchema> | undefined,
  owner: ProxyOwner,
): ResolvedProxy | undefined {
  if (proxy === undefined || proxy.subdomain !== true) {
    return proxy as ResolvedProxy | undefined;
  }
  if (!SubdomainLabelSchema.safeParse(owner.name).success) {
    throw new Error(
      `${ownerLabel(owner)}: \`subdomain: true\` uses the ${owner.kind}'s key as its subdomain, but ` +
        `"${owner.name}" isn't a DNS label (lowercase letters, digits, and hyphens). Give it an ` +
        'explicit `subdomain`.',
    );
  }
  return { ...proxy, subdomain: owner.name };
}

/** Every subdomain a `proxy` declares — canonical first, then aliases — or none. */
function subdomainsOf(target: { proxy?: ResolvedProxy | undefined }): string[] {
  const subdomain = target.proxy?.subdomain;
  return subdomain === undefined ? [] : Array.isArray(subdomain) ? subdomain : [subdomain];
}

/**
 * Builds the context a service's `healthcheck`/`urls` callbacks get: the base
 * {@link ConfigContext} plus `port` and `subdomain`.
 *
 * `subdomain` is plain data — `undefined` when the service declares none, as its type says.
 *
 * {@link ServiceContext.port} is typed `number` so callbacks don't have to unwrap it, which the
 * type system can't verify — a mapped type infers only one type parameter and this config spends
 * it on per-service `tokens`. So when the service has no port, `port` becomes a getter that
 * throws. Callbacks all run here, once, while the config loads, so a service that reads a port it
 * never declared fails immediately with its own name in the message rather than quietly producing
 * `…:undefined`. Non-enumerable so a spread or a debug log of the context can't trip it.
 */
function packageContext(
  base: ConfigContext,
  port: number | undefined,
  subdomain: string | undefined,
  whyPortMissing: () => string,
): ServiceContext {
  if (port !== undefined) {
    return { ...base, port, subdomain };
  }
  return Object.defineProperty({ ...base, subdomain } as ServiceContext, 'port', {
    enumerable: false,
    configurable: true,
    get(): never {
      throw new Error(whyPortMissing());
    },
  });
}

/**
 * A service's directory when it sets no `relativeDir`: `<serviceRootDir>/<key>` (a trailing
 * slash on the root tolerated). Without a `serviceRootDir` there is nothing to infer from — the
 * types require `relativeDir` then, and this is the backstop for a config that bypassed them.
 */
function inferredRelativeDir(serviceRootDir: string | undefined, name: string): string {
  if (serviceRootDir === undefined) {
    throw new Error(
      `${name} has no \`relativeDir\`, and the config sets no \`serviceRootDir\` to infer it from. ` +
        `Set \`serviceRootDir\` (e.g. 'apps') at the top level, or \`relativeDir\` on ${name}.`,
    );
  }
  return `${serviceRootDir.replace(/\/+$/, '')}/${name}`;
}

/** A lowercase hostname: DNS labels of `[a-z0-9-]`, none starting or ending with a hyphen. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Resolves the `devReverseProxy` block: its `port`/`rootDomain` callbacks run once over the
 * workspace context, and a callback result that can't be used (`NaN`, an empty string) is an
 * error naming the field and the env files loaded, in the style of a service `port`.
 */
function resolveDevReverseProxy(
  block: NonNullable<z.infer<typeof DefineConfigSchema>['devReverseProxy']>,
  ctx: () => ConfigContext,
  envFilesLoaded: () => string[],
): ResolvedDevReverseProxy {
  const fail = (field: string, value: unknown): never => {
    throw new Error(
      `devReverseProxy.${field}: callback returned ${typeof value === 'string' ? JSON.stringify(value) : String(value)} (check the env vars it reads)\n  ${envFilesNote(envFilesLoaded())}`,
    );
  };
  const port = typeof block.port === 'function' ? block.port(ctx()) : block.port;
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    fail('port', port);
  }
  const isCallback = typeof block.rootDomain === 'function';
  const written: unknown =
    typeof block.rootDomain === 'function'
      ? block.rootDomain(ctx())
      : (block.rootDomain ?? 'localhost');
  const rootDomains = resolveRootDomains(written, isCallback, fail);
  const rootDomain = rootDomains[0]!;
  // The scheme follows the canonical root unless the config says: `localhost` has nothing in
  // front, so the browser hits the proxy itself over http; any other root has a TLS terminator
  // in front.
  const urlScheme = block.urlScheme ?? (rootDomain === 'localhost' ? 'http' : 'https');
  return { port, rootDomain, rootDomains, defaultService: block.defaultService, urlScheme };
}

/**
 * Checks a resolved `rootDomain` — a string, or an array of canonical-then-aliases — and returns
 * it as a non-empty list. A Host is routed by which entry it falls under, so the entries must
 * leave no doubt: none may equal another, or be another with labels in front (`a.example.test`
 * beside `example.test`, which would claim each other's hosts).
 */
function resolveRootDomains(
  value: unknown,
  isCallback: boolean,
  fail: (field: string, value: unknown) => never,
): string[] {
  if (typeof value === 'string' && value === '' && isCallback) {
    fail('rootDomain', value);
  }
  if (Array.isArray(value) && value.length === 0) {
    throw new Error(
      `devReverseProxy.rootDomain ${isCallback ? 'callback returned' : 'is'} an empty array — ` +
        'give at least one root domain (the first is the canonical one), or omit it for `localhost`',
    );
  }
  if (typeof value !== 'string' && !Array.isArray(value)) {
    fail('rootDomain', value);
  }
  const list: unknown[] = Array.isArray(value) ? value : [value];
  const field = (i: number) => (Array.isArray(value) ? `rootDomain[${String(i)}]` : 'rootDomain');
  list.forEach((entry, i) => {
    if (typeof entry !== 'string' || !HOSTNAME_RE.test(entry)) {
      throw new Error(
        `devReverseProxy.${field(i)} ${JSON.stringify(entry)} is not a lowercase hostname ` +
          '(labels of a-z, 0-9 and hyphens, not starting or ending with a hyphen)',
      );
    }
  });
  const domains = list as string[];
  domains.forEach((a, i) => {
    domains.forEach((b, j) => {
      if (i >= j) {
        return;
      }
      if (a === b) {
        throw new Error(
          `devReverseProxy.rootDomain lists "${a}" twice (entries ${String(i)} and ${String(j)}) — ` +
            'drop one of them',
        );
      }
      const [inner, outer] = a.endsWith(`.${b}`) ? [a, b] : b.endsWith(`.${a}`) ? [b, a] : [];
      if (inner !== undefined) {
        throw new Error(
          `devReverseProxy.rootDomain entries "${inner}" and "${outer!}" overlap: every host under ` +
            `"${inner}" is also under "${outer!}", so the proxy couldn't tell which one a request ` +
            'means. Drop one of them, or pick a root that is not under the other.',
        );
      }
    });
  });
  return domains;
}

/**
 * A public hostname as it appears in URLs: with the proxy's port under `http` (the browser hits
 * the proxy directly), bare under `https` (a TLS terminator on 443 in front).
 */
function publicHost(proxy: ResolvedDevReverseProxy, host: string): string {
  return proxy.urlScheme === 'http' ? `${host}:${String(proxy.port)}` : host;
}

/**
 * The origin a service's or service's public URLs start from, or `undefined` when the proxy
 * doesn't route it. That is its canonical subdomain when it declares one, else the bare root
 * domain when it is the `defaultService` — so a default service that also declares a subdomain
 * keeps the subdomain origin, with the bare root as one more route to it.
 */
function publicOriginOf(
  proxy: ResolvedDevReverseProxy | undefined,
  target: { port: number | undefined; proxy?: ResolvedProxy | undefined; isDefault?: boolean },
): string | undefined {
  if (!proxy || target.port === undefined) {
    return undefined;
  }
  const [canonical] = subdomainsOf(target);
  const host =
    canonical !== undefined
      ? `${canonical}.${proxy.rootDomain}`
      : target.isDefault
        ? proxy.rootDomain
        : undefined;
  return host === undefined ? undefined : `${proxy.urlScheme}://${publicHost(proxy, host)}`;
}

/** One infra service with the provider that runs it — what routing and validation iterate over. */
export interface InfraServiceEntry {
  provider: string;
  name: string;
  service: ResolvedInfraService;
}

/** Every service the config names, across every provider, in declaration order. */
export function infraServicesOf(config: Pick<Config<string>, 'infra'> | null): InfraServiceEntry[] {
  return Object.entries(config?.infra ?? {}).flatMap(([provider, block]) =>
    Object.entries(servicesOf<ResolvedInfraService>(block)).map(([name, service]) => ({
      provider,
      name,
      service,
    })),
  );
}

/**
 * A provider block's `services`, whichever provider it is — every provider keys its services
 * the same way, which is what lets `port` and `proxy` work for one with no code of its own.
 */
function servicesOf<S>(block: unknown): Record<string, S> {
  return (block as { services?: Record<string, S> } | undefined)?.services ?? {};
}

/**
 * Checks the proxy against the services and services it will route to. Every rule here is a
 * config bug the proxy would otherwise turn into a runtime surprise: a route to nowhere, or two
 * listeners on one port.
 */
function validateDevReverseProxy(
  proxy: ResolvedDevReverseProxy,
  packages: AnyServiceConfig[],
  services: InfraServiceEntry[],
) {
  if (proxy.defaultService !== undefined) {
    const target = packages.find((p) => p.name === proxy.defaultService);
    if (!target) {
      throw new Error(
        `devReverseProxy.defaultService "${proxy.defaultService}" names no declared service`,
      );
    }
    if (target.port === undefined) {
      throw new Error(
        `devReverseProxy.defaultService "${proxy.defaultService}" has no \`port\`, so the proxy ` +
          "can't route the bare root domain to it. Add `port` to it, or pick another service.",
      );
    }
  }
  for (const pkg of packages) {
    const [subdomain] = subdomainsOf(pkg);
    if (subdomain !== undefined && pkg.port === undefined) {
      throw new Error(
        `${pkg.name} declares subdomain "${subdomain}" but no \`port\`, so the dev reverse proxy ` +
          "can't route to it. Add `port` to it, or drop its `proxy`.",
      );
    }
    if (pkg.port === proxy.port) {
      throw new Error(
        `devReverseProxy.port ${String(proxy.port)} is also ${pkg.name}'s port — the proxy ` +
          "can't listen where a service does. Give one of them a different port.",
      );
    }
  }
  for (const { name, service } of services) {
    if (service.port === proxy.port) {
      throw new Error(
        `devReverseProxy.port ${String(proxy.port)} is also infra service "${name}"'s port — the ` +
          "proxy can't listen where a service does. Give one of them a different port.",
      );
    }
  }
}

/**
 * Checks the infra services' `port` and `proxy` on their own, with or without a dev reverse
 * proxy: a `proxy` needs a port to point at, and a service's port on the host is one nothing
 * else in the config may claim — a service listening there too would be shadowed by, or shadow,
 * the service's published port.
 */
function validateInfraServices(services: InfraServiceEntry[], packages: AnyServiceConfig[]) {
  const portOwners = new Map<number, string>();
  for (const pkg of packages) {
    if (pkg.port !== undefined) {
      portOwners.set(pkg.port, `the service ${pkg.name}`);
    }
  }
  for (const { name, service } of services) {
    // A disabled service's port is never resolved, so it has none to check — and claims none.
    if (!service.enabled) {
      continue;
    }
    const [subdomain] = subdomainsOf(service);
    if (subdomain !== undefined && service.port === undefined) {
      throw new Error(
        `infra service "${name}" declares subdomain "${subdomain}" but no \`port\`, so the dev ` +
          "reverse proxy can't route to it. Add `port` to it, or drop its `proxy`.",
      );
    }
    if (service.port === undefined) {
      continue;
    }
    const owner = portOwners.get(service.port);
    if (owner !== undefined) {
      throw new Error(
        `infra service "${name}" has port ${String(service.port)}, which is also ${owner}'s — ` +
          'two things cannot listen on one port. Give one of them a different port.',
      );
    }
    portOwners.set(service.port, `infra service "${name}"`);
  }
}

/**
 * Every hostname the dev reverse proxy routes to `pkg`, canonical subdomain first, then its
 * aliases, then the bare root domain when `pkg` is the `defaultService` (which needs no `proxy`).
 * Empty for a service the proxy doesn't route (no `port`, or neither a `proxy` nor the
 * `defaultService` slot), and when the config has no proxy at all.
 */
export function proxyHostsFor(
  config: Pick<Config<string>, 'devReverseProxy'> | null,
  pkg: Pick<AnyServiceConfig, 'name' | 'port' | 'proxy'>,
): string[] {
  const proxy = config?.devReverseProxy;
  if (!proxy || pkg.port === undefined) {
    return [];
  }
  const hosts = subdomainsOf(pkg).map((label) => `${label}.${proxy.rootDomain}`);
  if (proxy.defaultService === pkg.name) {
    hosts.push(proxy.rootDomain);
  }
  return hosts;
}

/**
 * Every hostname the dev reverse proxy routes to an infra service, canonical subdomain first,
 * then its aliases. Empty for a disabled service, one without `proxy` or `port`, and when the
 * config has no proxy. (The bare root domain is only ever a service's: `defaultService`.)
 */
export function serviceProxyHostsFor(
  config: Pick<Config<string>, 'devReverseProxy'> | null,
  service: Pick<ResolvedInfraService, 'enabled' | 'port' | 'proxy'>,
): string[] {
  const proxy = config?.devReverseProxy;
  if (!proxy || !service.enabled || service.port === undefined) {
    return [];
  }
  return subdomainsOf(service).map((label) => `${label}.${proxy.rootDomain}`);
}

/** Config keys that are spelled differently, with the spelling to use. */
const RENAMED_KEYS: {
  path: string;
  read: (opts: Record<string, unknown>) => unknown;
  use: string;
}[] = [
  { path: 'packages', read: (o) => o.packages, use: 'services' },
  { path: 'packageRootDir', read: (o) => o.packageRootDir, use: 'serviceRootDir' },
  {
    path: 'devReverseProxy.defaultPackage',
    read: (o) => (o.devReverseProxy as Record<string, unknown> | undefined)?.defaultPackage,
    use: 'devReverseProxy.defaultService',
  },
];

/** Rejects a key `RENAMED_KEYS` lists, naming its spelling — clearer than the schema's "unrecognized key". */
function rejectRenamedKeys(opts: unknown): void {
  if (typeof opts !== 'object' || opts === null) {
    return;
  }
  const used = RENAMED_KEYS.filter(
    (key) => key.read(opts as Record<string, unknown>) !== undefined,
  );
  if (used.length > 0) {
    throw new Error(
      used.map((key) => `\`${key.path}\` is spelled \`${key.use}\`: rename it.`).join('\n'),
    );
  }
}

export function defineConfig<
  const Top extends TokenRecord,
  P extends Record<string, unknown>,
  K extends string = Extract<keyof P, string>,
  RootDir extends string | undefined = undefined,
>(opts: DefineConfigOptions<Top, P, K, RootDir>): Config<K, P, Top> {
  rejectRenamedKeys(opts);
  const result = DefineConfigSchema.safeParse(opts);
  if (!result.success) {
    throw new Error(formatConfigError(result.error));
  }
  const parsed = result.data;

  const workspaceDir = parsed.workspaceDir ?? process.cwd();
  workspaceRoot = path.resolve(workspaceDir);

  // The key IS the service name. Everything downstream works on an array, so flatten here —
  // and settle `proxy.subdomain: true` into the name it stands for, so nothing downstream sees
  // `true`. (The top-level `subdomain` is only in the schema to be rejected; it's always absent.)
  const parsedPackages = Object.entries(parsed.services).map(
    ([name, { subdomain: _, ...config }]) => ({
      ...config,
      proxy: resolveProxy(config.proxy, { kind: 'package', name }),
      name,
    }),
  );

  // JavaScript enumerates integer-like keys first, in ascending numeric order, regardless of
  // where they were written — which would silently reorder startup and the TUI. Reject them
  // rather than surprise anyone with a service that jumps the queue.
  for (const { name } of parsedPackages) {
    if (/^(0|[1-9]\d*)$/.test(name)) {
      throw new Error(
        `service name "${name}" is a number — object keys that look like integers are reordered ` +
          'by JavaScript, which would change the order services start in. Use a non-numeric name.',
      );
    }
  }

  // `waitFor`/`deps` names are type-checked against the service keys, so a bad name is normally
  // a compile error. Re-checked here for configs that reach `defineConfig` unchecked (plain JS,
  // a `satisfies`-free dynamic build) and to enforce the healthcheck rule types can't express.
  const healthcheckPackages = new Set(parsedPackages.filter((c) => c.healthcheck).map((c) => c.name)); // oxfmt-ignore
  const allNames = new Set(parsedPackages.map((c) => c.name));
  for (const config of parsedPackages) {
    for (const waitName of config.waitFor ?? []) {
      if (!allNames.has(waitName)) {
        throw new Error(`${config.name} has waitFor "${waitName}" but no such service exists`);
      }
      if (!healthcheckPackages.has(waitName)) {
        throw new Error(
          `${config.name} has waitFor "${waitName}" but that service has no healthcheck defined`,
        );
      }
    }
    for (const [kind, names] of Object.entries(config.deps ?? {})) {
      for (const depName of names ?? []) {
        if (!allNames.has(depName)) {
          throw new Error(
            `${config.name} has deps.${kind} "${depName}" but no such service exists`,
          );
        }
      }
    }
  }

  // Every infra service's `proxy`, settled the same way, whichever provider runs it. Kept apart
  // from the rest of the service's resolution (below) because the subdomain check needs it now.
  const serviceProxies = Object.values(parsed.infra ?? {}).flatMap((block) =>
    Object.entries(servicesOf<ParsedInfraService>(block)).map(([name, service]) => ({
      name,
      proxy: resolveProxy(service.proxy, { kind: 'service', name }),
    })),
  );

  // A subdomain is a route for whatever reverse proxy reads the exported config, so two owners
  // claiming the same one (canonical or alias) — services and infra services alike — is an
  // ambiguous route: a config bug, not a tie to break silently. Checked whether or not a service
  // is enabled in this mode, so a clash can't hide until another mode runs.
  const subdomainOwners = new Map<string, string>();
  const claimSubdomains = (target: { proxy?: ResolvedProxy }, owner: string) => {
    for (const subdomain of subdomainsOf(target)) {
      const existing = subdomainOwners.get(subdomain);
      if (existing !== undefined && existing !== owner) {
        throw new Error(
          `${existing} and ${owner} both declare the subdomain "${subdomain}" — a reverse ` +
            'proxy could not tell them apart. Give one of them a different subdomain.',
        );
      }
      subdomainOwners.set(subdomain, owner);
    }
  };
  for (const config of parsedPackages) {
    claimSubdomains(config, config.name);
  }
  for (const service of serviceProxies) {
    claimSubdomains(service, ownerLabel({ kind: 'service', name: service.name }));
  }

  const tokens = parsed.tokens ?? {};

  const envFiles = envFileNames();
  const envOverride = parsed.env?.override;

  const baseEnv = () => baseEnvs(workspaceRoot);

  const loadEnv = (relativeDir: string, vars?: Record<string, string>) =>
    once(() =>
      resolveEnv({ cwd: workspaceDir, relativeDir, files: envFiles, override: envOverride, vars }),
    );

  // The config's own variables come first: every callback below finds them in its `envs`. Their
  // callback sees the workspace environment as it resolves without them.
  const workspaceFiles = loadEnv('.');
  const envVars = resolveEnvVars(
    parsed.env?.vars,
    () => ({ envs: Object.assign(baseEnv(), workspaceFiles().env), tokens }),
    () => workspaceFiles().files,
  );

  /**
   * The environment a callback sees: a scope's `.env` files, with the config's own variables
   * ranked as a file below them, merged over `process.env`.
   */
  const envsFor = (relativeDir: string) => {
    const load = loadEnv(relativeDir, envVars);
    return {
      envs: once(() => Object.assign(baseEnv(), load().env)),
      files: () => load().files,
    };
  };

  // Workspace-wide urls belong to no service: workspace-scope env, no `port` to offer, and no
  // `subdomain` either (plain `undefined`, as for a service without one).
  const workspaceEnv = envsFor('.');
  const workspaceBase = once((): ConfigContext => ({ envs: workspaceEnv.envs(), tokens }));

  // The dev reverse proxy sees the workspace context, like the workspace-wide urls. Resolved
  // before the services, since a service's public origin — what its path urls are based on —
  // depends on it; validated after them, since that needs their *resolved* ports.
  const devReverseProxy =
    parsed.devReverseProxy &&
    resolveDevReverseProxy(parsed.devReverseProxy, workspaceBase, workspaceEnv.files);

  const packages = parsedPackages.map((config) => {
    const relativeDir = config.relativeDir ?? inferredRelativeDir(parsed.serviceRootDir, config.name); // oxfmt-ignore
    const env = envsFor(relativeDir);
    // The service's own tokens win over the config's, so a service can override a shared value.
    const pkgTokens = config.tokens ? { ...tokens, ...config.tokens } : tokens;
    const baseCtx = once((): ConfigContext => ({ envs: env.envs(), tokens: pkgTokens }));
    // Resolved first so the `healthcheck`/`urls` callbacks below can read it, and stored on the
    // resolved service so nothing downstream ever encounters a callback.
    const port = resolvePort(config, baseCtx, env.files);
    const ctx = once((): ServiceContext =>
      packageContext(
        baseCtx(),
        port,
        // The canonical subdomain is the first one declared; aliases are for the proxy alone.
        subdomainsOf(config)[0],
        () =>
          `${config.name}: a callback read \`port\`, but this service declares no \`port\`. ` +
          `Add \`port\` to ${config.name} in devtooie.config.ts, or drop \`port\` from the callback.`,
      ),
    );
    // What this service's relative URLs resolve against: its port on loopback, and — when the
    // dev reverse proxy routes it — its public origin. `urls` show the public form, the
    // `healthcheck` probes the private one (see `ResolvedUrlForms`).
    const publicOrigin = publicOriginOf(devReverseProxy, {
      port,
      proxy: config.proxy,
      isDefault: devReverseProxy?.defaultService === config.name,
    });
    const scope = (where: string): UrlScope => ({ ctx, port, publicOrigin, where });
    return {
      ...config,
      // Stored resolved (config tokens + this service's own) so the exported config exposes
      // each service's tokens: `config.services.api.tokens`.
      tokens: pkgTokens,
      port,
      relativeDir,
      absoluteDir: path.resolve(workspaceDir, relativeDir),
      urls: config.urls?.map((entry) => resolveUrlEntry(entry, scope(`${config.name} urls`))),
      healthcheck:
        config.healthcheck === undefined
          ? undefined
          : resolveHealthcheck(config.healthcheck, scope(`${config.name} healthcheck`)),
      // The same value the service's process gets as `PUBLIC_ORIGIN`, on the exported config.
      publicOrigin,
    };
  });

  const workspaceCtx = once((): ServiceContext =>
    packageContext(
      workspaceBase(),
      undefined,
      undefined,
      () =>
        'a workspace-wide `urls` callback read `port`, but those links belong to no service, so ' +
        "there's no port to give them. Move the link into a service's `urls`, or drop `port`.",
    ),
  );
  const urls = parsed.urls?.map((entry) =>
    resolveUrlEntry(entry, {
      ctx: workspaceCtx,
      port: undefined,
      publicOrigin: undefined,
      where: 'top-level url',
    }),
  );

  // The project name and each service's `enabled`, `port` and `proxy` are settled here, from the
  // workspace environment; the callbacks stay as written, to run when an `infra` command does.
  const resolveServices = (services: Record<string, ParsedInfraService> | undefined) =>
    Object.fromEntries(
      Object.entries(services ?? {}).map(([name, service]) => [
        name,
        resolveInfraService(name, service, {
          proxy: serviceProxies.find((s) => s.name === name)?.proxy,
          devReverseProxy,
          ctx: workspaceBase,
          enabledCtx: () => ({ mode: currentMode(), ...workspaceBase() }),
          envFilesLoaded: workspaceEnv.files,
        }),
      ]),
    );
  const compose = parsed.infra?.['docker-compose'];
  const infra: ResolvedInfra | undefined = compose && {
    'docker-compose': {
      file: compose.file === undefined ? undefined : path.resolve(workspaceDir, compose.file),
      projectName: composeProjectName({
        envs: workspaceEnv.envs(),
        workspaceDir,
        mode: currentMode(),
      }),
      readyTimeout: compose.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS,
      services: resolveServices(compose.services),
    },
  };

  // Now that every service's and service's port is known, check them against each other and the
  // proxy against them all. (devtooie adds no footer link of its own: `urls` holds exactly what
  // the config lists — `'/'` or `''` there is how a service shows its public origin.)
  const services = infraServicesOf({ infra });
  validateInfraServices(services, packages);
  if (devReverseProxy) {
    validateDevReverseProxy(devReverseProxy, packages, services);
  }

  const resolved: Config<string> = {
    apiPort: parsed.apiPort,
    serviceRootDir: parsed.serviceRootDir,
    // Back to a record, keyed by name, preserving the declaration order of the keys.
    services: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg])),
    urls,
    devReverseProxy,
    infra,
    envFiles,
    envMode: currentMode(),
    envOverride,
    envVars,
    logTimestamps: parsed.logs?.timestamps ?? true,
  };
  registeredPackages = packages;
  loadedConfig = resolved;
  loadedTokens = tokens;
  // The runtime shape is identical; only the key/token types are sharper for the caller.
  return resolved as unknown as Config<K, P, Top>;
}

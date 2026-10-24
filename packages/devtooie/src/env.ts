import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AnyServiceConfig } from './config.js';
import { findPassthrough } from './infra/argv.js';

/** The mode used when neither `--mode` nor `DEVTOOIE_MODE` says otherwise. */
export const DEFAULT_MODE = 'development';

/**
 * A mode name, as a callback receives it. Any name is a valid mode — `--mode staging` loads
 * `.env.staging` — so this is every string; the two literals are there so an editor offers the
 * usual ones, `development` (the default) and `test`. `string & {}` is what keeps them from being
 * absorbed into plain `string`.
 */
export type Mode = typeof DEFAULT_MODE | 'test' | (string & {});

/**
 * The active mode. Set once at CLI startup (`resolveMode` writes `DEVTOOIE_MODE` before the
 * config is loaded) and read from the environment thereafter, so config callbacks and spawned
 * children agree on it without threading a parameter through every call site.
 */
export function currentMode(): Mode {
  return process.env.DEVTOOIE_MODE || DEFAULT_MODE;
}

/**
 * Rejects a mode name that couldn't safely become part of a filename. A mode is interpolated
 * straight into `.env.<mode>`, so `--mode ../../etc` must be an error rather than a path
 * traversal. Dots *within* a name stay legal — `--mode e2e.ci` resolves `.env.e2e.ci`.
 */
export function assertValidMode(mode: string): string {
  if (!mode || mode === '.' || mode === '..' || /[/\\]/.test(mode)) {
    throw new Error(
      `invalid --mode ${JSON.stringify(mode)}: a mode name can't be empty, "." or "..", or contain a path separator`,
    );
  }
  return mode;
}

/**
 * The mode for this invocation, read from raw argv before Commander parses anything — the config
 * is loaded (and its `port`/`urls` callbacks resolve env) earlier than that.
 *
 * **Stops at the first bare `--`.** Everything after it belongs to the command being run:
 * `devtooie exec -- vitest --mode watch` passes `--mode watch` to vitest, and must not silently
 * load `.env.watch` here.
 *
 * **And at an `infra <provider>` passthrough**, for the same reason:
 * `devtooie infra docker-compose build -m 2g` hands `-m 2g` to Compose.
 */
export function resolveMode(argv: readonly string[]): string {
  const passthrough = findPassthrough(argv);
  const end = passthrough === -1 ? argv.indexOf('--') : passthrough;
  const args = end === -1 ? argv : argv.slice(0, end);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--mode' || arg === '-m') {
      return assertValidMode(args[i + 1] ?? '');
    }
    if (arg.startsWith('--mode=')) {
      return assertValidMode(arg.slice('--mode='.length));
    }
  }
  return assertValidMode(process.env.DEVTOOIE_MODE || DEFAULT_MODE);
}

/**
 * The `.env` filenames for a mode, in ascending precedence *within a scope*: a base `.env`, the
 * developer's `.env.local`, then the mode's `.env.<mode>` and `.env.<mode>.local`. This is Vite's
 * order — a mode file outranks `.env.local`.
 *
 * Modes are exclusive: `--mode test` loads `.env.test`, never `.env.development`. Values shared
 * across modes belong in `.env` / `.env.local`, which load in every mode.
 */
export function envFileNames(mode: string = currentMode()): string[] {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
}

/** Variables whose file value may beat the ambient environment; `true` means all of them. */
export type EnvOverride = boolean | string[];

export interface EnvResolution {
  /**
   * Variables defined by the resolved files, already `${VAR}`-expanded and with the ambient
   * environment's precedence already applied. Does NOT include the rest of `process.env` — merge
   * yourself with `Object.assign({}, process.env, env)`.
   */
  env: Record<string, string>;
  /** Candidate paths that exist and were loaded, ascending precedence. */
  files: string[];
  /** Every candidate path (whether or not it exists), ascending precedence. */
  candidates: string[];
  /**
   * The names the service's own files assign, as against the workspace's. When `relativeDir`
   * is the workspace root the one scope is the service's, so this is every file's names.
   */
  packageNames: Set<string>;
}

interface ResolveEnvOptions {
  /** Workspace root. */
  cwd: string;
  /** Service directory relative to `cwd`; `'.'` collapses service scope onto the workspace. */
  relativeDir: string;
  /** Filenames to look for at each scope (defaults to the active mode's {@link envFileNames}). */
  files?: string[];
  /** Variables the files may override the ambient environment for. */
  override?: EnvOverride;
  /**
   * The config's own variables (`env.vars`, resolved). They rank as a file read before every
   * real one, under the same rules: any file replaces them, the ambient environment wins over
   * them unless `override` says otherwise, and a file's `${VAR}` can reference them.
   */
  vars?: Record<string, string>;
  /**
   * The ambient environment to resolve against. Defaults to the one devtooie was started with
   * (see {@link captureShellEnv}), or the live `process.env` when none was recorded.
   */
  ambient?: Record<string, string>;
}

/**
 * Every candidate `.env` path, ascending precedence: all workspace-scope files (in
 * `files` order), then all service-scope files (in `files` order). Service scope always
 * outranks workspace scope. When `relativeDir` resolves to `cwd`, the two scopes collapse
 * into one.
 */
export function envCandidatePaths({
  cwd,
  relativeDir,
  files = envFileNames(),
}: Omit<ResolveEnvOptions, 'override' | 'ambient'>): string[] {
  const workspaceDir = path.resolve(cwd);
  const pkgDir = path.resolve(cwd, relativeDir);
  const scopes = pkgDir === workspaceDir ? [workspaceDir] : [workspaceDir, pkgDir];
  return scopes.flatMap((scope) => files.map((f) => path.join(scope, f)));
}

/** The variables devtooie sets itself, for the config's callbacks and every process it starts. */
export interface DevtooieEnv {
  /** The active mode: `development` unless `--mode` (or `DEVTOOIE_MODE`) says otherwise. */
  DEVTOOIE_MODE: Mode;
  /** The directory devtooie was invoked in: the workspace root, or wherever below it. */
  DEVTOOIE_CWD: string;
  /** The workspace root — the directory holding `devtooie.config.ts`. */
  DEVTOOIE_WORKSPACE_DIR: string;
}

/**
 * The environment a callback receives as `envs`. Any name can be read from it; the variables
 * devtooie sets are spelled out so an editor offers them, and they are always there.
 */
export type Envs = DevtooieEnv & Record<string, string>;

/**
 * The ambient environment as a callback's `envs` starts from: with the variables the devtooie
 * CLI publishes filled in for a process it didn't start — a script importing the config, say.
 */
export function baseEnvs(workspaceDir: string): Envs {
  const fallback: DevtooieEnv = {
    DEVTOOIE_MODE: currentMode(),
    DEVTOOIE_CWD: process.cwd(),
    DEVTOOIE_WORKSPACE_DIR: workspaceDir,
  };
  return Object.assign(fallback, ambientEnv());
}

/**
 * A snapshot of `process.env` with `undefined`-valued keys dropped, so it can be used as a
 * plain string map. Used as the base layer a service's env files are merged over, and (after
 * {@link hideDollars}) as the `${VAR}`-expansion source in {@link resolveEnv}.
 */
export function ambientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Names, comma-separated, the variables devtooie gave a child that the shell devtooie was started
 * in didn't — the `.env` values, the config's own variables, `PORT`. A devtooie started from such a
 * child (an e2e suite that `devtooie run` started, say) drops them first, so they don't count as
 * its ambient environment and beat its own `.env` files. `DEVTOOIE_MODE` is never listed: a
 * nested devtooie keeps the mode it was started in.
 */
export const INJECTED_ENV_VAR = 'DEVTOOIE_INJECTED_ENV';

/**
 * Drops what an outer devtooie listed in {@link INJECTED_ENV_VAR}, and the list itself. The CLI
 * calls it first, before anything reads the environment.
 */
export function dropInjectedEnv(env: NodeJS.ProcessEnv = process.env): void {
  const list = env[INJECTED_ENV_VAR];
  if (list === undefined) {
    return;
  }
  for (const key of list.split(',')) {
    if (key !== '' && key !== 'DEVTOOIE_MODE') {
      delete env[key];
    }
  }
  delete env[INJECTED_ENV_VAR];
}

/**
 * `layer` with {@link INJECTED_ENV_VAR} added: every variable of the child's environment — this
 * process's own, with `layer` merged over it — that the shell devtooie was started in didn't
 * set, or set to another value.
 */
function withInjectedList(layer: Record<string, string>): Record<string, string> {
  const shell = shellEnv ?? ambientEnv();
  const child: NodeJS.ProcessEnv = { ...process.env, ...layer };
  const injected = Object.keys(child)
    .filter(
      (key) =>
        key !== INJECTED_ENV_VAR &&
        key !== 'DEVTOOIE_MODE' &&
        child[key] !== undefined &&
        child[key] !== shell[key],
    )
    .sort();
  return { ...layer, [INJECTED_ENV_VAR]: injected.join(',') };
}

/** The environment devtooie was started with, once {@link captureShellEnv} has recorded it. */
let shellEnv: Record<string, string> | undefined;

/**
 * Records the environment as it stands — the one devtooie was started with — as the **ambient
 * environment** every later {@link resolveEnv} resolves against.
 *
 * The CLI calls this once, before it merges the workspace's `.env` files into its own
 * `process.env`. From then on `process.env` holds file values next to the shell's, and nothing
 * in it says which is which — but only a variable the shell set is entitled to win over a file.
 * A workspace file's value that counted as ambient would beat the service file meant to
 * override it, and would keep beating the workspace file itself after an edit.
 */
export function captureShellEnv(): void {
  shellEnv = ambientEnv();
}

/**
 * The environment devtooie was started with ({@link captureShellEnv}), or this process's own
 * when it wasn't recorded — what a devtooie this one starts should get as its own, without the
 * `.env` values this process has merged into `process.env` since.
 */
export function shellEnvironment(): Record<string, string> {
  return { ...(shellEnv ?? ambientEnv()) };
}

/**
 * A token to stand in for `$`, found in none of `texts` — so swapping it back afterwards can
 * only ever bring back a `$` that {@link hideDollars} hid.
 */
function dollarStandIn(texts: string[]): string {
  for (let n = 0; ; n++) {
    // Private-use delimiters around a counter: no occurrence can straddle two of them.
    const standIn = `\uE000${String(n)}\uE001`;
    if (!texts.some((text) => text.includes(standIn))) {
      return standIn;
    }
  }
}

/**
 * Hides every `$` in values that are *already final* — the ambient environment's, the config's
 * own variables — behind `standIn`, for use as dotenvx's `processEnv`.
 *
 * Such a value is data, not a template, but dotenvx scans whatever it substitutes for further
 * references, and it keeps doing so as later lines build on the result. That causes failures
 * this prevents structurally (dotenvx never sees a `$` it didn't read from a file, at any depth
 * of reference, so there is nothing to scan):
 *
 * - **A hang.** An ambient `NODE_OPTIONS` that itself contains a literal `${NODE_OPTIONS}`, plus a
 *   file line `NODE_OPTIONS="${NODE_OPTIONS} --flag"`, is a cycle: substitute, re-scan, find the
 *   reference again, forever — with no error and no output.
 * - **Silent mangling.** Ambient `GREETING=hello$world` with a file line `MSG="${GREETING}!"`
 *   resolved to `hello`, because `$world` was treated as a reference and expanded to nothing.
 * - **A command run.** A `$(command)` in such a value is text, not a substitution to perform.
 *
 * {@link ambientEnv} keeps returning real values — hidden ones must never reach the `envs` a
 * config callback sees; {@link resolveEnv} swaps the `$` back into everything it returns.
 *
 * Exported for tests only (not re-exported from `index.ts`). The invariant it guarantees — no
 * `$` survives — is what the regression test asserts directly, because the failure it prevents
 * is a *synchronous* infinite loop: a test that merely calls `resolveEnv` would hang the runner
 * rather than fail, since no timeout can interrupt a blocked event loop.
 */
export function hideDollars(
  values: Record<string, string>,
  standIn: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value.replaceAll('$', standIn);
  }
  return out;
}

let primitives: typeof import('@dotenvx/primitives').default | undefined;

/**
 * dotenvx's parser, loaded when the first source is parsed rather than with this module: a
 * command that resolves no environment — `--help`, `logs` — doesn't pay for it.
 */
function dotenvxPrimitives(): typeof import('@dotenvx/primitives').default {
  primitives ??= createRequire(import.meta.url)('@dotenvx/primitives') as NonNullable<
    typeof primitives
  >;
  return primitives;
}

/** A name a `.env` line can carry: what dotenv's line grammar accepts on the left of `=`. */
export const ENV_NAME_RE = /^[\w.-]+$/;

/**
 * dotenv's line grammar, as dotenvx reads it. A quoted value may span lines, and a line inside
 * one assigns nothing — which is why this is the grammar and not a search for `NAME=`.
 */
const ENV_LINE_RE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * The names a `.env` source assigns, without resolving any value — dotenvx offers no parse
 * that doesn't also expand references and run `$(command)` substitutions.
 */
export function assignedNames(source: string): Set<string> {
  const lines = source.replace(/\r\n?/g, '\n').matchAll(ENV_LINE_RE);
  return new Set(Array.from(lines, (line) => line[1] ?? ''));
}

/**
 * Variables as the source of a `.env` file, so they resolve by the very rules a file's do: a
 * later line replaces them, and a later line's `${VAR}` references them.
 *
 * Each line assigns the variable from a placeholder that holds its value — `placeholders`, for
 * the environment the source is expanded against — so nothing in the value has to survive
 * dotenv's own syntax: quotes, newlines, a `#`.
 */
function asEnvSource(
  vars: Record<string, string>,
  placeholderPrefix: string,
): { source: string; placeholders: Record<string, string> } {
  const placeholders: Record<string, string> = {};
  const lines = Object.entries(vars).map(([name, value], i) => {
    const placeholder = `${placeholderPrefix}${String(i)}`;
    placeholders[placeholder] = value;
    return `${name}=\${${placeholder}}`;
  });
  return { source: lines.join('\n'), placeholders };
}

/**
 * Resolves the `.env` files for a service into a flat, expanded variable map without touching
 * `process.env`. Only files that exist are loaded; a later file (or a service-scope file)
 * overrides an earlier one, and every file overrides the config's own `vars`.
 *
 * The **ambient environment wins** over the files — matching Next.js, Vite, dotenv-flow and
 * `node --env-file`, so `FOO=bar devtooie` overrides a file for one run. `override` names the
 * exceptions: variables whose file value is allowed to win instead (or `true` for all of them).
 * Ambient means what devtooie was started with: a variable only the files define is never
 * ambient, so its highest-ranked file wins whatever `override` says.
 *
 * A `${VAR}` reference expands to the value that wins: the ambient one, or for an overridden
 * variable whatever the lines read so far have made of it — which starts as the ambient value,
 * so `NODE_OPTIONS=$NODE_OPTIONS --flag` extends it.
 */
export function resolveEnv(opts: ResolveEnvOptions): EnvResolution {
  const candidates = envCandidatePaths(opts);
  const files = candidates.filter((p) => fs.existsSync(p));

  const ambient = opts.ambient ?? shellEnv ?? ambientEnv();
  const vars = opts.vars ?? {};
  const texts = files.map((p) => fs.readFileSync(p, 'utf8'));
  const pkgDir = path.resolve(opts.cwd, opts.relativeDir);
  const packageNames = assignedNames(
    texts.filter((_text, i) => path.dirname(files[i] ?? '') === pkgDir).join('\n'),
  );
  if (Object.keys(vars).length === 0 && !texts.join('').trim()) {
    return { env: {}, files, candidates, packageNames };
  }

  // An ambient variable the files may override stops being ambient for this resolution: it
  // becomes the first line read, ahead of the config's own variables and every file. So the
  // lines that assign it win, each one's reference to it sees what the lines before left —
  // the ambient value, for the first — and every later reference sees the result. The rest of
  // the ambient environment wins as ever, for the variable itself and for references to it.
  const { override } = opts;
  const assigned = new Set([...Object.keys(vars), ...assignedNames(texts.join('\n'))]);
  const isOverridden = (key: string) =>
    assigned.has(key) && (override === true || (Array.isArray(override) && override.includes(key)));
  const winning: Record<string, string> = {};
  const overridable: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    (isOverridden(key) ? overridable : winning)[key] = value;
  }

  const fromAmbient = asEnvSource(overridable, '__DEVTOOIE_AMBIENT_');
  const fromVars = asEnvSource(vars, '__DEVTOOIE_VAR_');
  const final = { ...winning, ...fromAmbient.placeholders, ...fromVars.placeholders };
  const standIn = dollarStandIn([...Object.values(final), ...texts]);
  // dotenvx's parser, taken from the service it lives in: `@dotenvx/dotenvx` wraps the same
  // call in a CLI's worth of tooling, which costs every command its load time. It reads from
  // `processEnv` for `$VAR` lookups but writes to neither it nor the real process.env, so
  // nothing is mutated.
  const { parsed, errors } = dotenvxPrimitives().parseSync(
    [fromAmbient.source, fromVars.source, ...texts].join('\n'),
    { processEnv: hideDollars(final, standIn), overload: false },
  );
  // An encrypted value with no key to decrypt it stays as it is; say which, as dotenvx does.
  for (const error of errors) {
    console.error(error.message);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    env[key] = value.replaceAll(standIn, '$');
  }
  return { env, files, candidates, packageNames };
}

/** What an environment layer is built from; see {@link packageEnvLayer}. */
interface EnvLayerOptions {
  /** Workspace root. */
  cwd: string;
  /** Filenames to look for at each scope (defaults to the active mode's {@link envFileNames}). */
  files?: string[];
  /** Variables the files may override the ambient environment for. */
  override?: EnvOverride;
  /** The config's own variables (`env.vars`, resolved); see {@link ResolveEnvOptions.vars}. */
  vars?: Record<string, string>;
}

/**
 * The environment layer for a service's child process: the config's own variables and its
 * `.env` files, resolved together, with the service's configured `port` as `PORT` and, under
 * the dev reverse proxy, its public origin as `PUBLIC_ORIGIN`. Those two are the service's own,
 * so they win over a value set workspace-wide — by the config's variables or a workspace `.env`
 * file — and only a file of the service's own replaces them. Excludes `process.env` — merge
 * this over it at spawn time (`Object.assign({}, process.env, layer)`). Shared by the TUI/plain
 * session and `devtooie exec` so both build the same env.
 */
export function packageEnvLayer(
  pkg: AnyServiceConfig,
  opts: EnvLayerOptions,
): Record<string, string> {
  const { env, packageNames } = resolveEnv({ ...opts, relativeDir: pkg.relativeDir });
  const injected: Record<string, string> = {};
  if (pkg.port !== undefined) {
    injected.PORT = String(pkg.port);
  }
  if (pkg.publicOrigin !== undefined) {
    injected.PUBLIC_ORIGIN = pkg.publicOrigin;
  }
  for (const [name, value] of Object.entries(injected)) {
    if (!packageNames.has(name)) {
      env[name] = value;
    }
  }
  return withInjectedList(env);
}

/**
 * The environment layer for what belongs to no service — infra, and `devtooie exec` / `run`
 * outside every service: the config's own variables and the workspace-scope `.env` files,
 * resolved together. Excludes `process.env`, like {@link packageEnvLayer}.
 */
export function workspaceEnvLayer(opts: EnvLayerOptions): Record<string, string> {
  return withInjectedList(resolveEnv({ ...opts, relativeDir: '.' }).env);
}

import fs from 'node:fs';
import path from 'node:path';
import dotenvx from '@dotenvx/dotenvx';
import type { AnyPackageConfig } from './config.js';
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
   * The names the package's own files assign, as against the workspace's. When `relativeDir`
   * is the workspace root the one scope is the package's, so this is every file's names.
   */
  packageNames: Set<string>;
}

interface ResolveEnvOptions {
  /** Workspace root. */
  cwd: string;
  /** Package directory relative to `cwd`; `'.'` collapses package scope onto the workspace. */
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
 * `files` order), then all package-scope files (in `files` order). Package scope always
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
 * plain string map. Used as the base layer a package's env files are merged over, and (after
 * {@link literalizeForExpansion}) as the `${VAR}`-expansion source in {@link resolveEnv}.
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

/** The environment devtooie was started with, once {@link captureShellEnv} has recorded it. */
let shellEnv: Record<string, string> | undefined;

/**
 * Records the environment as it stands — the one devtooie was started with — as the **ambient
 * environment** every later {@link resolveEnv} resolves against.
 *
 * The CLI calls this once, before it merges the workspace's `.env` files into its own
 * `process.env`. From then on `process.env` holds file values next to the shell's, and nothing
 * in it says which is which — but only a variable the shell set is entitled to win over a file.
 * A workspace file's value that counted as ambient would beat the package file meant to
 * override it, and would keep beating the workspace file itself after an edit.
 */
export function captureShellEnv(): void {
  shellEnv = ambientEnv();
}

/** Escapes `$` so dotenvx substitutes a value without scanning it for references. */
const escapeDollars = (value: string) => value.replaceAll('$', '\\$');

/**
 * Makes ambient values inert to `${VAR}` expansion by escaping the metacharacter.
 *
 * A value that came from the environment is *already final* — it is data, not a template — but
 * dotenvx re-scans substituted content for further references. That causes two failures, both of
 * which this prevents structurally (after escaping there is no unescaped `$` in any substituted
 * text, so a second expansion round cannot exist):
 *
 * - **A hang.** An ambient `NODE_OPTIONS` that itself contains a literal `${NODE_OPTIONS}`, plus a
 *   file line `NODE_OPTIONS="${NODE_OPTIONS} --flag"`, is a cycle: substitute, re-scan, find the
 *   reference again, forever — with no error and no output.
 * - **Silent mangling.** Ambient `GREETING=hello$world` with a file line `MSG="${GREETING}!"`
 *   resolved to `hello`, because `$world` was treated as a reference and expanded to nothing.
 *
 * Only for use as dotenvx's `processEnv`. {@link ambientEnv} keeps returning real values — escaped
 * ones must never reach the `envs` a config callback sees.
 *
 * Exported for tests only (not re-exported from `index.ts`). The invariant it guarantees — no
 * unescaped `$` survives — is what the regression test asserts directly, because the failure it
 * prevents is a *synchronous* infinite loop: a test that merely calls `resolveEnv` would hang the
 * runner rather than fail, since no timeout can interrupt a blocked event loop.
 */
export function literalizeForExpansion(ambient: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    out[key] = escapeDollars(value);
  }
  return out;
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
 * The config's own variables as the source of a `.env` file, so they resolve by the very rules
 * a file's do.
 *
 * A value is written single-quoted, which dotenvx takes literally: no `${VAR}` expansion, no
 * `$(command)` substitution, and still literal when a later line references the variable.
 *
 * A value that itself contains a single quote can't be written that way, so its line references
 * a placeholder holding it — `placeholders`, for the environment the source is expanded
 * against. The placeholder's value is escaped twice: once for its own substitution, and once
 * more so the variable stays inert when a later line references *it*. That leaves the variable
 * itself one escape short of its value, which `restore` undoes after the parse.
 */
function varsAsEnvSource(vars: Record<string, string>): {
  source: string;
  placeholders: Record<string, string>;
  restore: (env: Record<string, string>) => void;
} {
  const placeholders: Record<string, string> = {};
  const indirect: [name: string, value: string][] = [];
  const lines = Object.entries(vars).map(([name, value]) => {
    if (!value.includes("'")) {
      return `${name}='${value}'`;
    }
    const placeholder = `__DEVTOOIE_VAR_${String(indirect.length)}`;
    placeholders[placeholder] = escapeDollars(escapeDollars(value));
    indirect.push([name, value]);
    return `${name}=\${${placeholder}}`;
  });
  return {
    source: lines.join('\n'),
    placeholders,
    restore: (env) => {
      for (const [name, value] of indirect) {
        // Still the variable's own value — not the ambient environment's, nor a file's.
        if (env[name] === escapeDollars(value)) {
          env[name] = value;
        }
      }
    },
  };
}

/**
 * Resolves the `.env` files for a package into a flat, expanded variable map without touching
 * `process.env`. Only files that exist are loaded; a later file (or a package-scope file)
 * overrides an earlier one, and every file overrides the config's own `vars`.
 *
 * The **ambient environment wins** over the files — matching Next.js, Vite, dotenv-flow and
 * `node --env-file`, so `FOO=bar devtooie` overrides a file for one run. `override` names the
 * exceptions: variables whose file value is allowed to win instead (or `true` for all of them).
 * Ambient means what devtooie was started with: a variable only the files define is never
 * ambient, so its highest-ranked file wins whatever `override` says.
 */
export function resolveEnv(opts: ResolveEnvOptions): EnvResolution {
  const candidates = envCandidatePaths(opts);
  const files = candidates.filter((p) => fs.existsSync(p));

  const ambient = opts.ambient ?? shellEnv ?? ambientEnv();
  const fromVars = varsAsEnvSource(opts.vars ?? {});
  const texts = files.map((p) => fs.readFileSync(p, 'utf8'));
  const source = [fromVars.source, ...texts].join('\n');
  const pkgDir = path.resolve(opts.cwd, opts.relativeDir);
  const packageNames = assignedNames(
    texts.filter((_text, i) => path.dirname(files[i] ?? '') === pkgDir).join('\n'),
  );
  if (!source.trim()) {
    return { env: {}, files, candidates, packageNames };
  }

  const { override } = opts;
  const overridesAll = override === true;
  const overridden = new Set(Array.isArray(override) ? override : []);
  const isOverridden = (key: string) => overridesAll || overridden.has(key);
  const hasOverrides = overridesAll || overridden.size > 0;

  // dotenvx reads from this snapshot for `$VAR` lookups but writes to neither it nor the real
  // process.env, so nothing is mutated.
  const lit = { ...fromVars.placeholders, ...literalizeForExpansion(ambient) };

  // Ambient wins for every key, and `${VAR}` expands against ambient — so a file's `BAZ=$FOO`
  // sees the ambient FOO rather than a file FOO that lost.
  const env = dotenvx.parse(source, { processEnv: lit, overload: false });

  // For a key the ambient won, dotenvx hands back the value it was *given* — the escaped copy.
  // Put the real one back, or an ambient value containing `$` comes out carrying a literal
  // backslash (`--require /b.js \${NODE_OPTIONS}`). Only ambient values with a `$` are affected,
  // which is exactly the NODE_OPTIONS case `override` exists to serve.
  for (const key of Object.keys(env)) {
    const value = ambient[key];
    if (value !== undefined && !isOverridden(key)) {
      env[key] = value;
    }
  }

  // The overrides, with the precedence inverted. This is what lets the self-append pattern
  // `NODE_OPTIONS=$NODE_OPTIONS --flag` extend the ambient value instead of losing to it —
  // `$NODE_OPTIONS` still expands from ambient, and the result is then allowed to win. Values
  // from this pass need no repair: when a file value wins, dotenvx unescapes `\$` back to `$`.
  if (hasOverrides) {
    const forced = dotenvx.parse(source, { processEnv: lit, overload: true });
    for (const [key, value] of Object.entries(forced)) {
      if (isOverridden(key)) {
        env[key] = value;
      }
    }
  }

  fromVars.restore(env);
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
 * The environment layer for a package's child process: the config's own variables and its
 * `.env` files, resolved together, with the package's configured `port` as `PORT` and, under
 * the dev reverse proxy, its public origin as `PUBLIC_ORIGIN`. Those two are the package's own,
 * so they win over a value set workspace-wide — by the config's variables or a workspace `.env`
 * file — and only a file of the package's own replaces them. Excludes `process.env` — merge
 * this over it at spawn time (`Object.assign({}, process.env, layer)`). Shared by the TUI/plain
 * session and `devtooie exec` so both build the same env.
 */
export function packageEnvLayer(
  pkg: AnyPackageConfig,
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
  return env;
}

/**
 * The environment layer for what belongs to no package — infra, and `devtooie exec` / `run`
 * outside every package: the config's own variables and the workspace-scope `.env` files,
 * resolved together. Excludes `process.env`, like {@link packageEnvLayer}.
 */
export function workspaceEnvLayer(opts: EnvLayerOptions): Record<string, string> {
  return resolveEnv({ ...opts, relativeDir: '.' }).env;
}

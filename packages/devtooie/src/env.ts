import fs from 'node:fs';
import path from 'node:path';
import dotenvx from '@dotenvx/dotenvx';
import type { AnyPackageConfig } from './config.js';

/** The mode used when neither `--mode` nor `DEVTOOIE_MODE` says otherwise. */
export const DEFAULT_MODE = 'development';

/**
 * The active mode. Set once at CLI startup (`resolveMode` writes `DEVTOOIE_MODE` before the
 * config is loaded) and read from the environment thereafter, so config callbacks and spawned
 * children agree on it without threading a parameter through every call site.
 */
export function currentMode(): string {
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
 * `devtooie cmd -- vitest --mode watch` passes `--mode watch` to vitest, and must not silently
 * load `.env.watch` here.
 */
export function resolveMode(argv: readonly string[]): string {
  const end = argv.indexOf('--');
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
}: Omit<ResolveEnvOptions, 'override'>): string[] {
  const workspaceDir = path.resolve(cwd);
  const pkgDir = path.resolve(cwd, relativeDir);
  const scopes = pkgDir === workspaceDir ? [workspaceDir] : [workspaceDir, pkgDir];
  return scopes.flatMap((scope) => files.map((f) => path.join(scope, f)));
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
    out[key] = value.includes('$') ? value.replaceAll('$', '\\$') : value;
  }
  return out;
}

/**
 * Resolves the `.env` files for a package into a flat, expanded variable map without touching
 * `process.env`. Only files that exist are loaded; a later file (or a package-scope file)
 * overrides an earlier one.
 *
 * The **ambient environment wins** over the files — matching Next.js, Vite, dotenv-flow and
 * `node --env-file`, so `FOO=bar devtooie` overrides a file for one run. `override` names the
 * exceptions: variables whose file value is allowed to win instead (or `true` for all of them).
 */
export function resolveEnv(opts: ResolveEnvOptions): EnvResolution {
  const candidates = envCandidatePaths(opts);
  const files = candidates.filter((p) => fs.existsSync(p));

  const ambient = ambientEnv();
  const source = files.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  if (!source) {
    return { env: {}, files, candidates };
  }

  const { override } = opts;
  const overridesAll = override === true;
  const overridden = new Set(Array.isArray(override) ? override : []);
  const isOverridden = (key: string) => overridesAll || overridden.has(key);
  const hasOverrides = overridesAll || overridden.size > 0;

  // dotenvx reads from this snapshot for `$VAR` lookups but writes to neither it nor the real
  // process.env, so nothing is mutated.
  const lit = literalizeForExpansion(ambient);

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

  return { env, files, candidates };
}

/**
 * The `.env`-derived environment layer for a package's child process: the package's configured
 * `port` as `PORT` and, under the dev reverse proxy, its public origin as `PUBLIC_ORIGIN` (an
 * explicit `.env` value for either still wins), then its resolved `.env` files.
 * Excludes `process.env` — merge this over it at spawn time (`Object.assign({}, process.env,
 * layer)`). Shared by the TUI/plain session and `devtooie cmd` so both build the same env.
 */
export function packageEnvLayer(
  pkg: AnyPackageConfig,
  opts: { cwd: string; files?: string[]; override?: EnvOverride },
): Record<string, string> {
  const { env } = resolveEnv({
    cwd: opts.cwd,
    relativeDir: pkg.relativeDir,
    files: opts.files,
    override: opts.override,
  });
  const injected: Record<string, string> = {};
  if (pkg.port !== undefined) {
    injected.PORT = String(pkg.port);
  }
  if (pkg.publicOrigin !== undefined) {
    injected.PUBLIC_ORIGIN = pkg.publicOrigin;
  }
  return Object.assign(injected, env);
}

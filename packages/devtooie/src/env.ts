import fs from 'node:fs';
import path from 'node:path';
import dotenvx from '@dotenvx/dotenvx';
import type { AnyPackageConfig } from './config.js';

/**
 * Default `.env` filenames, in ascending precedence *within a scope*: a base `.env`,
 * the dev config `.env.development`, and the developer's personal `.env.local`.
 * Overridable via `defineConfig({ env: { files } })`.
 */
export const DEFAULT_ENV_FILES = ['.env', '.env.development', '.env.local'];

export interface EnvResolution {
  /**
   * Variables defined by the resolved files, already `${VAR}`-expanded. Does NOT include
   * `process.env` — merge yourself with `Object.assign({}, process.env, env)`.
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
  /** Filenames to look for at each scope (defaults to {@link DEFAULT_ENV_FILES}). */
  files?: string[];
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
  files = DEFAULT_ENV_FILES,
}: ResolveEnvOptions): string[] {
  const workspaceDir = path.resolve(cwd);
  const pkgDir = path.resolve(cwd, relativeDir);
  const scopes = pkgDir === workspaceDir ? [workspaceDir] : [workspaceDir, pkgDir];
  return scopes.flatMap((scope) => files.map((f) => path.join(scope, f)));
}

/**
 * Resolves the `.env` files for a package into a flat, expanded variable map without
 * touching `process.env`. Only files that exist are loaded; a later file (or a
 * package-scope file) overrides an earlier one. `${VAR}` references expand against
 * already-resolved file vars (which win) and then the current `process.env`.
 */
export function resolveEnv(opts: ResolveEnvOptions): EnvResolution {
  const candidates = envCandidatePaths(opts);
  const files = candidates.filter((p) => fs.existsSync(p));

  // A copy of process.env (sans undefined values) is the source for `$VAR` lookups. dotenvx
  // reads from it but writes to neither it nor the real process.env, so nothing is mutated.
  const ambient: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) ambient[key] = value;
  }

  // Concatenate the existing files in ascending precedence (later overrides earlier, and a
  // later file may reference an earlier file's var), then parse + expand once. `overload:
  // true` makes a file var win over an ambient one of the same name — the inverse of
  // dotenvx's default, and what devtooie's "env files override process.env" contract needs.
  // It's also what lets the self-append pattern `NODE_OPTIONS=$NODE_OPTIONS --flag` extend
  // the ambient value instead of discarding it.
  const source = files.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  const env = source ? dotenvx.parse(source, { processEnv: ambient, overload: true }) : {};

  return { env, files, candidates };
}

/**
 * The `.env`-derived environment layer for a package's child process: the package's configured
 * `port` as `PORT` (an explicit `.env` `PORT` still wins), then its resolved `.env` files.
 * Excludes `process.env` — merge this over it at spawn time (`Object.assign({}, process.env,
 * layer)`). Shared by the TUI/plain session and `devtooie cmd` so both build the same env.
 */
export function packageEnvLayer(
  pkg: AnyPackageConfig,
  opts: { cwd: string; files?: string[] },
): Record<string, string> {
  const { env } = resolveEnv({ cwd: opts.cwd, relativeDir: pkg.relativeDir, files: opts.files });
  return pkg.port !== undefined ? Object.assign({ PORT: String(pkg.port) }, env) : env;
}

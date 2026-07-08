import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

/**
 * Default `.env` filenames, in ascending precedence *within a scope*: a base `.env`,
 * a pre-seed `.env.development.pre`, the dev config `.env.development`, and the
 * developer's personal `.env.local`. Overridable via `defineConfig({ env: { files } })`.
 */
export const DEFAULT_ENV_FILES = ['.env', '.env.development.pre', '.env.development', '.env.local'];

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
 * already-loaded files and the current `process.env`.
 */
export function resolveEnv(opts: ResolveEnvOptions): EnvResolution {
  const candidates = envCandidatePaths(opts);
  const files = candidates.filter((p) => fs.existsSync(p));

  const parsed: Record<string, string> = {};
  for (const file of files) {
    Object.assign(parsed, dotenv.parse(fs.readFileSync(file)));
  }
  const fileKeys = Object.keys(parsed);

  // Expand against a throwaway copy of process.env (sans undefined values) so the real
  // process.env is never mutated.
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) processEnv[key] = value;
  }
  const expanded = expand({ parsed: { ...parsed }, processEnv }).parsed ?? {};

  const env: Record<string, string> = {};
  for (const key of fileKeys) {
    env[key] = expanded[key] ?? parsed[key]!;
  }
  return { env, files, candidates };
}

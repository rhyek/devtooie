import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRegisteredPackages, type AnyPackageConfig, type Config } from './config.js';

export class NoProjectConfigError extends Error {}

/**
 * Config file names, in discovery order. `devtooie.config.ts` is canonical; the others are
 * runtime-only fallbacks (a `.js`/`.mjs` config works at runtime but carries no inline
 * `declare module` type augmentation).
 */
export const CONFIG_NAMES = [
  'devtooie.config.ts',
  'devtooie.config.mts',
  'devtooie.config.js',
  'devtooie.config.mjs',
];

export function findConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of CONFIG_NAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Walks up from `cwd` to the nearest directory that holds a devtooie config file, and
 * returns it — the workspace root. Returns `null` if none is found before the filesystem
 * root. Unlike {@link findConfigPath}, which only checks `cwd` itself, this searches
 * ancestors so a command run from inside a package still finds the project root.
 */
export function findWorkspaceRoot(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (findConfigPath(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export async function loadConfig(cwd: string = process.cwd()): Promise<AnyPackageConfig[]> {
  const configPath = findConfigPath(cwd);
  if (!configPath) {
    throw new NoProjectConfigError('no devtooie.config.ts found — run `devtooie init`');
  }
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: Config<string> };
  // `defineConfig` registers packages as a side effect of being imported.
  const registered = getRegisteredPackages();
  if (registered.length) {
    return registered;
  }
  if (mod.default && Array.isArray(mod.default.packages)) {
    return mod.default.packages;
  }
  throw new Error(
    `config module ${path.basename(configPath)} did not export a defineConfig default`,
  );
}

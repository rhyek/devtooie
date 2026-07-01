import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectConfig } from './project-config.js';
import { getRegisteredApps, type AnyAppConfig } from './config.js';

export class NoProjectConfigError extends Error {}

export async function loadServices(cwd: string = process.cwd()): Promise<AnyAppConfig[]> {
  const cfg = getProjectConfig(cwd);
  if (!cfg) {
    throw new NoProjectConfigError('no devtooie.yaml found — run `devtooie init`');
  }
  const servicesPath = path.resolve(cwd, cfg.services);
  const mod = (await import(pathToFileURL(servicesPath).href)) as { default?: AnyAppConfig[] };
  const registered = getRegisteredApps();
  if (registered.length) return registered;
  if (Array.isArray(mod.default)) return mod.default;
  throw new Error(`services module ${cfg.services} did not export a defineAppConfigs default`);
}

import path from 'node:path';

export const PackageType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type PackageType = (typeof PackageType)[keyof typeof PackageType];
export type PackageTypeValue = 'backend' | 'browser' | 'lib';

export interface RunConfig<N extends string> {
  selectable?: boolean;
  shortName?: string;
  subdomain?: string | string[];
  port?: number;
  hmrPort?: number;
  urls?: (string | { label: string; url: string })[];
  healthcheck?: string;
  waitFor?: NoInfer<N>[];
  deps?: {
    build?: NoInfer<N>[];
    dev?: NoInfer<N>[];
    runtime?: NoInfer<N>[];
  };
}

export interface PackageConfigInput<N extends string> {
  name: N;
  relativeDir?: string;
  types: PackageTypeValue[];
  run?: RunConfig<N>;
}

export interface DefineConfigOptions<N extends string> {
  apiPort?: number;
  packages: PackageConfigInput<N>[];
  workspaceDir?: string;
  tokens?: Record<string, string | undefined>;
}

export type ResolvedPackageConfig<N extends string> = PackageConfigInput<N> & {
  relativeDir: string;
  path: string;
};

export type AnyPackageConfig = ResolvedPackageConfig<string>;

export interface Config<N extends string> {
  apiPort: number;
  packages: ResolvedPackageConfig<N>[];
}

export const DEFAULT_API_PORT = 4099;

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
  if (!pkg) throw new Error(`package ${name} not found`);
  return pkg;
}

function substituteRun<N extends string>(
  name: N,
  run: RunConfig<N>,
  tokens: Record<string, string | undefined>,
): RunConfig<N> {
  const primarySubdomain = Array.isArray(run.subdomain) ? run.subdomain[0] : run.subdomain;
  const replace = (s: string): string => {
    let out = s.replaceAll('$name', name);
    if (out.includes('$subdomain')) {
      if (!primarySubdomain) {
        throw new Error(`${name} uses $subdomain but run.subdomain is not defined`);
      }
      out = out.replaceAll('$subdomain', primarySubdomain);
    }
    if (out.includes('$port')) {
      if (run.port === undefined) {
        throw new Error(`${name} uses $port but run.port is not defined`);
      }
      out = out.replaceAll('$port', String(run.port));
    }
    // Extrinsic tokens: any remaining $key must resolve from tokens.
    out = out.replace(/\$([a-z][a-z0-9_]*)/gi, (_match, key: string) => {
      if (key in tokens) {
        const val = tokens[key];
        if (val === undefined) {
          throw new Error(`${name} uses $${key} but tokens.${key} is undefined`);
        }
        return val;
      }
      throw new Error(`${name} uses $${key} but no such token was provided`);
    });
    return out;
  };
  return {
    ...run,
    urls: run.urls?.map((u) =>
      typeof u === 'string' ? replace(u) : { ...u, url: replace(u.url) },
    ),
    healthcheck: run.healthcheck ? replace(run.healthcheck) : undefined,
  };
}

export function defineConfig<const N extends string>(opts: DefineConfigOptions<N>): Config<N> {
  const workspaceDir = opts.workspaceDir ?? process.cwd();

  // Validate waitFor targets before substitution
  const healthcheckPackages = new Set(
    opts.packages.filter((c) => c.run?.healthcheck).map((c) => c.name),
  );
  const allNames = new Set(opts.packages.map((c) => c.name));
  for (const config of opts.packages) {
    for (const waitName of config.run?.waitFor ?? []) {
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

  const packages = opts.packages.map((config) => {
    const relativeDir = config.relativeDir ?? `packages/${config.name}`;
    const run = config.run;
    return {
      ...config,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
      run: run ? substituteRun(config.name, run, opts.tokens ?? {}) : undefined,
    };
  });

  const resolved: Config<N> = {
    apiPort: opts.apiPort ?? DEFAULT_API_PORT,
    packages,
  };
  registeredPackages = packages as AnyPackageConfig[];
  loadedConfig = resolved as Config<string>;
  return resolved;
}

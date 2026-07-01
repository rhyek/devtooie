import path from 'node:path';

export const AppType = { BACKEND: 'backend', BROWSER: 'browser', LIB: 'lib' } as const;
export type AppType = (typeof AppType)[keyof typeof AppType];
export type AppTypeValue = 'backend' | 'browser' | 'lib';

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

export interface AppConfigInput<N extends string> {
  name: N;
  relativeDir?: string;
  types: AppTypeValue[];
  run?: RunConfig<N>;
}

export interface DefineAppConfigsOptions<N extends string> {
  apps: AppConfigInput<N>[];
  workspaceDir?: string;
  tokens?: Record<string, string | undefined>;
}

export type ResolvedAppConfig<N extends string> = AppConfigInput<N> & {
  relativeDir: string;
  path: string;
};

export type AnyAppConfig = ResolvedAppConfig<string>;

function substituteRun<N extends string>(
  name: N,
  run: RunConfig<N>,
  tokens: Record<string, string | undefined>,
): RunConfig<N> {
  const primarySubdomain = Array.isArray(run.subdomain) ? run.subdomain[0] : run.subdomain;
  const replace = (s: string): string => {
    let out = s.replaceAll(':name', name);
    if (out.includes(':subdomain')) {
      if (!primarySubdomain) {
        throw new Error(`${name} uses :subdomain but run.subdomain is not defined`);
      }
      out = out.replaceAll(':subdomain', primarySubdomain);
    }
    if (out.includes(':port')) {
      if (run.port === undefined) {
        throw new Error(`${name} uses :port but run.port is not defined`);
      }
      out = out.replaceAll(':port', String(run.port));
    }
    // Extrinsic tokens: any remaining :key must resolve from tokens.
    out = out.replace(/:([a-z][a-z0-9_]*)/gi, (_match, key: string) => {
      if (key in tokens) {
        const val = tokens[key];
        if (val === undefined) {
          throw new Error(`${name} uses :${key} but tokens.${key} is undefined`);
        }
        return val;
      }
      throw new Error(`${name} uses :${key} but no such token was provided`);
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

export function defineAppConfigs<const N extends string>(
  opts: DefineAppConfigsOptions<N>,
): ResolvedAppConfig<N>[] {
  const workspaceDir = opts.workspaceDir ?? process.cwd();

  // Validate waitFor targets before substitution
  const healthcheckApps = new Set(opts.apps.filter((c) => c.run?.healthcheck).map((c) => c.name));
  const allNames = new Set(opts.apps.map((c) => c.name));
  for (const config of opts.apps) {
    for (const waitName of config.run?.waitFor ?? []) {
      if (!allNames.has(waitName)) {
        throw new Error(`${config.name} has waitFor "${waitName}" but no such app exists`);
      }
      if (!healthcheckApps.has(waitName)) {
        throw new Error(
          `${config.name} has waitFor "${waitName}" but that app has no healthcheck defined`,
        );
      }
    }
  }

  return opts.apps.map((config) => {
    const relativeDir = config.relativeDir ?? `projects/${config.name}`;
    const run = config.run;
    return {
      ...config,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
      run: run ? substituteRun(config.name, run, opts.tokens ?? {}) : undefined,
    };
  });
}

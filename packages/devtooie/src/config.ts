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

export function defineAppConfigs<const N extends string>(
  opts: DefineAppConfigsOptions<N>,
): ResolvedAppConfig<N>[] {
  const workspaceDir = opts.workspaceDir ?? process.cwd();
  return opts.apps.map((config) => {
    const relativeDir = config.relativeDir ?? `projects/${config.name}`;
    return {
      ...config,
      relativeDir,
      path: path.resolve(workspaceDir, relativeDir),
    };
  });
}

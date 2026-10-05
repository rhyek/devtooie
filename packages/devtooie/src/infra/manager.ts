import { getConfigTokens, getWorkspaceDir, type Config, type TokenRecord } from '../config.js';
import { ambientEnv, resolveEnv } from '../env.js';
import { execLines, spawnInherit, type Exec, type SpawnInherit } from './exec.js';
import type { InfraProvider, InfraRunRequest, ProviderRuntime } from './provider.js';
import { DockerComposeProvider } from './providers/docker-compose.js';
import { InfraError, type InfraRunSummary } from './types.js';

/** A service and the provider that runs it. */
export interface InfraServiceRef {
  provider: string;
  name: string;
}

/** Overrides for what a manager is built from; a session passes none. */
export interface InfraManagerDeps {
  exec?: Exec;
  spawnInherit?: SpawnInherit;
  workspaceDir?: string;
  tokens?: TokenRecord;
}

/**
 * The one entry point to infra. It builds a provider per key under the config's `infra`, routes
 * a service name to the provider that has it, and is what the `infra` commands, `--plain` and
 * the TUI all call — none of them talks to a provider.
 */
export class InfraManager {
  constructor(private readonly providers: InfraProvider[]) {}

  /** The manager for a resolved config, or `null` when it declares no `infra`. */
  static fromConfig(config: Config<string>, deps: InfraManagerDeps = {}): InfraManager | null {
    if (!config.infra) {
      return null;
    }
    const workspaceDir = deps.workspaceDir ?? getWorkspaceDir();
    const runtime: ProviderRuntime = {
      workspaceDir,
      mode: config.envMode,
      // The same environment a workspace-scope config callback sees: the mode's `.env` files
      // over the ambient environment.
      envs: Object.assign(
        ambientEnv(),
        resolveEnv({
          cwd: workspaceDir,
          relativeDir: '.',
          files: config.envFiles,
          override: config.envOverride,
        }).env,
      ),
      tokens: deps.tokens ?? getConfigTokens(),
      exec: deps.exec ?? execLines,
      spawnInherit: deps.spawnInherit ?? spawnInherit,
    };
    const providers: InfraProvider[] = [];
    const compose = config.infra['docker-compose'];
    if (compose) {
      providers.push(new DockerComposeProvider(compose, runtime));
    }
    return new InfraManager(providers);
  }

  /** Every service, across providers, in the order the providers report them. */
  async services(): Promise<InfraServiceRef[]> {
    const lists = await Promise.all(
      this.providers.map(async (provider) =>
        (await provider.listServices()).map((name) => ({ provider: provider.key, name })),
      ),
    );
    return lists.flat();
  }

  /** Brings services up and waits until they are ready. See {@link InfraProvider.up}. */
  async up(req: InfraRunRequest = {}): Promise<InfraRunSummary> {
    return this.acrossProviders(req.services, (provider, services) =>
      provider.up({ ...req, services }),
    );
  }

  /** Removes services and their data. See {@link InfraProvider.destroy}. */
  async destroy(req: Omit<InfraRunRequest, 'reset'> = {}): Promise<InfraRunSummary> {
    return this.acrossProviders(req.services, (provider, services) =>
      provider.destroy({ ...req, services }),
    );
  }

  /** Stops and removes services, keeping their data. Resolves with the worst exit code. */
  async down(services: string[] = []): Promise<number> {
    const plan = await this.route(services);
    let exitCode = 0;
    for (const [provider, names] of plan) {
      exitCode = Math.max(exitCode, await provider.down(names));
    }
    return exitCode;
  }

  /** Runs a provider's own tool with `args`, the terminal handed over to it. */
  async passthrough(providerKey: string, args: string[], invocationCwd: string): Promise<number> {
    const provider = this.providers.find((p) => p.key === providerKey);
    if (!provider) {
      throw new InfraError(
        `the config's \`infra\` has no \`${providerKey}\` provider, so there is nothing for ` +
          `\`devtooie infra ${providerKey}\` to run.`,
      );
    }
    return provider.passthrough(args, invocationCwd);
  }

  private async acrossProviders(
    services: string[] | undefined,
    run: (provider: InfraProvider, services: string[]) => Promise<InfraRunSummary>,
  ): Promise<InfraRunSummary> {
    const plan = await this.route(services ?? []);
    const summaries = await Promise.all([...plan].map(([provider, names]) => run(provider, names)));
    return {
      ok: summaries.every((s) => s.ok),
      services: summaries.flatMap((s) => s.services),
    };
  }

  /**
   * Which provider handles which of the named services. No names means every provider, each
   * with an empty list — its own "all of them". A name no provider has is an error listing
   * the real ones.
   */
  private async route(named: string[]): Promise<Map<InfraProvider, string[]>> {
    const plan = new Map<InfraProvider, string[]>();
    if (named.length === 0) {
      for (const provider of this.providers) {
        plan.set(provider, []);
      }
      return plan;
    }
    const owners = new Map<string, InfraProvider>();
    for (const provider of this.providers) {
      for (const name of await provider.listServices()) {
        if (!owners.has(name)) {
          owners.set(name, provider);
        }
      }
    }
    const unknown = named.filter((name) => !owners.has(name));
    if (unknown.length > 0) {
      throw new InfraError(
        `unknown infra service${unknown.length > 1 ? 's' : ''} ${unknown.map((s) => `"${s}"`).join(', ')}. ` +
          `Services: ${[...owners.keys()].join(', ') || '(none)'}`,
      );
    }
    for (const name of named) {
      const provider = owners.get(name)!;
      plan.set(provider, [...(plan.get(provider) ?? []), name]);
    }
    return plan;
  }
}

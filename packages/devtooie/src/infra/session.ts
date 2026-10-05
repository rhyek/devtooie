import { getLoadedConfig } from '../config.js';
import type { InfraLogLine, SessionInfra } from '../runners/types.js';
import { InfraManager, type InfraManagerDeps } from './manager.js';
import type { InfraEvent, InfraRunSummary } from './types.js';

/** How many lines of a failed service's output its failure report carries. */
const FAILURE_OUTPUT_LINES = 15;

/**
 * A session's infra step ended with at least one service not ready. The message is the whole
 * report: each failed service and why, followed by the tail of what its callbacks printed —
 * the TUI shows nothing else of that output, and it is usually where the reason is.
 */
export class InfraFailedError extends Error {
  override name = 'InfraFailedError';

  constructor(
    readonly summary: InfraRunSummary,
    output: ReadonlyMap<string, string[]> = new Map(),
  ) {
    super(
      summary.services
        .filter((s) => !s.ok)
        .flatMap((s) => [
          `${s.service}: ${s.error ?? 'failed'}`,
          ...(output.get(s.service) ?? [])
            .slice(-FAILURE_OUTPUT_LINES)
            .map((line) => `    ${line}`),
        ])
        .join('\n'),
    );
  }
}

/** The line an event leaves in the session log, if any. */
function logLines(event: InfraEvent): InfraLogLine[] {
  if (event.type === 'output') {
    return [{ service: event.service, text: event.line, isError: event.isError }];
  }
  if (event.type === 'status' && event.status === 'ready') {
    return [{ service: event.service, text: 'ready', isError: false }];
  }
  if (event.type === 'status' && event.status === 'failed') {
    return `failed: ${event.detail ?? ''}`
      .split('\n')
      .map((text) => ({ service: event.service, text, isError: true }));
  }
  return [];
}

/**
 * The infra step of a dev session: bring every service up — no reset — and wait, exactly as
 * `devtooie infra up` does, before any package starts. Resolves with what the run phase needs
 * (the services for the footer, the output for the session log), or `undefined` when the config
 * declares no `infra`. Throws {@link InfraFailedError} when a service doesn't make it: the
 * packages must not start against infrastructure that isn't there.
 *
 * Nothing here stops the services again — quitting a session leaves them running.
 */
export async function runSessionInfra(
  onEvent?: (event: InfraEvent) => void,
  deps?: InfraManagerDeps,
): Promise<SessionInfra | undefined> {
  const config = getLoadedConfig();
  const manager = config ? InfraManager.fromConfig(config, deps) : null;
  if (!manager) {
    return undefined;
  }
  const services: SessionInfra['services'] = [];
  const log: InfraLogLine[] = [];
  const output = new Map<string, string[]>();
  const summary = await manager.up({
    onEvent: (event) => {
      if (event.type === 'targets') {
        services.push(...event.services.map((name) => ({ provider: event.provider, name })));
      }
      if (event.type === 'output' && event.service !== undefined) {
        output.set(event.service, [...(output.get(event.service) ?? []), event.line]);
      }
      log.push(...logLines(event));
      onEvent?.(event);
    },
  });
  if (!summary.ok) {
    throw new InfraFailedError(summary, output);
  }
  return { services, log };
}

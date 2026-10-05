import { getLoadedConfig } from '../config.js';
import type { InfraLogLine, SessionInfra } from '../runners/types.js';
import { InfraManager, type InfraManagerDeps } from './manager.js';
import type { InfraEvent, InfraRunSummary } from './types.js';

/** A session's infra step ended with at least one service not ready. */
export class InfraFailedError extends Error {
  override name = 'InfraFailedError';

  constructor(readonly summary: InfraRunSummary) {
    super(
      summary.services
        .filter((s) => !s.ok)
        .map((s) => `${s.service}: ${s.error ?? 'failed'}`)
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
  const summary = await manager.up({
    onEvent: (event) => {
      if (event.type === 'targets') {
        services.push(...event.services.map((name) => ({ provider: event.provider, name })));
      }
      log.push(...logLines(event));
      onEvent?.(event);
    },
  });
  if (!summary.ok) {
    throw new InfraFailedError(summary);
  }
  return { services, log };
}

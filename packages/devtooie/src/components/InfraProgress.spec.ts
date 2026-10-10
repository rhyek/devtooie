import { describe, expect, test } from 'vitest';
import type { InfraEvent } from '../infra/types.js';
import { applyInfraEvent, type InfraRow } from './InfraProgress.js';

const fold = (events: InfraEvent[]) => events.reduce(applyInfraEvent, [] as InfraRow[]);

describe('applyInfraEvent', () => {
  test('the targets set up one waiting row per service, once', () => {
    const targets: InfraEvent = {
      type: 'targets',
      provider: 'docker-compose',
      action: 'up',
      services: ['db', 'redis'],
    };
    expect(fold([targets, targets])).toEqual([
      { service: 'db', status: 'pending' },
      { service: 'redis', status: 'pending' },
    ]);
  });

  test('a status moves its own row along, carrying the step it is on', () => {
    expect(
      fold([
        { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db', 'redis'] },
        { type: 'status', service: 'db', status: 'starting', detail: 'waiting for healthy' },
        { type: 'status', service: 'redis', status: 'ready' },
      ]),
    ).toEqual([
      { service: 'db', status: 'starting', detail: 'waiting for healthy' },
      { service: 'redis', status: 'ready', detail: undefined },
    ]);
  });

  test("a callback's output becomes its row's text, and the provider's own output changes nothing", () => {
    const rows = fold([
      { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db'] },
      { type: 'status', service: 'db', status: 'starting', detail: 'afterReady' },
      { type: 'output', line: 'Container example-db-1 Started', isError: false },
      { type: 'output', service: 'db', line: '2 migrations applied', isError: false },
    ]);
    expect(rows).toEqual([{ service: 'db', status: 'starting', detail: '2 migrations applied' }]);
  });

  test('a failure drops the detail: the report belongs on the error screen, not in a row', () => {
    const rows = fold([
      { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db'] },
      { type: 'status', service: 'db', status: 'failed', detail: 'exited (1)\nFATAL: bad config' },
    ]);
    expect(rows).toEqual([{ service: 'db', status: 'failed', detail: undefined }]);
  });
});

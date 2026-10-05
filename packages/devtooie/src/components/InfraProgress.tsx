import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { DANGER_COLOR, MUTED_COLOR, OK_COLOR, WARN_COLOR } from '../colors.js';
import type { InfraEvent, InfraServiceStatus } from '../infra/types.js';

/** One service on the startup screen: where it is, and the step or output line it's on. */
export type InfraRow = { service: string; status: InfraServiceStatus; detail?: string };

/**
 * Which role each infra status plays — the same roles the package dots use in the run phase
 * (`STATUS_COLORS` in `NativeRunner`): yellow while it's coming up, green once it's there.
 */
const STATUS_COLORS: Record<InfraServiceStatus, string> = {
  pending: MUTED_COLOR,
  destroying: WARN_COLOR,
  starting: WARN_COLOR,
  ready: OK_COLOR,
  destroyed: OK_COLOR,
  failed: DANGER_COLOR,
};

/** How often an in-progress dot alternates between bright and dim. */
const PULSE_MS = 500;

/**
 * Folds one infra event into the rows: the targets set the rows up, a status moves a row along,
 * and a line a service's callback prints becomes that row's text until the next one.
 */
export function applyInfraEvent(rows: InfraRow[], event: InfraEvent): InfraRow[] {
  if (event.type === 'targets') {
    const known = new Set(rows.map((row) => row.service));
    return [
      ...rows,
      ...event.services
        .filter((service) => !known.has(service))
        .map((service): InfraRow => ({ service, status: 'pending' })),
    ];
  }
  if (event.type === 'status') {
    return rows.map((row) =>
      row.service === event.service
        ? // A failure's detail is the whole report; the error screen shows it, not this row.
          {
            ...row,
            status: event.status,
            detail: event.status === 'failed' ? undefined : event.detail,
          }
        : row,
    );
  }
  if (event.service === undefined) {
    return rows;
  }
  return rows.map((row) =>
    row.service === event.service && row.status === 'starting'
      ? { ...row, detail: event.line }
      : row,
  );
}

/** The text beside a service's name: a final status in a word, else the step it is on. */
function rowLabel(row: InfraRow): string {
  switch (row.status) {
    case 'ready':
    case 'failed':
    case 'destroyed':
      return row.status;
    case 'pending':
      return 'waiting';
    default:
      return row.detail ?? row.status;
  }
}

/**
 * The infra rows of the startup screen: one per service, with a status dot in the colors the
 * package dots use and the step — or the latest line of callback output — beside the name.
 */
export function InfraProgress({ rows }: { rows: InfraRow[] }): React.ReactElement | null {
  const [pulse, setPulse] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setPulse((on) => !on), PULSE_MS);
    return () => clearInterval(timer);
  }, []);

  if (rows.length === 0) {
    return null;
  }
  const width = rows.reduce((max, row) => Math.max(max, row.service.length), 0);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Infra:</Text>
      {rows.map((row) => {
        const inProgress = row.status === 'starting' || row.status === 'destroying';
        return (
          <Box key={row.service}>
            <Text> </Text>
            <Text color={STATUS_COLORS[row.status]} dimColor={inProgress && !pulse}>
              ●
            </Text>
            <Box flexShrink={0}>
              <Text> {row.service.padEnd(width)} </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {rowLabel(row)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

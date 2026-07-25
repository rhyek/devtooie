import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk from 'chalk';
import { createInternalLogger, formatInternalRecord } from './internal-logger.js';

// Deterministic, ANSI-free assertions on the rendered text.
let prevLevel: number;
beforeAll(() => {
  prevLevel = chalk.level;
  chalk.level = 0;
});
afterAll(() => {
  chalk.level = prevLevel;
});

describe('formatInternalRecord', () => {
  it('renders a control command with its attrs as an [INFO] header + indented props', () => {
    const line = JSON.stringify({
      level: 30,
      component: 'control',
      package: 'web',
      msg: 'restart',
    });
    const r = formatInternalRecord(line);
    expect(r.component).toBe('control');
    expect(r.packageName).toBe('web');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('[INFO]');
    expect(r.text).toContain('restart');
    // the passed variable renders as an indented property...
    expect(r.text).toContain('package');
    expect(r.text).toContain('web');
    // ...but the routing field never leaks into the output
    expect(r.text).not.toContain('component');
  });

  it('renders a system warning without a package', () => {
    const line = JSON.stringify({ level: 40, component: 'system', msg: 'shutting down...' });
    const r = formatInternalRecord(line);
    expect(r.component).toBe('system');
    expect(r.packageName).toBeUndefined();
    expect(r.isError).toBe(false);
    expect(r.text).toContain('[WARN]');
    expect(r.text).toContain('shutting down...');
  });

  it('flags error-level (>=50) records as errors', () => {
    const line = JSON.stringify({ level: 50, component: 'system', msg: 'boom' });
    expect(formatInternalRecord(line).isError).toBe(true);
  });

  it('defaults an absent/unknown component to system', () => {
    const line = JSON.stringify({ level: 30, msg: 'hi' });
    expect(formatInternalRecord(line).component).toBe('system');
  });
});

describe('createInternalLogger', () => {
  it('emits child-bound component + attrs as JSON, with no pid/hostname/time noise', () => {
    const lines: string[] = [];
    const { control, system } = createInternalLogger((l) => lines.push(l));
    control.info({ package: 'web' }, 'restart');
    system.warn('shutting down...');
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs[0]).toMatchObject({
      component: 'control',
      package: 'web',
      msg: 'restart',
      level: 30,
    });
    expect(recs[1]).toMatchObject({ component: 'system', msg: 'shutting down...', level: 40 });
    expect(recs[0].pid).toBeUndefined();
    expect(recs[0].hostname).toBeUndefined();
    expect(recs[0].time).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { parseLsofPids, parseSsPids, buildKillSet, dedupePorts } from './dev-session.js';

describe('dev-session pure helpers', () => {
  it('parses lsof -t output (one pid per line)', () => {
    expect(parseLsofPids('1234\n5678\n')).toEqual([1234, 5678]);
    expect(parseLsofPids('')).toEqual([]);
  });

  it('parses ss -tlnpH output extracting pid=', () => {
    const out = 'LISTEN 0 511 *:3000 *:* users:(("node",pid=4242,fd=20))';
    expect(parseSsPids(out)).toEqual([4242]);
  });

  it('builds a kill set of roots + transitive descendants', () => {
    const procs = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 999, ppid: 1 },
    ];
    expect(buildKillSet(procs, [100]).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('dedupes and filters NaN/undefined ports', () => {
    expect(dedupePorts([3000, 3000, undefined, NaN, 4099]).sort((a, b) => a - b)).toEqual([
      3000, 4099,
    ]);
  });
});

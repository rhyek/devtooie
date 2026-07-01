import { describe, it, expect, vi } from 'vitest';
import { watchGitBranch } from './git-watch.js';

describe('watchGitBranch', () => {
  it('fires once on the first branch change and stops', () => {
    vi.useFakeTimers();
    const branches = ['main', 'main', 'feature', 'other'];
    let i = 0;
    const read = () => branches[Math.min(i++, branches.length - 1)]!;
    const onChange = vi.fn();
    const stop = watchGitBranch({ read, intervalMs: 100, onChange });
    vi.advanceTimersByTime(100); // main (no change)
    vi.advanceTimersByTime(100); // feature (change → fire once)
    vi.advanceTimersByTime(100); // should NOT fire again
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('main', 'feature');
    stop();
    vi.useRealTimers();
  });
});

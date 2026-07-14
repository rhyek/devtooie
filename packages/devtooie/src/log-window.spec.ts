import { describe, it, expect } from 'vitest';
import { computeWindow, windowRows } from './log-window.js';

describe('computeWindow', () => {
  it('returns an empty window for an empty buffer', () => {
    expect(computeWindow([], 10, 0)).toEqual({
      startIndex: 0,
      endIndex: 0,
      topClip: 0,
      bottomClip: 0,
      totalRows: 0,
      maxScroll: 0,
    });
  });

  it('shows every line when the buffer is shorter than the pane', () => {
    const w = computeWindow([1, 1, 1], 10, 0);
    expect(w).toEqual({
      startIndex: 0,
      endIndex: 3,
      topClip: 0,
      bottomClip: 0,
      totalRows: 3,
      maxScroll: 0,
    });
  });

  it('follows the newest rows when scrollOffset is 0 and the buffer overflows', () => {
    // 5 single-row lines, pane of 3 -> show the last 3 (indices 2,3,4).
    const w = computeWindow([1, 1, 1, 1, 1], 3, 0);
    expect(w.startIndex).toBe(2);
    expect(w.endIndex).toBe(5);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
    expect(w.maxScroll).toBe(2);
  });

  it('scrolls up by whole rows', () => {
    const w = computeWindow([1, 1, 1, 1, 1], 3, 1);
    expect(w.startIndex).toBe(1);
    expect(w.endIndex).toBe(4);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
  });

  it('shows the top of the buffer at maximum scroll', () => {
    const w = computeWindow([1, 1, 1, 1, 1], 3, 2);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(3);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
  });

  it('clamps a scrollOffset beyond maxScroll', () => {
    const clamped = computeWindow([1, 1, 1, 1, 1], 3, 999);
    const atMax = computeWindow([1, 1, 1, 1, 1], 3, 2);
    expect(clamped).toEqual(atMax);
  });

  it('clips partial rows of wrapped (multi-row) lines at both edges', () => {
    // line0=3 rows, line1=1 row, line2=3 rows (total 7), pane 4, scrolled up 1.
    // flat window = rows [2,6): drop top 2 of line0, keep all line1, drop bottom 1 of line2.
    const w = computeWindow([3, 1, 3], 4, 1);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(3);
    expect(w.topClip).toBe(2);
    expect(w.bottomClip).toBe(1);
    expect(w.totalRows).toBe(7);
    expect(w.maxScroll).toBe(3);
  });

  it('follows correctly with wrapped lines (no clip at the bottom)', () => {
    // total 7, pane 4, follow -> rows [3,7): startIndex 1 (line1), no clips.
    const w = computeWindow([3, 1, 3], 4, 0);
    expect(w.startIndex).toBe(1);
    expect(w.endIndex).toBe(3);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
  });

  it('renders nothing when the pane has zero height', () => {
    const w = computeWindow([1, 1, 1], 0, 0);
    expect(w.startIndex).toBe(w.endIndex);
    expect(w.maxScroll).toBe(3);
  });
});

describe('windowRows', () => {
  const wrap = (rows: string[]) => rows;

  it('flattens the visible lines into their rendered rows', () => {
    const lines = [['a'], ['b'], ['c']];
    const w = computeWindow([1, 1, 1], 10, 0);
    expect(windowRows(lines, w, wrap)).toEqual(['a', 'b', 'c']);
  });

  it('applies top and bottom clips to partially-visible wrapped lines', () => {
    const lines = [['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2', 'c3']];
    // pane 4, scrolled up 1 -> drop top 2 of line0, keep line1, drop bottom 1 of line2.
    const w = computeWindow([3, 1, 3], 4, 1);
    expect(windowRows(lines, w, wrap)).toEqual(['a3', 'b1', 'c1', 'c2']);
  });

  it('never emits more rows than the pane height', () => {
    const lines = Array.from({ length: 100 }, (_, i) => [`line ${i}`]);
    const w = computeWindow(
      lines.map(() => 1),
      12,
      0,
    );
    expect(windowRows(lines, w, wrap)).toHaveLength(12);
  });
});

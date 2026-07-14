import { describe, it, expect } from 'vitest';
import {
  highlightParts,
  isEmptySelection,
  normalizeSelection,
  rowSpan,
  selectionText,
  viewportRowIndex,
  type Selection,
} from './selection.js';

const ESC = String.fromCharCode(27);
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;

describe('selection ordering', () => {
  it('detects an empty (click, no drag) selection', () => {
    expect(
      isEmptySelection({ anchor: { flatRow: 2, col: 3 }, focus: { flatRow: 2, col: 3 } }),
    ).toBe(true);
    expect(
      isEmptySelection({ anchor: { flatRow: 2, col: 3 }, focus: { flatRow: 2, col: 4 } }),
    ).toBe(false);
  });

  it('normalizes to top-left start .. bottom-right end regardless of drag direction', () => {
    const upward: Selection = { anchor: { flatRow: 5, col: 2 }, focus: { flatRow: 3, col: 8 } };
    expect(normalizeSelection(upward)).toEqual({
      start: { flatRow: 3, col: 8 },
      end: { flatRow: 5, col: 2 },
    });
    const sameRow: Selection = { anchor: { flatRow: 4, col: 9 }, focus: { flatRow: 4, col: 1 } };
    expect(normalizeSelection(sameRow)).toEqual({
      start: { flatRow: 4, col: 1 },
      end: { flatRow: 4, col: 9 },
    });
  });
});

describe('rowSpan', () => {
  const multi: Selection = { anchor: { flatRow: 2, col: 4 }, focus: { flatRow: 5, col: 3 } };

  it('is character-precise on the first and last rows, full-width in between', () => {
    expect(rowSpan(multi, 2, 20)).toEqual({ start: 4, end: 20 }); // first row: col4 -> end
    expect(rowSpan(multi, 3, 20)).toEqual({ start: 0, end: 20 }); // middle: whole row
    expect(rowSpan(multi, 5, 20)).toEqual({ start: 0, end: 3 }); // last row: start -> col3
  });

  it('returns null outside the selected rows', () => {
    expect(rowSpan(multi, 1, 20)).toBeNull();
    expect(rowSpan(multi, 6, 20)).toBeNull();
  });

  it('clamps to the row width and returns null for an empty span', () => {
    const single: Selection = { anchor: { flatRow: 1, col: 3 }, focus: { flatRow: 1, col: 100 } };
    expect(rowSpan(single, 1, 10)).toEqual({ start: 3, end: 10 }); // end clamped to width
    const zero: Selection = { anchor: { flatRow: 1, col: 5 }, focus: { flatRow: 1, col: 5 } };
    expect(rowSpan(zero, 1, 10)).toBeNull();
  });
});

describe('selectionText', () => {
  const rows = ['[api] hello world', '[api] second line', '[api] third line'];
  const rowAt = (flatRow: number) => rows[flatRow] ?? '';

  it('copies a character-precise slice of a single row', () => {
    const sel: Selection = { anchor: { flatRow: 0, col: 6 }, focus: { flatRow: 0, col: 11 } };
    expect(selectionText(sel, rowAt)).toBe('hello');
  });

  it('copies first-row-tail, whole middle rows, and last-row-head across a multi-row drag', () => {
    const sel: Selection = { anchor: { flatRow: 0, col: 6 }, focus: { flatRow: 2, col: 5 } };
    expect(selectionText(sel, rowAt)).toBe('hello world\n[api] second line\n[api]');
  });

  it('strips ANSI colors from the copied text (WYSIWYG plain glyphs)', () => {
    const colored = (flatRow: number) => [red('[api]') + ' hello'][flatRow] ?? '';
    const sel: Selection = { anchor: { flatRow: 0, col: 0 }, focus: { flatRow: 0, col: 11 } };
    expect(selectionText(sel, colored)).toBe('[api] hello');
  });

  it('slices by display column with wide (2-cell) glyphs', () => {
    const wide = (flatRow: number) => ['a世b'][flatRow] ?? '';
    // '世' occupies columns [1,3); selecting [1,3) yields just it.
    const sel: Selection = { anchor: { flatRow: 0, col: 1 }, focus: { flatRow: 0, col: 3 } };
    expect(selectionText(sel, wide)).toBe('世');
  });
});

describe('highlightParts', () => {
  it('keeps color on pre/post and strips it from the inverted middle', () => {
    const row = red('hello') + ' world';
    const { pre, mid, post } = highlightParts(row, { start: 2, end: 7 });
    expect(pre).toContain(`${ESC}[31m`); // colored pre
    expect(mid).toBe('llo w'); // plain middle
    expect(post.includes(ESC)).toBe(false); // ' world' had no active color
    expect(post).toContain('orld');
  });
});

describe('viewportRowIndex', () => {
  it('maps terminal rows directly when the pane is full (no blank padding)', () => {
    // topHeight=1, so the pane starts at terminal row 2; buffer fills the pane.
    expect(viewportRowIndex(2, 1, 10, 10)).toBe(0);
    expect(viewportRowIndex(11, 1, 10, 10)).toBe(9);
  });

  it('accounts for bottom-alignment when the buffer is shorter than the pane', () => {
    // paneHeight=10 but only 3 rendered rows -> 7 blank rows on top; content at
    // terminal rows 9,10,11 (topHeight=1 -> pane rows 2..11, blankTop=7).
    expect(viewportRowIndex(9, 1, 10, 3)).toBe(0);
    expect(viewportRowIndex(11, 1, 10, 3)).toBe(2);
    expect(viewportRowIndex(2, 1, 10, 3)).toBe(-7); // above the content (caller clamps)
  });
});

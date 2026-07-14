/**
 * Pure geometry + text math for the log viewport's app-managed selection.
 *
 * A selection is two {@link Point}s in the viewport's **flat rendered-row space**
 * (the same coordinate space {@link computeWindow} works in): row 0 is the first
 * rendered row of the whole visible buffer, and a row keeps its index as newer
 * output is appended below it. Anchoring to that space — rather than to screen
 * coordinates — is what lets a selection survive scrolling and incoming logs,
 * which is exactly what native terminal selection cannot do under our in-place
 * repaints.
 *
 * `col` is a 0-based **display column** within a rendered row (wide glyphs count
 * as two), matching how {@link sliceAnsi} measures.
 */
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import { stripAnsi } from './lib.js';

export type Point = { flatRow: number; col: number };
/** `anchor` is where the drag began; `focus` is the current end. Either order. */
export type Selection = { anchor: Point; focus: Point };
/** A half-open display-column range `[start, end)` to highlight on one row. */
export type Span = { start: number; end: number };

function comparePoints(a: Point, b: Point): number {
  return a.flatRow !== b.flatRow ? a.flatRow - b.flatRow : a.col - b.col;
}

/** True when anchor and focus coincide (a click with no drag — nothing selected). */
export function isEmptySelection(sel: Selection): boolean {
  return comparePoints(sel.anchor, sel.focus) === 0;
}

/** The selection as top-left `start` .. bottom-right `end`, regardless of drag direction. */
export function normalizeSelection(sel: Selection): { start: Point; end: Point } {
  return comparePoints(sel.anchor, sel.focus) <= 0
    ? { start: sel.anchor, end: sel.focus }
    : { start: sel.focus, end: sel.anchor };
}

/**
 * The display-column span to highlight on the rendered row at `flatRow`, or null
 * if that row is outside the selection or the span is empty. Character-precise on
 * the selection's first and last rows; the full row width in between.
 */
export function rowSpan(sel: Selection, flatRow: number, rowWidth: number): Span | null {
  const { start, end } = normalizeSelection(sel);
  if (flatRow < start.flatRow || flatRow > end.flatRow) {
    return null;
  }
  const a = Math.max(0, Math.min(flatRow === start.flatRow ? start.col : 0, rowWidth));
  const b = Math.max(0, Math.min(flatRow === end.flatRow ? end.col : rowWidth, rowWidth));
  return b > a ? { start: a, end: b } : null;
}

/**
 * The selected text, WYSIWYG: for each row the selection covers, the
 * ANSI-stripped glyphs within the selected columns, joined by newlines. `rowAt`
 * returns the rendered (possibly ANSI-colored) row for a flat row index.
 */
export function selectionText(sel: Selection, rowAt: (flatRow: number) => string): string {
  const { start, end } = normalizeSelection(sel);
  const lines: string[] = [];
  for (let r = start.flatRow; r <= end.flatRow; r++) {
    const raw = rowAt(r);
    const a = r === start.flatRow ? start.col : 0;
    const sliced = r === end.flatRow ? sliceAnsi(raw, a, end.col) : sliceAnsi(raw, a);
    lines.push(stripAnsi(sliced));
  }
  return lines.join('\n');
}

/** Split a rendered row for highlighting: colored `pre`/`post`, plain (ANSI-stripped) `mid`. */
export function highlightParts(
  row: string,
  span: Span,
): { pre: string; mid: string; post: string } {
  return {
    pre: sliceAnsi(row, 0, span.start),
    mid: stripAnsi(sliceAnsi(row, span.start, span.end)),
    post: sliceAnsi(row, span.end),
  };
}

/** Display width of a rendered row (ANSI-aware, via string-width). */
export function rowWidth(row: string): number {
  return stringWidth(row);
}

/**
 * Map a 1-based terminal row to an index into the bottom-aligned rendered rows of
 * the log pane. The pane starts at terminal row `topHeight + 1`; when the buffer
 * is shorter than the pane, the rendered rows sit flush at the bottom with blank
 * rows above. The result may be out of range — callers clamp into `[0, count)`.
 */
export function viewportRowIndex(
  terminalRow: number,
  topHeight: number,
  paneHeight: number,
  renderedCount: number,
): number {
  const blankTop = Math.max(0, paneHeight - renderedCount);
  return terminalRow - (topHeight + 1) - blankTop;
}

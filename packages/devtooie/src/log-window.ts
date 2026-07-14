/**
 * Variable-height virtualization for the log viewport, anchored at the bottom.
 *
 * Given the rendered-row count of every buffered line, the pane height, and how
 * far the view is scrolled up from the newest output, this returns just the
 * slice of lines that intersect the visible window (plus how many rendered rows
 * of the first/last line spill past the top/bottom edges). The caller renders
 * only that slice — never the whole buffer — which is what keeps a huge log cheap
 * to draw, the same idea as a windowed/virtualized list on the web.
 *
 * `scrollOffset` is measured in rendered rows from the bottom: `0` follows the
 * newest output; `maxScroll` pins the very top.
 */
export type LogWindow = {
  /** First visible line (inclusive). */
  startIndex: number;
  /** Last visible line (exclusive). */
  endIndex: number;
  /** Rendered rows of the first visible line hidden above the top edge. */
  topClip: number;
  /** Rendered rows of the last visible line hidden below the bottom edge. */
  bottomClip: number;
  /** Total rendered rows across every line. */
  totalRows: number;
  /** Largest valid `scrollOffset` (rows of history above the viewport). */
  maxScroll: number;
};

export function computeWindow(
  rowCounts: readonly number[],
  paneHeight: number,
  scrollOffset: number,
): LogWindow {
  let totalRows = 0;
  for (const count of rowCounts) {
    totalRows += count;
  }

  const maxScroll = Math.max(0, totalRows - Math.max(0, paneHeight));

  if (totalRows === 0 || paneHeight <= 0) {
    return { startIndex: 0, endIndex: 0, topClip: 0, bottomClip: 0, totalRows, maxScroll };
  }

  const offset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const windowEnd = totalRows - offset; // exclusive bottom edge, in flat row space
  const windowStart = Math.max(0, windowEnd - paneHeight); // inclusive top edge

  let startIndex = 0;
  let endIndex = rowCounts.length;
  let topClip = 0;
  let bottomClip = 0;

  let cumulative = 0;
  for (let i = 0; i < rowCounts.length; i++) {
    const next = cumulative + rowCounts[i]!;
    // The line whose row-range contains the top edge.
    if (cumulative <= windowStart && windowStart < next) {
      startIndex = i;
      topClip = windowStart - cumulative;
    }
    // The line whose row-range contains the last visible row (windowEnd - 1).
    if (cumulative < windowEnd && windowEnd <= next) {
      endIndex = i + 1;
      bottomClip = next - windowEnd;
    }
    cumulative = next;
  }

  return { startIndex, endIndex, topClip, bottomClip, totalRows, maxScroll };
}

/**
 * Flattens the windowed lines into exactly the rendered rows that fit the pane,
 * clipping the partially-visible first/last lines. `wrap` turns a line into its
 * rendered rows (called only for the handful of lines actually on screen).
 */
export function windowRows<T>(
  lines: readonly T[],
  window: LogWindow,
  wrap: (line: T) => readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = window.startIndex; i < window.endIndex; i++) {
    const rows = wrap(lines[i]!);
    const from = i === window.startIndex ? window.topClip : 0;
    const to = i === window.endIndex - 1 ? rows.length - window.bottomClip : rows.length;
    for (let r = from; r < to; r++) {
      out.push(rows[r]!);
    }
  }
  return out;
}

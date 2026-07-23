import { Box, Text } from 'ink';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { copyToClipboard } from '../clipboard.js';
import { computeWindow, windowRows } from '../log-window.js';
import type { MouseReport } from '../mouse.js';
import type { ProcessManager } from '../process-manager.js';
import {
  highlightParts,
  isEmptySelection,
  rowSpan,
  rowWidth,
  selectionText,
  viewportRowIndex,
  type Selection,
  type Span,
} from '../selection.js';
import {
  FOLLOWING,
  isFollowing,
  onContentResized,
  scroll as scrollByRows,
  scrollToBottom,
  scrollToTop,
  type Scroll,
} from '../scroll.js';

export type LogViewport = {
  /** Exactly the rendered rows that fit the pane — never more than `height`. */
  rows: string[];
  /** Flat-row index of the first rendered row (row 0 = oldest row of the whole buffer). */
  firstVisibleFlatRow: number;
  /** Whether the view is pinned to the newest output. */
  following: boolean;
  /** Rendered rows of newer output hidden below the viewport (0 while following). */
  hiddenBelow: number;
  /** Rendered rows of older output hidden above the viewport (0 when the buffer fits). */
  hiddenAbove: number;
  /** Scroll by whole rows: positive toward older output, negative toward newest. */
  scrollLines: (delta: number) => void;
  /** Scroll by pages (a page is one viewport minus a row of overlap). */
  scrollPages: (delta: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
};

/**
 * A windowed (virtualized) view over a {@link ProcessManager}'s log buffer.
 *
 * It subscribes to the buffer, holds a scroll position, and materializes **only**
 * the rendered rows that fit the pane — so a 50k-line buffer costs the same to
 * draw as a 50-line one. Row counts are memoized per line on the manager, and
 * only the handful of on-screen lines are ever wrapped into strings.
 */
export function useLogViewport(
  manager: ProcessManager,
  width: number,
  height: number,
): LogViewport {
  const version = useSyncExternalStore(
    useCallback((onChange) => manager.subscribe(onChange), [manager]),
    () => manager.getVersion(),
    () => manager.getVersion(),
  );

  const [scroll, setScroll] = useState<Scroll>(FOLLOWING);

  const { rows, totalRows, maxScroll, firstVisibleFlatRow } = useMemo(() => {
    const lines = manager.getVisibleLines();
    const rowCounts = lines.map((line) => manager.countRows(line, width));
    const win = computeWindow(rowCounts, height, scroll.offset);
    const rendered = windowRows(lines, win, (line) => manager.wrapLine(line, width));
    // First on-screen flat row = bottom edge (totalRows - clamped offset) minus
    // however many rows we actually rendered. Stable under appends, which is what
    // lets a content-anchored selection ride along as new output arrives.
    const clampedOffset = Math.min(Math.max(0, scroll.offset), win.maxScroll);
    const firstVisible = win.totalRows - clampedOffset - rendered.length;
    return {
      rows: rendered,
      totalRows: win.totalRows,
      maxScroll: win.maxScroll,
      firstVisibleFlatRow: firstVisible,
    };
    // `version` is the buffer-change signal: getVisibleLines/countRows read
    // mutable manager state that only changes when the version bumps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, version, width, height, scroll.offset]);

  // Keep a scrolled-up view pinned to the same content as the buffer grows or
  // shrinks; stay following at the bottom otherwise.
  const prevTotalRef = useRef(totalRows);
  useEffect(() => {
    const delta = totalRows - prevTotalRef.current;
    prevTotalRef.current = totalRows;
    if (delta !== 0) {
      setScroll((current) => onContentResized(current, delta, maxScroll));
    }
  }, [totalRows, maxScroll]);

  const scrollLines = useCallback(
    (delta: number) => setScroll((current) => scrollByRows(current, delta, maxScroll)),
    [maxScroll],
  );
  const scrollPages = useCallback(
    (delta: number) =>
      setScroll((current) => scrollByRows(current, delta * Math.max(1, height - 1), maxScroll)),
    [maxScroll, height],
  );
  const toTop = useCallback(() => {
    setScroll(scrollToTop(maxScroll));
  }, [maxScroll]);
  const toBottom = useCallback(() => {
    setScroll(scrollToBottom());
  }, []);

  return {
    rows,
    firstVisibleFlatRow,
    following: isFollowing(scroll),
    hiddenBelow: scroll.offset,
    hiddenAbove: Math.max(0, maxScroll - scroll.offset),
    scrollLines,
    scrollPages,
    scrollToTop: toTop,
    scrollToBottom: toBottom,
  };
}

/** A pointer (non-wheel) mouse report — what {@link useDragSelection} consumes. */
type PointerReport = Extract<MouseReport, { type: 'down' | 'move' | 'up' }>;

export type DragSelection = {
  /** Per-visible-row highlight spans, aligned to `viewport.rows` (null = no highlight). */
  highlights: (Span | null)[];
  /** Transient footer flash message (e.g. "copied N chars"), null when idle. */
  copiedNotice: string | null;
  /** Feed a pointer (press/drag/release) mouse report; maps it and updates the selection. */
  onMouse: (report: PointerReport) => void;
  /** Copy `text` to the clipboard and flash `label` in the footer, on the same linger timer as a drag-copy. For footer click-to-copy affordances (e.g. the logfile path). */
  flashCopy: (text: string, label: string) => void;
  /** Drop any current selection (`esc`, filter change, resize, `k` — not scrolling); returns whether one was cleared. */
  clear: () => boolean;
};

/** How long the highlight and the "copied N chars" flash linger after a copy-on-select, before both clear. */
const SELECTION_LINGER_MS = 5000;

/**
 * App-managed drag-to-select over the log viewport. The selection is anchored to
 * flat-row/column content coordinates (see {@link selection.ts}), so it survives
 * scrolling and incoming logs — the two things native terminal selection can't
 * survive under our in-place repaints. Releasing a non-empty drag copies the
 * selection to the clipboard immediately (copy-on-select — no key press, since the
 * VS Code integrated terminal swallows Cmd+C before it reaches us); the highlight
 * and the "copied" flash then linger together for {@link SELECTION_LINGER_MS}
 * before clearing.
 *
 * The live selection lives in a ref (not state) so a burst of move+release events
 * arriving in a single read all see each other's updates synchronously; a reducer
 * bump forces the re-render that repaints the highlight.
 */
export function useDragSelection(opts: {
  rows: readonly string[];
  firstVisibleFlatRow: number;
  topHeight: number;
  paneHeight: number;
}): DragSelection {
  const { rows, firstVisibleFlatRow, topHeight, paneHeight } = opts;

  const selectionRef = useRef<Selection | null>(null);
  const draggingRef = useRef(false);
  // The selected text, captured on release (while it's fully on screen) so the
  // copy-on-select grabs exactly that even after the highlight scrolls with logs.
  const pendingTextRef = useRef<string | null>(null);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  // A single timer drives the post-copy linger: SELECTION_LINGER_MS after a
  // copy it drops the highlight and the flash together.
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelLinger = useCallback(() => {
    if (lingerTimer.current) {
      clearTimeout(lingerTimer.current);
      lingerTimer.current = null;
    }
  }, []);

  const clear = useCallback((): boolean => {
    cancelLinger();
    if (selectionRef.current !== null || draggingRef.current) {
      selectionRef.current = null;
      draggingRef.current = false;
      pendingTextRef.current = null;
      setCopiedNotice(null);
      forceRender();
      return true;
    }
    return false;
  }, [cancelLinger]);

  // Copy `text` and flash `label` in the footer, keeping any current highlight up —
  // the linger timer clears the flash (and any selection) after 5s. No deselect here
  // (unlike an explicit `clear`): the highlight lingering briefly is the point, it
  // shows you what was copied. Shared by drag-release copy and footer click-to-copy.
  const flashCopy = useCallback(
    (text: string, label: string) => {
      copyToClipboard(text);
      setCopiedNotice(label);
      cancelLinger();
      lingerTimer.current = setTimeout(() => {
        lingerTimer.current = null;
        selectionRef.current = null;
        draggingRef.current = false;
        pendingTextRef.current = null;
        setCopiedNotice(null);
        forceRender();
      }, SELECTION_LINGER_MS);
    },
    [cancelLinger],
  );

  const onMouse = (report: PointerReport) => {
    if (rows.length === 0) {
      return;
    }
    const rawIndex = viewportRowIndex(report.row, topHeight, paneHeight, rows.length);
    const index = Math.max(0, Math.min(rawIndex, rows.length - 1));
    const col = Math.max(0, Math.min(report.col - 1, rowWidth(rows[index]!)));
    const point = { flatRow: firstVisibleFlatRow + index, col };

    if (report.type === 'down') {
      // Only clicks inside the pane start a selection — a press on the top
      // indicator or the footer (e.g. reaching for a footer link) must not.
      const inPane = report.row > topHeight && report.row <= topHeight + paneHeight;
      if (!inPane) {
        return;
      }
      // A fresh selection cancels any pending post-copy linger (so a stale 5s
      // callback can't wipe the new selection) and drops the previous flash.
      cancelLinger();
      setCopiedNotice(null);
      selectionRef.current = { anchor: point, focus: point };
      draggingRef.current = true;
      pendingTextRef.current = null;
      forceRender();
      return;
    }

    if (!draggingRef.current || !selectionRef.current) {
      return;
    }

    selectionRef.current = { anchor: selectionRef.current.anchor, focus: point };

    if (report.type === 'up') {
      draggingRef.current = false;
      const selection = selectionRef.current;
      if (isEmptySelection(selection)) {
        selectionRef.current = null; // a plain click clears the selection
        pendingTextRef.current = null;
      } else {
        // Capture the text now (fully on screen), then copy it immediately.
        const text = selectionText(
          selection,
          (flatRow) => rows[flatRow - firstVisibleFlatRow] ?? '',
        );
        pendingTextRef.current = text.length > 0 ? text : null;
        if (pendingTextRef.current) {
          const chars = pendingTextRef.current.length;
          flashCopy(pendingTextRef.current, `copied ${chars} char${chars === 1 ? '' : 's'}`);
        }
      }
    }
    forceRender();
  };

  useEffect(
    () => () => {
      if (lingerTimer.current) {
        clearTimeout(lingerTimer.current);
      }
    },
    [],
  );

  const selection = selectionRef.current;
  const highlights = rows.map((row, i) =>
    selection ? rowSpan(selection, firstVisibleFlatRow + i, rowWidth(row)) : null,
  );
  return { highlights, copiedNotice, onMouse, flashCopy, clear };
}

/** One rendered row with a selection highlight: colored pre/post, inverted (plain) middle. */
function HighlightedRow({ row, span }: { row: string; span: Span }) {
  const { pre, mid, post } = highlightParts(row, span);
  return (
    <Text wrap="truncate-end">
      {pre}
      <Text inverse>{mid}</Text>
      {post}
    </Text>
  );
}

/**
 * Presentational log viewport: renders the pre-windowed rows bottom-aligned (so
 * the newest output sits just above the footer). Rows are already wrapped to the
 * terminal width, so each is truncated rather than re-wrapped by Ink. Rows the
 * selection covers get a `highlights` span rendered as an inverted range.
 */
export function LogPane({
  rows,
  highlights,
}: {
  rows: readonly string[];
  highlights?: readonly (Span | null)[];
}) {
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
      {rows.map((row, i) => {
        const span = highlights?.[i] ?? null;
        // The whole window re-renders together, so positional keys are fine here.
        return span ? (
          <HighlightedRow key={i} row={row} span={span} />
        ) : (
          <Text key={i} wrap="truncate-end">
            {row}
          </Text>
        );
      })}
    </Box>
  );
}

import { Box, Text } from 'ink';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { computeWindow, windowRows } from '../log-window.js';
import type { ProcessManager } from '../process-manager.js';
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

  const { rows, totalRows, maxScroll } = useMemo(() => {
    const lines = manager.getVisibleLines();
    const rowCounts = lines.map((line) => manager.countRows(line, width));
    const win = computeWindow(rowCounts, height, scroll.offset);
    const rendered = windowRows(lines, win, (line) => manager.wrapLine(line, width));
    return { rows: rendered, totalRows: win.totalRows, maxScroll: win.maxScroll };
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
    following: isFollowing(scroll),
    hiddenBelow: scroll.offset,
    hiddenAbove: Math.max(0, maxScroll - scroll.offset),
    scrollLines,
    scrollPages,
    scrollToTop: toTop,
    scrollToBottom: toBottom,
  };
}

/**
 * Presentational log viewport: renders the pre-windowed rows bottom-aligned (so
 * the newest output sits just above the footer). Rows are already wrapped to the
 * terminal width, so each is truncated rather than re-wrapped by Ink.
 */
export function LogPane({ rows }: { rows: readonly string[] }) {
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
      {rows.map((row, i) => (
        // The whole window re-renders together, so positional keys are fine here.
        <Text key={i} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  );
}

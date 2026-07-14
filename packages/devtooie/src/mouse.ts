/**
 * Mouse handling for the fullscreen TUI: SGR mouse reporting, so we can drive an
 * app-managed drag-to-select-and-copy. The terminal's own text selection can't
 * survive our in-place repaints (scrolling and new log lines rewrite the cells
 * under the highlight), so we replace it with a selection anchored to the log
 * content — see docs/architecture/rendering.md.
 *
 * We enable button-event tracking (`?1002h` — reports press, drag-motion while a
 * button is held, and release) with SGR extended coordinates (`?1006h` — 1-based,
 * and free of the legacy 223-column cap). The mouse wheel arrives as button 64
 * (up) / 65 (down). Enabling reporting means the terminal no longer runs its own
 * click-drag selection; ours replaces it (power users can hold Option/Alt in most
 * terminals to force native selection). Both modes MUST be disabled on teardown,
 * or the terminal is left capturing the mouse.
 */
const ESC = String.fromCharCode(27);

/** Enable SGR mouse reporting (button-event tracking + SGR coords). Write on mount. */
export const MOUSE_ENABLE = `${ESC}[?1002h${ESC}[?1006h`;
/** Disable SGR mouse reporting. Write on unmount / before exit. */
export const MOUSE_DISABLE = `${ESC}[?1006l${ESC}[?1002l`;

/** A decoded SGR mouse report. Coordinates are 1-based terminal cells. */
export type MouseReport =
  | { type: 'down' | 'up' | 'move'; button: number; col: number; row: number }
  | { type: 'wheel'; dir: 'up' | 'down'; col: number; row: number };

// SGR mouse report: (ESC)[<Cb;Cx;Cy(M|m). The leading ESC is optional so this
// still matches when the input layer has already stripped it.
// eslint-disable-next-line no-control-regex -- matches SGR mouse-report escape sequences
const SGR_MOUSE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

/** True if `data` contains at least one SGR mouse report. */
export function isMouseSequence(data: string): boolean {
  SGR_MOUSE.lastIndex = 0;
  return SGR_MOUSE.test(data);
}

/**
 * Decode every SGR mouse report in `data`, in order (a fast drag can pack several
 * into one read). Non-mouse bytes are ignored.
 *
 * The button byte `Cb` encodes: the low two bits are the button (0 = left), bit
 * 5 (32) marks drag-motion, bits 6–7 (64) mark the wheel (64 = up, 65 = down),
 * and the final `M`/`m` distinguishes press-or-motion from release.
 */
export function parseMouseEvents(data: string): MouseReport[] {
  const events: MouseReport[] = [];
  SGR_MOUSE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE.exec(data)) !== null) {
    const cb = Number(match[1]);
    const col = Number(match[2]);
    const row = Number(match[3]);
    const release = match[4] === 'm';
    if (cb & 64) {
      events.push({ type: 'wheel', dir: cb & 1 ? 'down' : 'up', col, row });
    } else if (release) {
      events.push({ type: 'up', button: cb & 3, col, row });
    } else if (cb & 32) {
      events.push({ type: 'move', button: cb & 3, col, row });
    } else {
      events.push({ type: 'down', button: cb & 3, col, row });
    }
  }
  return events;
}

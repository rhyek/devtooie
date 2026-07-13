/**
 * Mouse-wheel scrolling for the fullscreen TUI, via the terminal's
 * **alternate-scroll mode** (DECSET 1007).
 *
 * We deliberately do NOT enable mouse *reporting* (`?1000h`): that would make the
 * terminal capture clicks and drags, breaking native click-drag text selection —
 * which is essential for copying log lines out of the TUI. Alternate-scroll mode
 * instead asks the terminal to translate wheel events into arrow-key presses
 * while in the alternate screen (the same trick `less`/`vim` use), so the wheel
 * scrolls the log viewport (bound to Up/Down) AND the mouse still selects text
 * normally. Terminals that don't support it simply ignore it — keyboard scrolling
 * still works and selection is unaffected.
 */
const ESC = String.fromCharCode(27);

/** Enable alternate-scroll mode (wheel → arrow keys). Write to stdout on mount. */
export const ALT_SCROLL_ENABLE = `${ESC}[?1007h`;
/** Disable alternate-scroll mode. Write on unmount. */
export const ALT_SCROLL_DISABLE = `${ESC}[?1007l`;

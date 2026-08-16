/**
 * Every color devtooie paints its own interface with, in one place.
 *
 * Constants here are **values, not styling**: a color spec, never a chalk formatter
 * or an Ink element. Callers decide how to apply one (Ink's `color=` prop, a
 * `chalk.hex(...)` call, bold or not), which keeps this file free of both React and
 * chalk and makes the whole palette readable at a glance.
 *
 * Two things deliberately live elsewhere:
 *
 * - **Which role a thing plays** — e.g. that a `starting` package is "warning". Those
 *   mappings sit next to the type they describe (`STATUS_COLORS` in `NativeRunner`),
 *   so this file answers "what color is that?" and never "what does it mean?".
 * - **The allowlist of color names a user may set** via a package's `color:` option
 *   (`NAMED_COLORS` in `process-manager.ts`). That's input validation over chalk's
 *   surface, not part of devtooie's palette.
 */

/** An Ink/chalk color: a name (`'cyan'`) or a hex string (`'#58a6ff'`). */
export type Color = string;

// ---------------------------------------------------------------------------
// Roles — the basic vocabulary the UI is drawn in.
// ---------------------------------------------------------------------------

/** Headings, labels, banners, and the active row in the package selector. */
export const ACCENT_COLOR: Color = 'cyan';
/** Text drawn *on top of* `ACCENT_COLOR` as a background (the phase banners). */
export const ON_ACCENT_COLOR: Color = 'black';
/** Success, and the values beside a label (`cwd:`, `git:`). */
export const OK_COLOR: Color = 'green';
/** In-progress and advisory states. */
export const WARN_COLOR: Color = 'yellow';
/** Failures. */
export const DANGER_COLOR: Color = 'red';
/** De-emphasized text that is still content, not chrome. */
export const MUTED_COLOR: Color = 'gray';

// ---------------------------------------------------------------------------
// Footer affordances
// ---------------------------------------------------------------------------

/**
 * An informational toast — "copied N chars to clipboard" is the archetype (see
 * `TONE_COLORS` in `components/ToastStack.tsx`). A warm yellow-orange: it has to
 * carry no alarm (it's good news) while staying legible against a wall of log
 * text, and it must not read as any of the basic-ANSI status colors, since
 * green/cyan/yellow/red/gray all mean something about a package (and green is also
 * the git branch). Truecolor rather than a color name for exactly that reason —
 * it sits beside plain `yellow`, not on it. Never bold.
 *
 * Hue ~39°: amber, between orange (30°) and yellow (60°). Tuned by moving the green
 * channel alone, so saturation and brightness are untouched and the shift reads as
 * hue rather than as a different-intensity color.
 */
export const NOTICE_COLOR: Color = '#ffbc40';

/**
 * Whatever the cursor is on: the selected row in the commands menu, and the border
 * devtooie draws around that mode. Deliberately the same value as
 * {@link NOTICE_COLOR} — devtooie speaks in one warm accent, whether it's telling
 * you something or showing you where you are — but a separate name, because the two
 * answer different questions and only one of them is about the cursor. (Declared
 * after it for that reason: this one follows.)
 *
 * Not bold: the color alone carries it, and the `❯` marker already says which row.
 * The footer's selected package is marked differently again — by weight and an
 * underline, no color — since every hue down there already means something.
 */
export const FOCUS_COLOR: Color = NOTICE_COLOR;

/**
 * Every clickable affordance: the footer's URL links, the ⧉ copy glyph, and the
 * ↓ indicator's "Click here". A brighter blue than Ink's default, which is too dark
 * to read on a dark background.
 */
export const LINK_COLOR: Color = '#58a6ff';

/** The key in a `key: label` hotkey hint — brightest, since it's what you press. */
export const HOTKEY_KEY_COLOR: Color = 'white';
/** The label after a hotkey's key: readable, but a step down from the key itself. */
export const HOTKEY_LABEL_COLOR: Color = '#bbbbbb';

// ---------------------------------------------------------------------------
// Log prefixes
// ---------------------------------------------------------------------------

/**
 * devtooie's own log channels (`[devtooie]`, `[dt:control]`) — a warm gold that reads
 * as the tool's own voice, distinct from the per-package prefix colors.
 */
export const DEVTOOIE_LABEL_COLOR: Color = '#d7af5f';

/**
 * Package-identity colors for log prefixes, ordered so adjacent packages land far
 * apart on the color wheel. Vivid truecolor shades — deliberately distinct from the
 * dull basic-ANSI colors the status text and dots use — and no pink or pastels.
 */
export const PACKAGE_PALETTE: readonly Color[] = [
  '#4C9AFF', // blue
  '#22C3C3', // teal
  '#7A6FFF', // periwinkle
  '#FFC53D', // gold
  '#E04262', // crimson
  '#32CD32', // green
  '#A56EFF', // purple
  '#FF8C00', // orange
  '#FFDC5C', // yellow
  '#C77DFF', // violet
];

// ---------------------------------------------------------------------------
// Structured-log formatting
// ---------------------------------------------------------------------------

/**
 * The bracketed `[LEVEL]` token of a recognized level. Unknown levels stay uncolored.
 * `FATAL` shares `ERROR`'s red and is distinguished by bold at the point of use.
 */
export const LOG_LEVEL_COLORS = {
  TRACE: 'gray',
  DEBUG: 'cyan',
  INFO: 'green',
  WARN: 'yellow',
  ERROR: 'red',
  FATAL: 'red',
} as const;

/**
 * The `key` of a rendered `key: value` property line — muted so it reads as a label
 * and the value (the data) stands out in the normal foreground.
 */
export const LOG_PROPERTY_KEY_COLOR = 'gray' as const;

import path from 'node:path';
import {
  createElement as h,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactElement,
} from 'react';
// Internal tool for choosing `PACKAGE_PALETTE` (`src/colors.ts`): a mock of the run screen —
// log rows with `[name]` prefixes above the footer — that you page through candidate palettes on.
//
//   ← →   previous / next palette (→ past the last one generates a new one)
//   ↑ ↓   more / fewer services (1–7)
//   click a color in the top bar to lock it, again to unlock it
//   r     re-roll the unlocked colors, as a new palette right after this one (← goes back to it)
//   s     shuffle the current palette's order
//   q     quit, printing the current palette as a paste-ready `PACKAGE_PALETTE`
//
// It is a mock rather than the real `NativeRunner` for two reasons: the real screen already binds
// ←/→, `r` and `s`, and this runs directly via Node's TypeScript support (no build needed), which
// can load neither `.tsx` nor the `./x.js` specifiers the sources import each other by. `colors.ts`
// and `mouse.ts` import nothing, so everything on screen that is *not* the palette still uses the
// real constants, and clicks are decoded by the real parser.
import chalk from 'chalk';
import { Box, Text, render, useApp, useInput, useStdin, useWindowSize, type DOMElement } from 'ink';
import {
  ACCENT_COLOR,
  DANGER_COLOR,
  DEVTOOIE_LABEL_COLOR,
  HOTKEY_KEY_COLOR,
  HOTKEY_LABEL_COLOR,
  LINK_COLOR,
  LOG_LEVEL_COLORS,
  LOG_PROPERTY_KEY_COLOR,
  MUTED_COLOR,
  OK_COLOR,
  PACKAGE_PALETTE,
  WARN_COLOR,
  type Color,
} from '../src/colors.ts';
import { MOUSE_DISABLE, MOUSE_ENABLE, createMouseDecoder, type MouseReport } from '../src/mouse.ts';

// ---------------------------------------------------------------------------
// Palette generation
// ---------------------------------------------------------------------------

/** Colors per palette — the real palette's size, so a pick can be pasted back as is. */
const PALETTE_SIZE = PACKAGE_PALETTE.length;

/**
 * The hue arc candidates are drawn from, in OKLCH degrees: red (15°) round through orange,
 * yellow, green, blue and purple (320°). The gap left out is magenta and pink — `colors.ts`
 * rules pink out of the package palette.
 */
const HUE_START = 15;
const HUE_SPAN = 305;

/** Below this chroma a color reads as a pastel, which `colors.ts` also rules out. */
const MIN_CHROMA = 0.12;

type Oklch = { l: number; c: number; h: number };

/** OKLCH → linear sRGB. Channels fall outside `[0, 1]` when the color is out of gamut. */
function toLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

function inGamut(color: Oklch): boolean {
  return toLinearRgb(color).every((v) => v >= -0.0005 && v <= 1.0005);
}

function toHex(color: Oklch): Color {
  const channels = toLinearRgb(color).map((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('').toUpperCase()}`;
}

/** sRGB hex → OKLCH, the inverse of {@link toHex}: how a color that is already settled is measured. */
function fromHex(hex: Color): Oklch {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lc = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mc = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sc = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc;
  const bAxis = 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc;
  return {
    l: 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc,
    c: Math.hypot(a, bAxis),
    h: ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360,
  };
}

/**
 * The lightness a hue is drawn at, given the palette's base lightness. Two hue ranges only look
 * like themselves in a narrow band, whatever the rest of the palette does: a light red is pink
 * (salmon), and a dark yellow or orange is olive or brown.
 */
function lightnessFor(hue: number, base: number): number {
  if (hue < 45) {
    return Math.min(base, 0.64);
  }
  if (hue < 75) {
    return Math.max(base, 0.74);
  }
  if (hue < 120) {
    return Math.max(base, 0.84);
  }
  return base;
}

/** The most chroma, up to `color.c`, that still fits sRGB at this lightness and hue. */
function chromaInGamut(color: Oklch): number {
  for (let c = color.c; c > 0; c -= 0.005) {
    if (inGamut({ ...color, c })) {
      return c;
    }
  }
  return 0;
}

/**
 * Fit a color into sRGB by giving up chroma — and, when that would wash it out to a pastel, by
 * moving its lightness instead, to the nearest one where the hue has chroma to offer. Which way
 * that is depends on the hue: a blue is at its most vivid darker than a cyan or a green is.
 */
function fitToGamut(color: Oklch): Oklch {
  let best = { ...color, c: 0 };
  for (let shift = 0; shift <= 0.2; shift += 0.02) {
    for (const l of [color.l - shift, color.l + shift]) {
      const candidate = { ...color, l, c: chromaInGamut({ ...color, l }) };
      if (candidate.c >= MIN_CHROMA) {
        return candidate;
      }
      if (candidate.c > best.c) {
        best = candidate;
      }
    }
  }
  return best;
}

/** Squared distance between two colors in OKLab, where equal distances look equally different. */
function distance(a: Oklch, b: Oklch): number {
  const ra = (a.h * Math.PI) / 180;
  const rb = (b.h * Math.PI) / 180;
  return (
    (a.l - b.l) ** 2 +
    (a.c * Math.cos(ra) - b.c * Math.cos(rb)) ** 2 +
    (a.c * Math.sin(ra) - b.c * Math.sin(rb)) ** 2
  );
}

/**
 * Pick `count` of `candidates`, each the one farthest from everything already settled: the
 * `fixed` colors, then the picks before it. So every prefix of the result is as spread out as it
 * can be — and a workspace of N packages wears the first N.
 */
function pickSpread(candidates: Oklch[], fixed: Oklch[], count: number): Oklch[] {
  const remaining = [...candidates];
  const picked: Oklch[] = [];
  if (fixed.length === 0) {
    // With nothing to stand apart from yet, any color is as good a start as another.
    picked.push(...remaining.splice(Math.floor(Math.random() * remaining.length), 1));
  }
  while (picked.length < count && remaining.length > 0) {
    const settled = [...fixed, ...picked];
    let best = 0;
    let bestDistance = -1;
    for (let i = 0; i < remaining.length; i++) {
      const nearest = Math.min(...settled.map((color) => distance(color, remaining[i]!)));
      if (nearest > bestDistance) {
        best = i;
        bestDistance = nearest;
      }
    }
    picked.push(...remaining.splice(best, 1));
  }
  return picked;
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Two colors closer than this (OKLab distance) are hard to tell apart as log prefixes. */
const MIN_DISTANCE = 0.06;

/** How near the nearest neighbor of any of `colors` is — among themselves and the `fixed` ones. */
function clearance(colors: Oklch[], fixed: Oklch[]): number {
  let closest = Infinity;
  colors.forEach((color, i) => {
    for (const other of [...fixed, ...colors.slice(i + 1)]) {
      closest = Math.min(closest, Math.sqrt(distance(color, other)));
    }
  });
  return closest;
}

/**
 * One draw of a palette's worth of colors: hues evenly spaced around the allowed arc from a
 * random start, each nudged off its slot, at one lightness and chroma for the whole draw — so
 * draws differ from each other in character (brighter, deeper, more or less saturated) while each
 * stays coherent.
 */
function drawColors(): Oklch[] {
  const lightness = between(0.66, 0.8);
  const chroma = between(0.14, 0.21);
  const step = HUE_SPAN / PALETTE_SIZE;
  const offset = Math.random() * step;
  return Array.from({ length: PALETTE_SIZE }, (_, i) => {
    const hue =
      HUE_START + ((offset + i * step + between(-0.25, 0.25) * step + HUE_SPAN) % HUE_SPAN);
    return fitToGamut({ l: lightnessFor(hue, lightness), c: chroma, h: hue });
  });
}

/**
 * `count` random colors to sit beside the `fixed` ones (none, for a whole new palette), taken
 * from one draw.
 *
 * Equal hue steps are not equal visual steps (the greens and cyans crowd together), and a draw
 * knows nothing of the fixed colors, so a pick that lands closer than {@link MIN_DISTANCE} to a
 * neighbor is thrown away and drawn again; the best of the attempts stands in if none clears it.
 */
function randomColors(count: number, fixed: Oklch[] = []): Oklch[] {
  let best: Oklch[] = [];
  let bestClearance = -1;
  for (let attempt = 0; attempt < 40 && bestClearance < MIN_DISTANCE; attempt++) {
    const picked = pickSpread(drawColors(), fixed, count);
    const pickedClearance = clearance(picked, fixed);
    if (pickedClearance > bestClearance) {
      best = picked;
      bestClearance = pickedClearance;
    }
  }
  return best;
}

/** One slot of a palette. A lock belongs to the color, not the slot: it moves with it under `s`. */
type Swatch = { color: Color; locked: boolean };

function randomPalette(): Swatch[] {
  return randomColors(PALETTE_SIZE).map((color) => ({ color: toHex(color), locked: false }));
}

/** Replace every unlocked color with a new random one that stands apart from the locked ones. */
function rerollUnlocked(palette: Swatch[]): Swatch[] {
  const locked = palette.filter((swatch) => swatch.locked).map((swatch) => fromHex(swatch.color));
  const fresh = randomColors(palette.length - locked.length, locked);
  let next = 0;
  return palette.map((swatch) =>
    swatch.locked ? swatch : { color: toHex(fresh[next++]!), locked: false },
  );
}

/** The same colors in a new order — one that changes at least one of the first `visible` slots. */
function reorder(palette: Swatch[], visible: number): Swatch[] {
  for (let attempt = 0; attempt < 50; attempt++) {
    const shuffled = [...palette];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    if (shuffled.slice(0, visible).some((swatch, i) => swatch.color !== palette[i]!.color)) {
      return shuffled;
    }
  }
  return palette;
}

// ---------------------------------------------------------------------------
// The mock session
// ---------------------------------------------------------------------------

type Status = 'stopped' | 'starting' | 'started' | 'unknown' | 'waiting';

/** Mirrors `STATUS_COLORS` in `NativeRunner`. */
const STATUS_COLORS: Record<Status, Color> = {
  stopped: DANGER_COLOR,
  starting: WARN_COLOR,
  started: OK_COLOR,
  unknown: MUTED_COLOR,
  waiting: ACCENT_COLOR,
};

type Service = { name: string; status: Status; url?: string };

/** In palette order: service `i` wears color `i`. Names vary in length to exercise the padding. */
const SERVICES: Service[] = [
  { name: 'api', status: 'started', url: 'http://localhost:4100' },
  { name: 'web', status: 'started', url: 'http://localhost:4101' },
  { name: 'worker', status: 'starting' },
  { name: 'gateway', status: 'started', url: 'http://localhost:4102' },
  { name: 'scheduler', status: 'waiting' },
  { name: 'auth', status: 'started' },
  { name: 'notifications', status: 'stopped' },
];

const DEFAULT_SERVICE_COUNT = 3;

type LogLine = {
  /** Index into {@link SERVICES}, or one of devtooie's own two channels. */
  source: number | 'devtooie' | 'dt:control';
  ts: string;
  /** The line after its prefix, already styled the way the run screen would style it. */
  text: string;
};

function level(name: keyof typeof LOG_LEVEL_COLORS): string {
  return chalk[LOG_LEVEL_COLORS[name]](`[${name}]`);
}

function property(key: string, value: string): string {
  return `  ${chalk[LOG_PROPERTY_KEY_COLOR](`${key}:`)} ${value}`;
}

/**
 * What a package prints, one entry per burst of lines. Covers every kind of text a prefix color
 * has to sit beside: plain output, structured logs at each level, red stderr, and devtooie's own
 * green/yellow/cyan status lines. Listed more than once where a kind should come up more often.
 */
const SERVICE_BURSTS: string[][] = [
  ['GET /todos 200 12ms'],
  ['GET /todos/42 200 8ms'],
  ['GET /health 200 1ms'],
  ['processed job send-digest in 184ms'],
  ['watching for file changes...'],
  ['POST /todos 201 31ms'],
  ['compiled successfully in 412ms'],
  ['SELECT * FROM todos WHERE id = $1'],
  [`${level('INFO')} request completed`, property('method', 'GET'), property('path', '/todos')],
  [`${level('INFO')} job finished`, property('job', 'send-digest'), property('durationMs', '184')],
  [`${level('DEBUG')} cache miss`, property('key', 'todos:42')],
  [`${level('TRACE')} poll`, property('queue', 'default')],
  [`${level('WARN')} slow query`, property('durationMs', '840')],
  [`${level('ERROR')} job failed`, property('job', 'send-digest'), property('attempt', '3')],
  [
    chalk.red('Error: connect ECONNREFUSED 127.0.0.1:4110'),
    chalk.red('    at TCPConnectWrap.afterConnect (node:net:1637:16)'),
  ],
  [chalk.yellow('rebuilding...'), chalk.green('rebuild complete')],
  [chalk.cyan('.env changed, restarting...'), chalk.green('restarted')],
  [
    chalk.cyan('▶ running: db:migrate'),
    'applied 2 migrations',
    chalk.green('✔ db:migrate finished'),
  ],
];

/** A small seeded PRNG (mulberry32), so a given service count always shows the same log. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOG_LENGTH = 300;
const logsByCount = new Map<number, LogLine[]>();

/**
 * The session's log for `count` services. It depends on nothing else — not the palette, not the
 * terminal size — so paging through palettes changes the colors and leaves every word in place.
 */
function mockLog(count: number): LogLine[] {
  const cached = logsByCount.get(count);
  if (cached) {
    return cached;
  }
  const random = seededRandom(count);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const lines: LogLine[] = [];
  let seconds = 14 * 3600 + 2 * 60 + 7;
  const emit = (source: LogLine['source'], texts: string[]) => {
    seconds += Math.floor(random() * 3);
    const clock = [seconds / 3600, (seconds / 60) % 60, seconds % 60]
      .map((part) => String(Math.floor(part)).padStart(2, '0'))
      .join(':');
    for (const text of texts) {
      lines.push({ source, ts: clock, text });
    }
  };

  const sources = Array.from({ length: count }, (_, i) => i);
  while (lines.length < LOG_LENGTH) {
    const roll = random();
    if (roll < 0.04) {
      emit('devtooie', [`${SERVICES[pick(sources)]!.name} is ready`]);
    } else if (roll < 0.07) {
      emit('dt:control', [`restart ${SERVICES[pick(sources)]!.name}`]);
    } else {
      emit(pick(sources), pick(SERVICE_BURSTS));
    }
  }
  // End on one line from every service, so each color is on screen however short the terminal.
  for (const source of sources) {
    emit(source, [pick(SERVICE_BURSTS)[0]!]);
  }
  logsByCount.set(count, lines);
  return lines;
}

/** One log row, built the way `ProcessManager` builds it: dim time, colored `[name]`, text. */
function renderLogLine(line: LogLine, palette: Swatch[], nameWidth: number): string {
  const prefix =
    typeof line.source === 'number'
      ? chalk.hex(palette[line.source]!.color)(`[${SERVICES[line.source]!.name.padEnd(nameWidth)}]`)
      : chalk.hex(DEVTOOIE_LABEL_COLOR)(`[${line.source.padEnd(nameWidth)}]`);
  return `${chalk.dim(line.ts)} ${prefix} ${line.text}`;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

type Hint =
  | { key: string; label: string; dim?: boolean }
  | { separator: true }
  | { header: string };

/** Mirrors the `HotkeyHints` component. */
function hotkeyHints(hints: Hint[]): ReactElement {
  return h(
    Box,
    { flexWrap: 'wrap', columnGap: 2, flexShrink: 0 },
    hints.map((hint, i) => {
      if ('separator' in hint) {
        return h(Text, { key: i, dimColor: true }, '│');
      }
      if ('header' in hint) {
        return h(Text, { key: i, dimColor: true }, `${hint.header}:`);
      }
      if (hint.dim) {
        return h(Text, { key: i, dimColor: true }, `${hint.key}: ${hint.label}`);
      }
      return h(
        Box,
        { key: i, flexShrink: 0 },
        h(Text, { color: HOTKEY_KEY_COLOR, bold: true }, hint.key),
        h(Text, { color: HOTKEY_LABEL_COLOR }, `: ${hint.label}`),
      );
    }),
  );
}

/** The run screen's footer, with the first service focused. */
function footer(services: Service[]): ReactElement {
  const linked = services.filter((service) => service.url);
  return h(
    Box,
    {
      borderStyle: 'single',
      borderColor: MUTED_COLOR,
      paddingX: 1,
      columnGap: 4,
      flexShrink: 0,
    },
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      hotkeyHints([
        { header: 'logs' },
        { key: 'c', label: 'clear' },
        { key: 'f', label: 'filter' },
        { separator: true },
        { key: '^c', label: 'quit' },
      ]),
      h(
        Box,
        { marginTop: 1, flexWrap: 'wrap', columnGap: 2 },
        services.map((service, i) =>
          h(
            Box,
            { key: service.name, flexShrink: 0 },
            h(Text, { color: STATUS_COLORS[service.status] }, '●'),
            h(Text, { bold: i === 0, underline: i === 0 }, ` ${service.name}`),
          ),
        ),
      ),
      hotkeyHints([
        ...(services.length > 1
          ? [{ key: '← →', label: 'select' }, { separator: true } as const]
          : []),
        { key: 'r', label: 'restart' },
        { key: 'b', label: 'rebuild' },
        { key: 's', label: 'stop' },
        { key: 'm', label: 'commands' },
      ]),
      h(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        h(
          Box,
          { columnGap: 2 },
          h(Text, { color: ACCENT_COLOR }, 'infra:'),
          h(Box, { flexShrink: 0 }, h(Text, { color: OK_COLOR }, '●'), h(Text, null, ' postgres')),
        ),
        h(
          Box,
          { columnGap: 2 },
          h(
            Text,
            null,
            h(Text, { color: ACCENT_COLOR }, 'cwd: '),
            h(Text, { color: OK_COLOR }, path.basename(process.cwd())),
          ),
          h(
            Text,
            null,
            h(Text, { color: ACCENT_COLOR }, 'git: '),
            h(Text, { color: OK_COLOR }, 'main'),
          ),
        ),
        h(
          Box,
          { columnGap: 2 },
          h(Text, { dimColor: true }, 'logfile: .devtooie/logs/dev.log'),
          h(Text, { color: LINK_COLOR }, '⧉'),
          hotkeyHints([{ key: 't', label: 'rotate' }]),
        ),
      ),
    ),
    linked.length > 0 &&
      h(
        Box,
        { flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 },
        linked.flatMap((service, i) => [
          h(Text, { key: `name-${service.name}`, bold: i === 0 }, service.name),
          h(Text, { key: `url-${service.name}`, color: LINK_COLOR }, service.url),
        ]),
      ),
  );
}

/**
 * Whether a mouse report at (`col`, `row`) — 1-based terminal cells — lands on an Ink element.
 * Ink exposes an element's size but not its position, so this sums the yoga offsets up the tree,
 * as `elementScreenRect` in `NativeRunner` does.
 */
function isHit(node: DOMElement | null | undefined, col: number, row: number): boolean {
  if (!node?.yogaNode) {
    return false;
  }
  let left = 0;
  let top = 0;
  for (let cur: DOMElement | undefined = node; cur?.yogaNode; cur = cur.parentNode) {
    left += cur.yogaNode.getComputedLeft();
    top += cur.yogaNode.getComputedTop();
  }
  const x = col - 1 - left;
  const y = row - 1 - top;
  return (
    x >= 0 &&
    x < node.yogaNode.getComputedWidth() &&
    y >= 0 &&
    y < node.yogaNode.getComputedHeight()
  );
}

/**
 * This tool's own chrome, above the mock: where you are, the keys, and the whole palette in its
 * current order. The numbered swatches are the ones on screen, and a `◆` marks a locked one. Each
 * swatch reports its element through `swatchRef`, which is what a click is hit-tested against.
 */
function header(
  palette: Swatch[],
  index: number,
  total: number,
  count: number,
  swatchRef: (slot: number) => (node: DOMElement | null) => void,
): ReactElement {
  return h(
    Box,
    {
      flexDirection: 'column',
      flexShrink: 0,
      borderStyle: 'single',
      borderColor: MUTED_COLOR,
      borderTop: false,
      borderLeft: false,
      borderRight: false,
    },
    h(
      Box,
      { flexWrap: 'wrap', columnGap: 3 },
      h(Text, { bold: true }, `palette ${index + 1}/${total}`),
      h(Text, null, `${count} of ${SERVICES.length} services`),
      hotkeyHints([
        { key: '← →', label: 'palette' },
        { key: '↑ ↓', label: 'services' },
        { key: 'click', label: 'lock' },
        { key: 'r', label: 'randomize unlocked' },
        { key: 's', label: 'shuffle order' },
        { key: 'q', label: 'quit and print' },
      ]),
    ),
    h(
      Box,
      // The lock marker's cell is always there, so locking a color never moves its neighbors.
      { flexWrap: 'wrap', columnGap: 1 },
      palette.map((swatch, i) =>
        h(
          Box,
          { key: i, ref: swatchRef(i), flexShrink: 0 },
          h(Text, { dimColor: i >= count }, i < count ? `${i + 1} ` : '· '),
          h(Text, { color: swatch.color }, '██ '),
          h(Text, { dimColor: i >= count }, swatch.color),
          h(Text, { bold: true }, swatch.locked ? '◆' : ' '),
        ),
      ),
    ),
    chalk.level < 3 &&
      h(
        Text,
        { color: WARN_COLOR },
        'This terminal does not report truecolor support, so these colors are approximations.',
      ),
  );
}

type State = {
  /** Every palette shown so far, each in the order it was last left in. */
  palettes: Swatch[][];
  index: number;
  count: number;
};

/** What the user was looking at when they quit, for the summary printed after the screen closes. */
let lastState: State = {
  palettes: [PACKAGE_PALETTE.map((color) => ({ color, locked: false }))],
  index: 0,
  count: DEFAULT_SERVICE_COUNT,
};

function PalettePreview(): ReactElement {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [state, setState] = useState(lastState);
  // Kept for the summary printed after the screen closes (`lastState`, above).
  // oxlint-disable-next-line react/globals
  lastState = state;
  const swatchNodes = useRef<(DOMElement | null)[]>([]);
  /** Apply `change` to the palette on screen, leaving the rest of the history as it is. */
  const changePalette = (change: (palette: Swatch[], s: State) => Swatch[]) => {
    setState((s) => ({
      ...s,
      palettes: s.palettes.map((p, i) => (i === s.index ? change(p, s) : p)),
    }));
  };

  // A click on a swatch toggles its lock. Ink never hands a mouse report to `useInput`, so they're
  // read from stdin's raw chunks, as the run screen does (see mouse.ts).
  const onMouseReports = useEffectEvent((reports: MouseReport[]) => {
    for (const report of reports) {
      if (report.type !== 'down' || report.button !== 0) {
        continue;
      }
      const slot = swatchNodes.current.findIndex((node) => isHit(node, report.col, report.row));
      if (slot !== -1) {
        changePalette((palette) =>
          palette.map((swatch, i) => (i === slot ? { ...swatch, locked: !swatch.locked } : swatch)),
        );
      }
    }
  });
  const { stdin } = useStdin();
  useEffect(() => {
    const decode = createMouseDecoder();
    const onData = (chunk: string | Buffer) => onMouseReports(decode(chunk.toString()).reports);
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    } else if (key.rightArrow) {
      setState((s) =>
        s.index + 1 < s.palettes.length
          ? { ...s, index: s.index + 1 }
          : { ...s, palettes: [...s.palettes, randomPalette()], index: s.index + 1 },
      );
    } else if (key.leftArrow) {
      setState((s) => ({ ...s, index: Math.max(0, s.index - 1) }));
    } else if (key.upArrow) {
      setState((s) => ({ ...s, count: Math.min(SERVICES.length, s.count + 1) }));
    } else if (key.downArrow) {
      setState((s) => ({ ...s, count: Math.max(1, s.count - 1) }));
    } else if (input.toLowerCase() === 'r') {
      // A re-roll can't be taken back, so it never overwrites what it started from: it goes in
      // as the next palette, locks and all, and ← returns to the one before it.
      setState((s) => {
        const current = s.palettes[s.index]!;
        if (current.every((swatch) => swatch.locked)) {
          return s;
        }
        return {
          ...s,
          palettes: [
            ...s.palettes.slice(0, s.index + 1),
            rerollUnlocked(current),
            ...s.palettes.slice(s.index + 1),
          ],
          index: s.index + 1,
        };
      });
    } else if (input.toLowerCase() === 's') {
      changePalette((palette, s) => reorder(palette, s.count));
    }
  });

  const palette = state.palettes[state.index]!;
  const services = SERVICES.slice(0, state.count);
  const nameWidth = Math.max(...services.map((service) => service.name.length));
  // More rows than can ever fit: the pane is bottom-aligned and clips whatever overflows its top,
  // which is what keeps the newest line against the footer at any terminal size.
  const visible = mockLog(state.count).slice(-rows);

  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: rows, overflow: 'hidden' },
    header(palette, state.index, state.palettes.length, state.count, (slot) => (node) => {
      swatchNodes.current[slot] = node;
    }),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end', overflow: 'hidden' },
      visible.map((line, i) =>
        h(
          Box,
          { key: i, flexShrink: 0 },
          h(Text, { wrap: 'truncate' }, renderLogLine(line, palette, nameWidth)),
        ),
      ),
    ),
    footer(services),
  );
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('palette-preview is interactive: run it in a terminal.');
  process.exit(1);
}

// Clicks only reach the app as mouse reports while the terminal is asked for them — and it goes on
// capturing the mouse after this process is gone unless it is told to stop.
process.stdout.write(MOUSE_ENABLE);
process.once('exit', () => process.stdout.write(MOUSE_DISABLE));

const app = render(h(PalettePreview), { exitOnCtrlC: false, alternateScreen: true });
await app.waitUntilExit();

const finalPalette = lastState.palettes[lastState.index]!;
console.log(
  [
    `Palette ${lastState.index + 1} of ${lastState.palettes.length}, in the order last shown:`,
    finalPalette.map(({ color }) => chalk.hex(color)('██')).join(' '),
    '',
    'export const PACKAGE_PALETTE: readonly Color[] = [',
    ...finalPalette.map(({ color }) => `  '${color}',`),
    '];',
  ].join('\n'),
);

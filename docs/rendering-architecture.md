# Terminal UI rendering architecture

How devtooie draws its interactive terminal UI. This is a **contributor** document
about internals — not a usage guide. If you're changing anything about the footer,
the log stream, screen clearing, scrollback, or resize behavior, read this first.

## The one idea to hold onto

devtooie's run-phase screen is a **hybrid**, not a normal Ink app:

- **Ink renders only the footer** — the package dots, hotkey hints, URL links, and
  the `git:(branch)` / `logfile:` line. That small block is the *entire* React
  tree output.
- **The scrolling log area is not rendered by Ink at all.** Child-process output is
  written straight to `stdout` by `ProcessManager` as ordinary terminal lines, so
  it lands in the terminal's **native scrollback** (which is why the mouse wheel
  scrolls history normally).

Everything else below follows from that split. The footer is a live, redrawn
region pinned to the bottom; the logs are immutable terminal history above it.

## Phases

The app is a small phase machine (`components/App.tsx`):

```
package-select  ->  building  ->  running
(PackageSelector)  (BuildProgress)  (NativeRunner + ProcessManager)
```

`package-select` and `building` are **plain Ink renders** — no cursor tricks, no
manual scrollback management. All of the machinery in this document belongs to the
**running** phase (`NativeRunner` driving `ProcessManager`). `renderApp`
(`components/App.tsx`) mounts the tree on the **primary screen** (no alternate
screen) with `exitOnCtrlC: false` (each phase owns Ctrl+C) and `maxFps: 120`
(so a fast burst of keystrokes can't land between a state commit and its render),
and clears the screen once (`ESC[2J ESC[3J ESC[H`) before Ink mounts.

## How the footer stays glued to the bottom

The footer is Ink's **write-above** live region. The mechanism has three parts.

### 1. Ink's patched console is the bridge

Ink runs with its default `patchConsole: true`. That means every `console.log` /
`console.error` — from anywhere — is intercepted and turned into:

> erase the current footer → write your text → reprint the footer below it

`ProcessManager` emits **every** log line through `console.log`
(`emitLine` for a single streamed line, `emitBatch` for a whole replay — see
`process-manager.ts`). So each log line is written *above* a freshly repainted
footer, and Ink keeps its own cursor bookkeeping in sync. **This is why the code
must use `console.log`, never `process.stdout.write`, for anything that should
appear above the footer** — a raw write bypasses Ink's erase/repaint and desyncs
the footer.

### 2. Writing at the bottom scrolls the terminal

When a line is written at the bottom of a full viewport, the terminal scrolls up by
one row: the top line moves into native scrollback and the footer is repainted
flush at the bottom again. Streaming N lines therefore pushes N lines of real
output into scrollback while the footer *appears* stationary at the bottom edge.

### 3. `resetScreen` forces the footer down before the viewport fills

Steps 1–2 only pin the footer to the bottom once output has filled the screen.
Before that, write-above would leave the footer partway up the screen. So on
startup (and on every authoritative repaint) `ProcessManager.resetScreen()` clears
the screen + scrollback and positions the cursor `footerHeight` rows from the
bottom, so the footer renders at the bottom edge immediately with blank space above
it:

```
console.log(`\x1b[2J\x1b[H\x1b[3J\x1b[${rows - footerHeight};1H`)
```

`resetScreen` deliberately goes through `console.log` (not a raw write) for the
same reason as above: it must pass through Ink's patched console so Ink's tracked
cursor position stays correct.

### The scrollback guard (`ESC[3J`)

Before the viewport is full, the rows scrolling off the top are **blank padding**,
not real output — you don't want to be able to scroll up into emptiness. So while
`visibleLineCount < rows - footerHeight`, every emit also issues `ESC[3J` to drop
the scrollback (`emitLine` / `emitBatch`). **Once real content overflows the
viewport, the guard stops firing and native scrollback is left intact** — that is
the point at which mouse-wheel history becomes available, and it's intentional.

### `footerHeight` is measured, not assumed

The footer's height changes (URL links wrap, filter-input mode adds a prompt line,
package rows reflow). `NativeRunner` measures the real footer every render with
Ink's `measureElement` and pushes it into the manager via `setFooterHeight`
(the `useLayoutEffect` in `components/NativeRunner.tsx`). The manager uses that
number for both the cursor target in `resetScreen` and the scrollback guard, so it
never treats footer rows as clearable log content.

## The authoritative repaint

Whenever the geometry changes, devtooie re-establishes the whole screen from its
in-memory buffer rather than trying to patch it incrementally:

- `resetScreen()` — clear screen + scrollback, reposition the footer at the bottom.
- `replayBuffer()` — `resetScreen()` then re-emit the buffered lines (through the
  active filter) in one `console.log`, wrapped to the **current** terminal width.
- `refresh()` — public wrapper around `replayBuffer()`.
- `clearBuffer()` — drop the buffer entirely and `resetScreen()`.

`ProcessManager` keeps a `buffer` of every line (`{ prefix, text, searchName,
isError, groupId }`); child output is split into lines at capture time
(`proc.stdout.on('data')` → `addLine`), so the log model is already a list of
discrete lines with ANSI color baked into the text. `formatLine` wraps a line to
the current width (`process.stdout.columns`) — which is why a replay reflows
correctly at a new size.

**Triggers for an authoritative repaint** (all funnel through `refresh`/`setFilter`
from the `NativeRunner` layout effect, except startup):

| Trigger | Path |
| --- | --- |
| Startup | first footer measurement → `setTimeout(0)` → `resetScreen()` + `startAll()` |
| Filter change (`f`) | `setFilter()` → clear + replay filtered |
| Clear (`k`) | `clearBuffer()` |
| Footer-height change | `refresh()` |
| **Terminal resize** | `useWindowSize()` → `refresh()` on every size change (see below) |

## Startup sequencing

Order matters on first paint (`components/NativeRunner.tsx`):

1. Ink paints the footer once so `measureElement` can read its real height.
2. The first successful measurement sets `footerHeight`, then schedules
   `resetScreen()` + `startAll()` via `setTimeout(0)` — so the manager knows the
   footer height *before* it positions the cursor, avoiding a scrollback gap on the
   first frame.
3. A separate ~50 ms `ready` delay suppresses render until Ink's throttled output
   has settled into the run-phase layout, avoiding a one-frame flash of a
   mis-positioned footer.

## Resize handling

This is the subtle part, and the reason this document exists.

**Ink's own resize handling is not enough for this layout.** On `resize`, Ink
repaints *its* output (the footer) using a cursor-relative incremental erase, and
only issues a full clear when the width *decreases*. But devtooie has (a) moved the
cursor itself via `resetScreen`'s absolute positioning, which Ink doesn't track,
and (b) anchored the footer to `rows - footerHeight`, which nothing re-derives when
`rows` changes. The failure modes:

- **Grow** (wider/taller): the footer is never re-anchored to the new bottom edge →
  a dead gap opens below it.
- **Shrink** (narrower/shorter): Ink's incremental erase lands in the wrong place →
  stale footers pile up as ghosts.

Crucially, a resize that leaves the footer's *measured height* unchanged produces
no React state change, so the footer-height branch of the layout effect never runs
and no repaint happens at all.

**The fix:** subscribe to resize with Ink's `useWindowSize()` (it forces a real
re-render with the new `{ columns, rows }` on every resize event, including the
same-footer-height case above), and on **every** change run the same authoritative
`refresh()` used by every other geometry change — re-anchoring the footer at the
new bottom edge and reflowing the buffer to the new width. The wiring lives in
`NativeRunner` and is gated on `startedRef`, so nothing repaints before the initial
`startAll` (which also covers the mount invocation, since no genuine resize has
changed `columns`/`rows` yet).

Because `refresh()` clears the whole screen + scrollback and redraws from the
buffer, running it per resize event means each event **fully redraws** rather than
letting Ink patch its footer incrementally — which is what keeps the per-event
repaint from leaving a gap or ghost footers. A drag therefore re-emits the buffer
repeatedly; if that ever proves too heavy for very large buffers, debouncing the
call or capping the replay length is the place to look.

## Plain / non-TTY mode

When devtooie runs without an interactive TUI (`--plain`, or any non-TTY context —
`runners/plain.ts` constructs `new ProcessManager(args, { plain: true })`), all of
the above is **disabled**: `resetScreen` and the `ESC[3J` scrollback guards no-op,
there is no footer to reserve rows for, and lines are simply printed. Scrollback is
expected and normal. Keep this path in mind — changes to the interactive rendering
must not regress plain output.

## Roads not taken (and why)

- **Alternate screen (`alternateScreen: true`, like `vim`/`htop`).** Would make a
  bottom-glued footer trivial (flexbox in a full-height layout) and give perfect
  resize for free. Rejected because the alternate screen has **no native
  scrollback** — you'd lose mouse-wheel history and have to build an in-app
  scrollable log pane. devtooie deliberately keeps native scrollback.
- **Rendering logs through Ink (`<Static>` / a scrolling `<Box>`).** Would put the
  whole screen under Ink's control, but the footer would then float below the last
  line (write-above) rather than staying glued to the bottom, and/or you'd again
  give up native scrollback. The hand-anchored approach is what preserves *both*
  bottom-glue and native scroll.

## File / symbol map

| Concern | Where |
| --- | --- |
| Phase machine, `renderApp` options, initial clear | `components/App.tsx` |
| Footer JSX, measurement, input handling, resize wiring | `components/NativeRunner.tsx` |
| Log buffer, `console.log` emits, `resetScreen`, `replayBuffer`/`refresh`, scrollback guard, `formatLine`, `setFooterHeight`, `plain` | `process-manager.ts` |
| Non-interactive path | `runners/plain.ts` |

## Invariants to preserve

- Anything meant to appear **above** the footer goes through `console.log` /
  `console.error`, never raw `process.stdout.write` — the raw path bypasses Ink's
  footer erase/repaint and desyncs the cursor.
- `resetScreen` must stay on the `console.log` path for the same reason.
- Every geometry change (startup, filter, clear, footer-height, resize) should end
  in an authoritative repaint (`resetScreen` / `refresh` / `setFilter` /
  `clearBuffer`) — never an incremental patch — so Ink and devtooie can't drift
  out of sync.
- The `plain` path must remain a plain line printer with none of the cursor or
  scrollback tricks.

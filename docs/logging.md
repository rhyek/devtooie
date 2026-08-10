# Logging

> Part of the [devtooie](../README.md) documentation.

How devtooie displays and records each package's output. Two things: optional on-screen
**timestamps**, and the **structured-log (JSON) formatting** devtooie applies by default. You rarely
need to configure either — timestamps are off unless you turn them on, and the structured-log
formatter works out of the box (most dev processes don't even emit JSON logs). Both are driven by
the top-level and per-package `logs` option of [`defineConfig`](./configuration.md).

## Timestamps

By default log lines are shown without a timestamp. Set `logs.timestamps: true` to prefix
every on-screen log line (both the interactive TUI and `--plain` output) with a
`YYYY-MM-DD HH:MM:SS` local-time (24-hour) stamp:

```ts
export default defineConfig({
  logs: { timestamps: true },
  packages: [/* … */],
});
```

```
2026-07-13 13:53:32 [api]     backend ready, starting…
2026-07-13 13:53:32 [web]     VITE ready in 431 ms
```

The on-disk session log file always records timestamps (in the same format) regardless of
this setting; `logs.timestamps` only controls whether they're shown on screen.

**Per-package override.** A package can set its own on-screen visibility with a package-level
`logs.timestamps`. When set (`true` or `false`) it wins over the top-level default for that
package; when omitted, the package inherits the top-level value:

```ts
export default defineConfig({
  logs: { timestamps: false }, // top-level default
  packages: [
    { name: 'api' }, // inherits → no timestamps on screen
    { name: 'worker', logs: { timestamps: true } }, // overrides → timestamps on screen
  ],
});
```

## Structured logs

> **You probably don't need this section.** Most dev processes log plain, human-readable text
> (vite, `tsc`, nodemon, most app servers) — devtooie passes that straight through, untouched. For
> the apps that _do_ emit structured **JSON** logs in dev, the default formatter already handles the
> common cases (Go `slog`, pino, winston). Read on only if a package logs JSON in dev **and** the
> default formatter isn't rendering it the way you want.

Some services log **structured JSON in every environment** (Go's `log/slog`, Node's pino/winston)
rather than branching the logger on `NODE_ENV`. **devtooie handles this out of the box** — it
applies a default formatter to _every_ package's output that

- passes **non-JSON** lines through untouched, and
- pretty-prints a **JSON log** as a **`[LEVEL] message`** header (the `[LEVEL]` colored by severity),
  with the remaining properties listed, indented, on the lines below.

A property whose value spans several lines keeps its shape: the extra lines are aligned under where
the value starts, so the entry still reads as one block.

```
[INFO] query executed
  table: users
  sql: SELECT id, email
       FROM users
```

So a slog line like:

```
{"time":"2026-07-13T13:53:32-06:00","level":"INFO","msg":"listening","port":3002}
```

is shown as:

```
[INFO] listening
  time: 2026-07-13T13:53:32-06:00
  port: 3002
```

You configure nothing for this. `logs.formatter` only **overrides** the default for a package — to
map a logger's numeric levels, or to rename/hide fields.

### Levels

A **string** level is uppercased and matched to devtooie's canonical levels —
**`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`** — folding common aliases (`WARNING`→`WARN`,
`ERR`→`ERROR`, `CRITICAL`/`EMERGENCY`→`FATAL`, `VERBOSE`→`TRACE`, `NOTICE`→`INFO`, …). The matched
`[LEVEL]` is colored by severity. A **number** is **not** guessed — the numbers aren't standard
(pino's `30` is INFO, Python's is WARNING) — so it shows as `[UNKNOWN LOGLVL: 30]` until you map it
(see the helpers below); an unmatched string shows as `[UNKNOWN LOGLVL: FOOBAR]`.

### The `logging` helpers

> **These are for structured (JSON) logs only.** Every `logging.*` helper builds a formatter that
> parses each line as JSON and configures how a *recognized log object* is displayed. Anything it
> doesn't recognize is passed through untouched — so pointing one at a process that logs plain
> prose does nothing at all. To reshape arbitrary text output, write
> [`logs.formatter`](#writing-your-own) yourself: it's a plain `(line: string) => string` over the
> raw line, with no JSON assumption.

Override a package's formatter with one of the `logging` helpers (exported from `devtooie`):

```ts
import { defineConfig, logging } from 'devtooie';

export default defineConfig({
  packages: [
    { name: 'go-svc' }, // no config — slog's string levels just work via the default
    { name: 'api', logs: { formatter: logging.nodejs.pino.formatter() } }, // pino numeric levels → labels
    { name: 'web', logs: { formatter: logging.nodejs.winston.formatter() } }, // winston `message` key + levels
  ],
});
```

- **`logging.formatter(config?)`** — the base factory, and the exact default applied to every
  package. The ecosystem helpers are this with their defaults changed.
- **`logging.nodejs.pino.formatter(config?)`** — maps pino/bunyan's **numeric** levels
  (`logging.nodejs.pino.levels`: `10=TRACE … 60=FATAL`).
- **`logging.nodejs.winston.formatter(config?)`** — uses winston's `message` key and level names
  (`logging.nodejs.winston.levels`).

`config` is `{ fields?, levels? }`, everything optional:

- **`fields.level`** / **`fields.message`** — the source JSON keys (defaults `level` / `msg` — both
  match Go `slog` and pino; winston uses `message`).
- **`fields.custom`** — rename or hide the other properties, keyed by the **display** name:
  - `{ timestamp: 'ts' }` — show source `ts` as `timestamp`.
  - `{ timestamp: { source: 'ts' } }` — long form.
  - `{ time: { show: false } }` — hide `time` (source defaults to the key).
- **`levels`** — a `{ rawValue: name }` map for numeric or non-standard levels (the ecosystem
  helpers set this for you). The mapped name is matched like any string.

```ts
logging.formatter({
  fields: { custom: { time: { show: false } } }, // hide the log's own timestamp — devtooie stamps its own
  levels: { 5: 'error' }, // map a custom numeric level
});
```

#### Config that depends on the entry

Pass a **callback** instead of the object and it returns the config for the entry being rendered.
It receives the **parsed log** — devtooie does the parsing, so there's nothing to `JSON.parse` and
no non-JSON line to guard against. Handy when a field is only noise on certain events:

```ts
logging.formatter((log) => ({
  fields: {
    custom: {
      time: { show: false }, // hidden on every entry
      // `at` is redundant on healthcheck events, but useful elsewhere
      ...(log.context === 'healthcheck' ? { at: { show: false } } : {}),
    },
  },
}));
```

The whole config is per-entry, not just `fields.custom` — `levels` and the level/message keys can
vary too, which is what you want when one stream carries logs from more than one source.

The ecosystem helpers take the callback form as well and keep their defaults, so
`logging.nodejs.pino.formatter((log) => …)` still maps pino's numeric levels without you
restating them.

The callback runs once per **JSON-object** line. Lines that aren't a JSON object never reach it. A
JSON object with no recognizable level/message *does* reach it — it chooses those keys, so it has to
run before that check — and then passes through unformatted like any other unrecognized line.

### Writing your own

`logs.formatter` is just `(line: string) => string` — return the display string, or the line
unchanged to pass it through. **This is the general hook**: unlike the `logging.*` helpers above, it
sees the whole raw line and assumes nothing about its format, so it's what you use when the output
**isn't** JSON — or when it is, but you want a rendering the built-in formatter can't express.

A formatter owns the presentation of the lines it actually **rewrites**. One you return unchanged is
rendered exactly as it would be with no formatter configured — plain for stdout, **red for stderr** —
so passing a line through never costs it its color.

A formatter that throws or returns a non-string falls back to the raw
line, so a bug can't take down the session. The returned string is what's buffered, shown, **and
written to the log file** (ANSI color allowed, stripped for the file); a multi-line result is split
into separate log lines, which devtooie keeps grouped as **one entry** — so a filter matching any of
them shows the whole block. That grouping comes from the split itself, not from how the lines look,
so you don't have to indent them to hold an entry together. **devtooie owns the timestamp** (shown per `logs.timestamps`, always in
the log file), so drop the log's own time field rather than printing it. `z` (zod) is re-exported
by devtooie, so a hand-written formatter can validate shapes without a dependency.

The [`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo's Go `worker` (slog)
shows both config shapes: the plain object that only hides slog's `time`, and the callback it
actually runs, which additionally drops the `port` its base logger stamps on every line — useful on
the startup lines, noise on the heartbeat that repeats every 5s.

## devtooie's own log lines

Alongside your packages' output, devtooie logs its own events into the same stream — structured the
same way, so they format, filter and land in the log file identically. They use two labelled
channels, both rendered in a distinct gold so they read apart from package output:

- **`[devtooie]`** — session lifecycle notices (shutting down, git-branch change).
- **`[dt:control]`** — mutating commands received over the [control API](control-api.md)
  (restart, rebuild, quit). The command is the message; the variables it carried are listed as
  indented properties beneath it.

```
2026-07-23 16:41:22 [devtooie       ] [WARN] shutting down...
2026-07-23 16:41:22 [dt:control     ] [INFO] restart
2026-07-23 16:41:22 [dt:control     ]   package: backend
```

A control line naming a package is tagged with that package, so it shows and hides with the
package's own output under an active filter.

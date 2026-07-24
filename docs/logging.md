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
[INFO] message stored
  from: [Ros Bumble]
  text: Mira, Uruguay
        Que tal será para ir d viaje?
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

  It can also be a **callback** receiving the parsed log, so the mapping can depend on the entry
  itself — handy when a field is only noise on certain events:

  ```ts
  logging.formatter({
    fields: {
      custom: (log) => ({
        time: { show: false }, // always hidden
        // `at` is redundant on ingest events, but useful elsewhere
        ...(log.context === 'message-ingest' ? { at: { show: false } } : {}),
      }),
    },
  });
  ```

  The callback runs once per rendered line, and never for lines that pass through unformatted
  (non-JSON, or JSON with no recognizable level/message).

- **`levels`** — a `{ rawValue: name }` map for numeric or non-standard levels (the ecosystem
  helpers set this for you). The mapped name is matched like any string.

```ts
logging.formatter({
  fields: { custom: { time: { show: false } } }, // hide the log's own timestamp — devtooie stamps its own
  levels: { 5: 'error' }, // map a custom numeric level
});
```

### Writing your own

`logs.formatter` is just `(line: string) => string` — return the display string, or the line
unchanged to pass it through. A formatter that throws or returns a non-string falls back to the raw
line, so a bug can't take down the session. The returned string is what's buffered, shown, **and
written to the log file** (ANSI color allowed, stripped for the file); a multi-line result is split
into separate log lines. **devtooie owns the timestamp** (shown per `logs.timestamps`, always in
the log file), so drop the log's own time field rather than printing it. `z` (zod) is re-exported
by devtooie, so a hand-written formatter can validate shapes without a dependency.

The [`example/`](https://github.com/rhyek/devtooie/tree/main/example) monorepo's Go `worker` (slog)
relies on the default formatter, tweaked only to hide slog's `time`.

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

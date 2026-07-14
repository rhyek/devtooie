// devtooie's structured-log formatting. `logging.formatter(config)` builds the formatter used for
// a package's output; **a default `logging.formatter()` is applied to every package automatically**
// (override per package with `logs.formatter`). Each output line is parsed as JSON; non-JSON lines
// (and JSON that isn't an object with a recognizable level/message) are returned untouched. A
// recognized log renders as a `[LEVEL] message` header — the `[LEVEL]` colored by severity — with
// the remaining properties listed, indented, on the lines below. devtooie splits that multi-line
// result into separate log lines and groups the indented ones with the header as continuations.

import chalk from 'chalk';

/** Long-form config for a custom (renamed and/or hidden) property in {@link FormatterFields.custom}. */
export interface CustomField {
  /** Property name in the source JSON log. Defaults to the custom entry's key (its display name). */
  source?: string;
  /** Whether to print the property. Defaults to `true`. */
  show?: boolean;
}

/** The source JSON field mapping — `config.fields` of {@link FormatterConfig}. */
export interface FormatterFields {
  /**
   * Source JSON property holding the log level. Defaults to `'level'` — the key both Go's
   * `log/slog` and Node's pino emit. A **string** level is uppercased and matched to devtooie's
   * canonical levels (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`; e.g. `WARNING` → `WARN`);
   * an unmatched string, or a **number** with no {@link FormatterConfig.levels} map, prints as
   * `[UNKNOWN LOGLVL: …]`.
   */
  level?: string;
  /** Source JSON property holding the message. Defaults to `'msg'`. (winston uses `message`.) */
  message?: string;
  /**
   * Rename or hide additional properties, keyed by the **display** name:
   * - `{ timestamp: 'ts' }` — show the source field `ts` under the name `timestamp`.
   * - `{ timestamp: { source: 'ts' } }` — long form of the above.
   * - `{ time: { show: false } }` — hide the `time` field (source defaults to the key).
   */
  custom?: Record<string, string | CustomField>;
}

/** Config for {@link createFormatter} / `logging.formatter`. */
export interface FormatterConfig {
  /** Source JSON field mapping (level/message keys, property rename/hide). */
  fields?: FormatterFields;
  /**
   * Convert raw level *values* to level names — needed for numeric levels, which devtooie does
   * **not** guess (an unmapped number prints as `[UNKNOWN LOGLVL: n]`). The mapped name is then
   * matched to a canonical level like any string. Ready-made maps: `logging.nodejs.pino.levels`,
   * `logging.nodejs.winston.levels`.
   */
  levels?: Record<string, string>;
}

// devtooie's canonical log levels (a complete, ordered ladder), and the aliases — matched
// case-insensitively — that fold onto them, so `WARN`/`WARNING` both become `WARN`, `ERR` becomes
// `ERROR`, syslog's `EMERGENCY`/`ALERT` and Python's `CRITICAL` become `FATAL`, etc.
const CANONICAL_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

const LEVEL_ALIASES: Record<string, string> = {
  ...Object.fromEntries(CANONICAL_LEVELS.map((l) => [l, l])), // identity: TRACE → TRACE, …
  VERBOSE: 'TRACE',
  SILLY: 'TRACE',
  FINEST: 'TRACE',
  FINE: 'DEBUG',
  FINER: 'DEBUG',
  INFORMATION: 'INFO',
  INFORMATIONAL: 'INFO',
  NOTICE: 'INFO',
  LOG: 'INFO',
  WARNING: 'WARN',
  ERR: 'ERROR',
  SEVERE: 'ERROR',
  CRITICAL: 'FATAL',
  CRIT: 'FATAL',
  EMERGENCY: 'FATAL',
  EMERG: 'FATAL',
  ALERT: 'FATAL',
  PANIC: 'FATAL',
};

// Color applied to the bracketed token of a matched (known) level. Unknown levels are left
// uncolored. ANSI is kept for the on-screen view and stripped for the log file, like log prefixes.
const LEVEL_COLOR: Record<string, (s: string) => string> = {
  TRACE: chalk.gray,
  DEBUG: chalk.cyan,
  INFO: chalk.green,
  WARN: chalk.yellow,
  ERROR: chalk.red,
  FATAL: chalk.bold.red,
};

// A property line is `  key: value`. The key is muted so it reads as a label and the value (the
// data) stands out in the normal foreground.
const PROPERTY_KEY_COLOR = chalk.gray;

/**
 * pino/bunyan's numeric levels mapped to their names (`10=TRACE … 60=FATAL`) — pino/bunyan log the
 * level as a *number*, which devtooie won't guess. Exposed as `logging.nodejs.pino.levels`.
 */
export const pinoLevels: Record<string, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/**
 * winston's npm levels mapped to devtooie's canonical levels. winston logs the level as a *string*,
 * so most match on their own — this mainly pins `http` and keeps the set explicit. Exposed as
 * `logging.nodejs.winston.levels`.
 */
export const winstonLevels: Record<string, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  http: 'DEBUG',
  verbose: 'DEBUG',
  debug: 'DEBUG',
  silly: 'TRACE',
};

/** Render a JSON value for display: strings as-is, everything else via `JSON.stringify`. */
function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Resolve a raw level value to a bracketed display token, or `undefined` when there's no level.
 * A `levels` map (e.g. pino's numbers) is applied first; the resulting name — or a raw string — is
 * uppercased and matched to a canonical devtooie level, whose `[LEVEL]` token is colored by
 * severity. Anything unmatched (an unknown string, or a number with no map) becomes an uncolored
 * `[UNKNOWN LOGLVL: <value>]`; a number's meaning is never guessed.
 */
function levelToken(
  rawLevel: unknown,
  levels: Record<string, string> | undefined,
): string | undefined {
  if (rawLevel === undefined) return undefined;
  const value = (levels ? levels[String(rawLevel)] : undefined) ?? rawLevel;
  if (typeof value === 'string') {
    const canonical = LEVEL_ALIASES[value.toUpperCase()];
    if (canonical) {
      const paint = LEVEL_COLOR[canonical] ?? ((s: string) => s);
      return paint(`[${canonical}]`);
    }
    return `[UNKNOWN LOGLVL: ${value.toUpperCase()}]`;
  }
  return `[UNKNOWN LOGLVL: ${String(value)}]`;
}

/**
 * Build a structured-log formatter (`(line: string) => string`). Parses each line as JSON and
 * renders a recognized log as a `[LEVEL] message` header followed by its other properties, each
 * indented on its own line. Non-JSON lines, and JSON that isn't an object with a recognizable
 * level/message, pass through unchanged. See {@link FormatterConfig}. Prefer the `logging` helpers
 * (`logging.formatter`, `logging.nodejs.pino.formatter`, …), which are thin wrappers over this.
 */
export function createFormatter(config: FormatterConfig = {}): (line: string) => string {
  const levelKey = config.fields?.level ?? 'level';
  const messageKey = config.fields?.message ?? 'msg';
  const levels = config.levels;

  // Resolve the custom entries into a source-field -> { display, show } lookup, so a property can
  // be matched by the name it actually has in the log.
  const bySource = new Map<string, { display: string; show: boolean }>();
  for (const [display, cfg] of Object.entries(config.fields?.custom ?? {})) {
    const source = typeof cfg === 'string' ? cfg : (cfg.source ?? display);
    const show = typeof cfg === 'string' ? true : (cfg.show ?? true);
    bySource.set(source, { display, show });
  }

  return (line: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line; // not JSON — leave it as-is
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return line; // JSON, but not a log object
    }

    const obj = parsed as Record<string, unknown>;
    const rawLevel = obj[levelKey];
    const message = obj[messageKey];
    if (rawLevel === undefined && message === undefined) {
      return line; // no recognizable level/message under the configured keys
    }

    const token = levelToken(rawLevel, levels);
    const head = [token, message === undefined ? undefined : renderValue(message)]
      .filter((v) => v !== undefined)
      .join(' ');
    const out = [head];
    for (const [key, value] of Object.entries(obj)) {
      if (key === levelKey || key === messageKey) continue;
      const custom = bySource.get(key);
      if (custom && !custom.show) continue; // hidden
      const name = custom ? custom.display : key;
      out.push(`  ${PROPERTY_KEY_COLOR(`${name}:`)} ${renderValue(value)}`);
    }
    return out.join('\n');
  };
}

/**
 * The formatter devtooie applies to every package's output by default (equivalent to
 * `logging.formatter()`): non-JSON lines pass through untouched, JSON logs are best-effort
 * formatted. A package's own `logs.formatter` overrides it.
 */
export const defaultFormatter = createFormatter();

/**
 * The `logging` helper namespace. `logging.formatter(config)` is the base factory (and the default
 * applied to every package); the ecosystem helpers are the same formatter with their defaults
 * changed — `logging.nodejs.pino.formatter()` maps pino's numeric levels, and
 * `logging.nodejs.winston.formatter()` uses winston's `message` key and level names. Each level map
 * is exposed too (`logging.nodejs.pino.levels`, `logging.nodejs.winston.levels`).
 *
 * A plain object, not a TypeScript `namespace`: namespaces are legacy for module code and, when
 * they hold runtime values, emit non-erasable syntax that Node's `.ts` type-stripping rejects.
 */
export const logging = {
  formatter: createFormatter,
  nodejs: {
    pino: {
      levels: pinoLevels,
      formatter: (config: FormatterConfig = {}) =>
        createFormatter({ ...config, levels: config.levels ?? pinoLevels }),
    },
    winston: {
      levels: winstonLevels,
      formatter: (config: FormatterConfig = {}) =>
        createFormatter({
          ...config,
          fields: { message: 'message', ...config.fields },
          levels: config.levels ?? winstonLevels,
        }),
    },
  },
};

import pino, { type Logger } from 'pino';
import { logging } from './log-formatter.js';

/** devtooie's two internal log channels, both children of one devtooie-wide pino logger. */
export interface InternalLoggers {
  /** devtooie's own lifecycle events (shutdown, branch change, …); rendered under `[devtooie]`. */
  system: Logger;
  /** Control-API command notices: the command is the message, its variables are attrs; `[dt:control]`. */
  control: Logger;
}

/**
 * Build devtooie's internal logger: one pino instance writing NDJSON to `dest`, with a `system` and
 * a `control` child bound to a routing `component` field. No pid/hostname/time is emitted — devtooie
 * stamps its own timestamp on every rendered line, and `component` only routes the record to a
 * prefix (it's hidden from the rendered output; see {@link formatInternalRecord}).
 */
export function createInternalLogger(dest: (line: string) => void): InternalLoggers {
  const logger = pino(
    { base: null, timestamp: false, level: 'debug' },
    { write: (line: string) => dest(line) },
  );
  return {
    system: logger.child({ component: 'system' }),
    control: logger.child({ component: 'control' }),
  };
}

// Maps pino's numeric levels (30 → INFO …) and hides the routing `component` field, so an internal
// record renders exactly like a package's structured log: a `[LEVEL] message` header with the
// remaining attrs listed, indented, beneath it.
const internalFormatter = logging.nodejs.pino.formatter({
  fields: { custom: { component: { show: false } } },
});

/** pino's numeric error level; at or above this a record renders as an error (red) line. */
const ERROR_LEVEL = 50;

export interface RenderedInternalRecord {
  /** The formatted `[LEVEL] message` (+ indented props) text; may span multiple lines. */
  text: string;
  /** Which channel emitted it — picks the `[devtooie]` vs `[dt:control]` prefix. */
  component: 'system' | 'control';
  /** The package a control command targeted, if any (scopes the line for filtering/grouping). */
  packageName?: string;
  /** True for error/fatal records, so the sink can mark the line as an error. */
  isError: boolean;
}

/**
 * Parse one internal NDJSON record and render it for the buffer/logfile: the display text plus the
 * routing info the sink needs (which prefix, which package to group under, error or not). Throws if
 * the line isn't JSON — callers guard.
 */
export function formatInternalRecord(jsonLine: string): RenderedInternalRecord {
  const rec = JSON.parse(jsonLine) as { level?: number; component?: string; package?: string };
  return {
    text: internalFormatter(jsonLine),
    component: rec.component === 'control' ? 'control' : 'system',
    packageName: typeof rec.package === 'string' ? rec.package : undefined,
    isError: typeof rec.level === 'number' && rec.level >= ERROR_LEVEL,
  };
}

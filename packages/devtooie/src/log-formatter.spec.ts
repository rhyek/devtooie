import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk from 'chalk';
import {
  createFormatter,
  defaultFormatter,
  pinoLevels,
  winstonLevels,
  logging,
} from './log-formatter.js';
import { stripAnsi } from './lib.js';

// Semantic tests assert the text; strip color so they're independent of the env's chalk.level.
const fmt = (config?: Parameters<typeof createFormatter>[0]) => {
  const f = createFormatter(config);
  return (line: string) => stripAnsi(f(line));
};

describe('createFormatter', () => {
  describe('logging namespace', () => {
    it('exposes the base factory, the default, and the ecosystem helpers', () => {
      expect(logging.formatter).toBe(createFormatter);
      expect(logging.nodejs.pino.levels).toBe(pinoLevels);
      expect(logging.nodejs.winston.levels).toBe(winstonLevels);
      // defaultFormatter is a plain createFormatter() — used automatically on every package.
      expect(stripAnsi(defaultFormatter('{"level":"info","msg":"hi"}'))).toBe('[INFO] hi');
    });
  });

  describe('pass-through', () => {
    const f = fmt();

    it('returns a non-JSON line unchanged', () => {
      expect(f('not json at all')).toBe('not json at all');
      expect(f('[vite] ready in 431 ms')).toBe('[vite] ready in 431 ms');
    });

    it('returns non-object JSON (array, number, string, null) unchanged', () => {
      expect(f('[1,2,3]')).toBe('[1,2,3]');
      expect(f('42')).toBe('42');
      expect(f('null')).toBe('null');
    });

    it('returns a JSON object with no level/message unchanged', () => {
      expect(f('{"foo":1,"bar":2}')).toBe('{"foo":1,"bar":2}');
    });
  });

  describe('rendering — [LEVEL] message + indented properties', () => {
    const f = fmt();

    it('renders a slog line as a bracketed header plus indented properties', () => {
      expect(f('{"level":"INFO","msg":"hello world","port":"3002"}')).toBe(
        '[INFO] hello world\n  port: 3002',
      );
    });

    it('preserves property order and renders non-string values as JSON', () => {
      expect(f('{"level":"INFO","msg":"hi","count":3,"meta":{"a":1}}')).toBe(
        '[INFO] hi\n  count: 3\n  meta: {"a":1}',
      );
    });

    it('handles a level with no message, and a message with no level', () => {
      expect(f('{"level":"INFO","port":1}')).toBe('[INFO]\n  port: 1');
      expect(f('{"msg":"hi","x":1}')).toBe('hi\n  x: 1');
    });
  });

  describe('level matching (case-insensitive, aliases → canonical)', () => {
    const f = fmt();

    it('uppercases and matches string levels', () => {
      expect(f('{"level":"info","msg":"x"}')).toBe('[INFO] x');
      expect(f('{"level":"Warn","msg":"x"}')).toBe('[WARN] x');
    });

    it('folds aliases onto the canonical level', () => {
      expect(f('{"level":"warning","msg":"x"}')).toBe('[WARN] x'); // WARNING → WARN
      expect(f('{"level":"err","msg":"x"}')).toBe('[ERROR] x'); // ERR → ERROR
      expect(f('{"level":"critical","msg":"x"}')).toBe('[FATAL] x'); // CRITICAL → FATAL
    });

    it('marks an unmatched string level unknown (uppercased)', () => {
      expect(f('{"level":"audit","msg":"x"}')).toBe('[UNKNOWN LOGLVL: AUDIT] x');
    });

    it('never guesses a numeric level — unknown without a map', () => {
      expect(f('{"level":30,"msg":"x"}')).toBe('[UNKNOWN LOGLVL: 30] x');
    });
  });

  describe('config shape { fields, levels }', () => {
    it('reads level/message/custom under `fields` and the map under `levels`', () => {
      const f2 = fmt({
        fields: { level: 'lvl', message: 'text', custom: { t: { show: false } } },
        levels: { 5: 'error' },
      });
      expect(f2('{"lvl":5,"text":"boom","t":"hidden","a":2}')).toBe('[ERROR] boom\n  a: 2');
    });
  });

  describe('custom (rename / hide)', () => {
    it('renames via the string shorthand and the long form', () => {
      expect(fmt({ fields: { custom: { timestamp: 'ts' } } })('{"level":"INFO","msg":"hi","ts":"T"}')).toBe('[INFO] hi\n  timestamp: T'); // prettier-ignore
      expect(fmt({ fields: { custom: { timestamp: { source: 'ts' } } } })('{"level":"INFO","msg":"hi","ts":"T"}')).toBe('[INFO] hi\n  timestamp: T'); // prettier-ignore
    });

    it('hides a property with { show: false }', () => {
      expect(fmt({ fields: { custom: { time: { show: false } } } })('{"level":"INFO","msg":"hi","time":"T","port":1}')).toBe('[INFO] hi\n  port: 1'); // prettier-ignore
    });

    it('accepts a callback that decides the mapping from the log itself', () => {
      // `at` is only noise on message-ingest events; keep it everywhere else.
      const f = fmt({
        fields: {
          custom: (log) => ({
            time: { show: false },
            ...(log.context === 'message-ingest' ? { at: { show: false } } : {}),
          }),
        },
      });
      expect(f('{"level":"INFO","msg":"message stored","context":"message-ingest","at":"T","from":"Mama"}')).toBe('[INFO] message stored\n  context: message-ingest\n  from: Mama'); // prettier-ignore
      expect(f('{"level":"INFO","msg":"started","context":"bridge","at":"T"}')).toBe('[INFO] started\n  context: bridge\n  at: T'); // prettier-ignore
      // the statically-hidden field stays hidden in both branches
      expect(f('{"level":"INFO","msg":"hi","time":"T"}')).toBe('[INFO] hi');
    });

    it('re-resolves the callback per line, and supports renaming from it', () => {
      const seen: unknown[] = [];
      const f = fmt({
        fields: {
          custom: (log) => {
            seen.push(log.context);
            return log.context === 'ingest' ? { when: 'at' } : {};
          },
        },
      });
      expect(f('{"level":"INFO","msg":"a","context":"ingest","at":"T"}')).toBe('[INFO] a\n  context: ingest\n  when: T'); // prettier-ignore
      expect(f('{"level":"INFO","msg":"b","context":"other","at":"T"}')).toBe('[INFO] b\n  context: other\n  at: T'); // prettier-ignore
      expect(seen).toEqual(['ingest', 'other']);
    });

    it('does not invoke the callback for lines that pass through unformatted', () => {
      let calls = 0;
      const f = fmt({
        fields: {
          custom: () => {
            calls++;
            return {};
          },
        },
      });
      f('not json at all');
      f('{"foo":1}'); // JSON, but no level/message
      expect(calls).toBe(0);
    });
  });

  describe('logging.nodejs.pino.formatter', () => {
    it('maps pino numeric levels to canonical levels', () => {
      const f2 = (line: string) => stripAnsi(logging.nodejs.pino.formatter()(line));
      expect(f2('{"level":30,"msg":"hi","reqId":"a"}')).toBe('[INFO] hi\n  reqId: a');
      expect(f2('{"level":60,"msg":"boom"}')).toBe('[FATAL] boom');
      expect(f2('{"level":99,"msg":"x"}')).toBe('[UNKNOWN LOGLVL: 99] x'); // unmapped stays unknown
    });
  });

  describe('logging.nodejs.winston.formatter', () => {
    const f2 = (line: string) => stripAnsi(logging.nodejs.winston.formatter()(line));
    it("uses winston's `message` key and level names", () => {
      expect(f2('{"level":"warn","message":"careful","code":5}')).toBe('[WARN] careful\n  code: 5');
      expect(f2('{"level":"http","message":"GET /"}')).toBe('[DEBUG] GET /'); // http → DEBUG
    });
  });

  describe('coloring', () => {
    const original = chalk.level;
    beforeAll(() => {
      chalk.level = 3; // force truecolor so the tokens actually carry ANSI
    });
    afterAll(() => {
      chalk.level = original;
    });

    it('colors the bracketed token of a matched level, leaves unknown uncolored', () => {
      expect(createFormatter()('{"level":"error","msg":"boom"}')).toBe(`${chalk.red('[ERROR]')} boom`); // prettier-ignore
      expect(createFormatter()('{"level":"info","msg":"ok"}')).toBe(`${chalk.green('[INFO]')} ok`);
      expect(createFormatter()('{"level":30,"msg":"x"}')).toBe('[UNKNOWN LOGLVL: 30] x'); // uncolored
    });

    it('colors property keys distinctly from their (plain) values', () => {
      expect(createFormatter()('{"level":"info","msg":"hi","count":1}')).toBe(
        `${chalk.green('[INFO]')} hi\n  ${chalk.gray('count:')} 1`,
      );
    });
  });
});

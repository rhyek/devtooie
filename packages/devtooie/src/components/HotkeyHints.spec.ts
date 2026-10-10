import { Box, Text, render } from 'ink';
import { Writable } from 'node:stream';
import React from 'react';
import { describe, expect, test } from 'vitest';
import { HotkeyHints } from './HotkeyHints.js';

const h = React.createElement;

/** Renders `element` once at `columns` wide and returns the frame's lines, ANSI stripped. */
function renderFrame(element: React.ReactElement, columns: number): string[] {
  let out = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        out += String(chunk);
        callback();
      },
    }),
    { columns },
  );
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  instance.unmount();
  // eslint-disable-next-line no-control-regex
  const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  // `debug` writes the frame again on unmount; keep the first copy.
  return lines.slice(0, Math.ceil(lines.length / 2));
}

describe('HotkeyHints', () => {
  test('a hint sharing a row with a long wrappable text is never broken across lines', () => {
    // Mirrors the footer's logfile row: the path wraps, `t: rotate` must not.
    for (const columns of [48, 56, 64, 72]) {
      const lines = renderFrame(
        h(
          Box,
          { width: columns, columnGap: 2 },
          h(Text, { dimColor: true }, 'logfile: node_modules/.devtooie/logs/178871-2204526.log'),
          h(HotkeyHints, { hints: [{ key: 't', label: 'rotate' }] }),
        ),
        columns,
      );
      expect(
        lines.some((line) => line.includes('t: rotate')),
        `at ${columns} columns`,
      ).toBe(true);
      expect(
        lines.some((line) => /\bt:\s*$/.test(line)),
        `at ${columns} columns`,
      ).toBe(false);
    }
  });

  test('hints still wrap between items when a column parent is narrower than the row', () => {
    const lines = renderFrame(
      h(
        Box,
        { width: 30, flexDirection: 'column' },
        h(HotkeyHints, {
          hints: [
            { key: 'k', label: 'clear' },
            { key: 'f', label: 'filter' },
            { separator: true },
            { key: '^c', label: 'quit' },
          ],
        }),
      ),
      30,
    );
    const text = lines.join('\n');
    expect(text).toContain('k: clear');
    expect(text).toContain('f: filter');
    expect(text).toContain('^c: quit');
    // Too wide for one 30-column line, so it must have wrapped between hints.
    expect(lines.filter((line) => line.trim() !== '').length).toBeGreaterThan(1);
  });
});

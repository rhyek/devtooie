import { describe, it, expect } from 'vitest';
import { isMouseSequence, parseMouseEvents } from './mouse.js';

const ESC = String.fromCharCode(27);
/** Build an SGR mouse report: button byte `cb` at 1-based (col,row); `release` uses the `m` terminator. */
const sgr = (cb: number, col: number, row: number, release = false) =>
  `${ESC}[<${cb};${col};${row}${release ? 'm' : 'M'}`;

describe('parseMouseEvents', () => {
  it('decodes a left-button press', () => {
    expect(parseMouseEvents(sgr(0, 10, 5))).toEqual([{ type: 'down', button: 0, col: 10, row: 5 }]);
  });

  it('decodes drag-motion (button held) via the motion bit (32)', () => {
    expect(parseMouseEvents(sgr(32, 11, 5))).toEqual([
      { type: 'move', button: 0, col: 11, row: 5 },
    ]);
  });

  it('decodes a release via the `m` terminator', () => {
    expect(parseMouseEvents(sgr(0, 12, 5, true))).toEqual([
      { type: 'up', button: 0, col: 12, row: 5 },
    ]);
  });

  it('decodes wheel up (64) and wheel down (65)', () => {
    expect(parseMouseEvents(sgr(64, 3, 3))).toEqual([{ type: 'wheel', dir: 'up', col: 3, row: 3 }]);
    expect(parseMouseEvents(sgr(65, 3, 3))).toEqual([
      { type: 'wheel', dir: 'down', col: 3, row: 3 },
    ]);
  });

  it('decodes several reports packed into one read, in order', () => {
    const chunk = sgr(0, 1, 1) + sgr(32, 2, 1) + sgr(32, 3, 1) + sgr(0, 3, 1, true);
    expect(parseMouseEvents(chunk).map((e) => e.type)).toEqual(['down', 'move', 'move', 'up']);
  });

  it('still parses when the leading ESC has been stripped by the input layer', () => {
    expect(parseMouseEvents(`[<0;7;2M`)).toEqual([{ type: 'down', button: 0, col: 7, row: 2 }]);
  });

  it('ignores non-mouse input (plain keys, arrow-key CSI)', () => {
    expect(parseMouseEvents('a')).toEqual([]);
    expect(parseMouseEvents(`${ESC}[A`)).toEqual([]); // up arrow
  });
});

describe('isMouseSequence', () => {
  it('is true for an SGR mouse report (with or without ESC) and false otherwise', () => {
    expect(isMouseSequence(sgr(0, 1, 1))).toBe(true);
    expect(isMouseSequence('[<0;1;1M')).toBe(true);
    expect(isMouseSequence('hello')).toBe(false);
    expect(isMouseSequence(`${ESC}[B`)).toBe(false); // down arrow, not a mouse report
  });
});

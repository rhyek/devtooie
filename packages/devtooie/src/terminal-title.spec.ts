import { describe, it, expect } from 'vitest';
import { setTitleSequence, stripTitleSequences } from './terminal-title.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('setTitleSequence', () => {
  it('emits an OSC 0 sequence that sets both icon and window title', () => {
    expect(setTitleSequence('devtooie: example')).toBe(`${ESC}]0;devtooie: example${BEL}`);
  });
});

describe('stripTitleSequences', () => {
  it('strips a BEL-terminated title sequence', () => {
    expect(stripTitleSequences(`before${ESC}]0;cd (node)${BEL}after`)).toBe('beforeafter');
  });

  it('strips an ST-terminated title sequence', () => {
    expect(stripTitleSequences(`${ESC}]2;git status${ESC}\\done`)).toBe('done');
  });

  it('strips OSC 1 (icon) and OSC 2 (window) as well as OSC 0', () => {
    expect(stripTitleSequences(`${ESC}]1;icon${BEL}x${ESC}]2;window${BEL}`)).toBe('x');
  });

  it('strips multiple title sequences in one chunk', () => {
    const chunk = `${ESC}]0;a${BEL}line${ESC}]0;b${BEL}`;
    expect(stripTitleSequences(chunk)).toBe('line');
  });

  it('preserves SGR color codes and surrounding text', () => {
    const colored = `${ESC}[31mred${ESC}[39m`;
    expect(stripTitleSequences(`${ESC}]0;title${BEL}${colored}`)).toBe(colored);
  });

  it('leaves output without a title sequence untouched', () => {
    expect(stripTitleSequences('plain log line')).toBe('plain log line');
    expect(stripTitleSequences(`${ESC}[1mbold${ESC}[0m`)).toBe(`${ESC}[1mbold${ESC}[0m`);
  });
});

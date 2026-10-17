import { render } from 'ink';
import { Writable } from 'node:stream';
import React from 'react';
import { describe, expect, test } from 'vitest';
import { stripAnsi } from '../lib.js';
import { LinksColumn } from './NativeRunner.js';

const h = React.createElement;

/** Renders the column once at `columns` wide and returns its rows as plain text. */
function rows(props: React.ComponentProps<typeof LinksColumn>, columns = 80): string[] {
  let last = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        last = String(chunk);
        callback();
      },
    }),
    { columns },
  );
  const instance = render(h(LinksColumn, props), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  // Read before unmounting, which writes a frame of its own.
  const frame = last;
  instance.unmount();
  // Each link is an OSC 8 hyperlink, which `stripAnsi` leaves alone: drop its markers too.
  // eslint-disable-next-line no-control-regex -- matches OSC 8 hyperlink escape sequences
  return stripAnsi(frame.replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row !== '');
}

describe('LinksColumn', () => {
  test('lists the routed infra services under an `infra` heading, after the packages', () => {
    const out = rows({
      topLevelUrls: [],
      packageUrlGroups: [{ name: 'web', selected: true, urls: [[{ url: 'https://web.example.test' }]] }], // prettier-ignore
      infraUrls: [[{ url: 'https://s3.example.test' }], [{ url: 'https://mail.example.test' }]],
    });
    expect(out).toEqual([
      'web',
      'https://web.example.test',
      'infra',
      'https://s3.example.test',
      'https://mail.example.test',
    ]);
  });

  test('shows the infra links on their own when no package has any', () => {
    const out = rows({
      topLevelUrls: [],
      packageUrlGroups: [],
      infraUrls: [[{ url: 'https://mail.example.test' }]],
    });
    expect(out).toEqual(['infra', 'https://mail.example.test']);
  });

  test('renders nothing when there are no links at all', () => {
    expect(rows({ topLevelUrls: [], packageUrlGroups: [], infraUrls: [] })).toEqual([]);
  });
});

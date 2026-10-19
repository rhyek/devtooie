import { render } from 'ink';
import { Writable } from 'node:stream';
import React from 'react';
import { describe, expect, test } from 'vitest';
import { stripAnsi } from '../lib.js';
import { LinksColumn } from './NativeRunner.js';

const h = React.createElement;

/** Renders the column once at `columns` wide and returns the raw frame. */
function frame(props: React.ComponentProps<typeof LinksColumn>, columns = 80): string {
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
  const out = last;
  instance.unmount();
  return out;
}

/** Renders the column once at `columns` wide and returns its rows as plain text. */
function rows(props: React.ComponentProps<typeof LinksColumn>, columns = 80): string[] {
  // Each link is an OSC 8 hyperlink, which `stripAnsi` leaves alone: drop its markers too.
  // eslint-disable-next-line no-control-regex -- matches OSC 8 hyperlink escape sequences
  return stripAnsi(frame(props, columns).replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row !== '');
}

describe('LinksColumn', () => {
  test('lists the routed infra services under an `infra` heading, after the packages', () => {
    const out = rows({
      topLevelUrls: [],
      packageUrlGroups: [{ name: 'web', selected: true, urls: [[{ label: 'home', url: 'https://web.example.test' }]] }], // prettier-ignore
      infraUrls: [[{ url: 'https://s3.example.test' }], [{ url: 'https://mail.example.test' }]],
    });
    expect(out).toEqual([
      'web',
      'home',
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

  test("makes a package's heading the link when its urls are one unlabelled link", () => {
    const out = rows(
      {
        topLevelUrls: [],
        packageUrlGroups: [
          { name: 'web', selected: true, urls: [[{ url: 'https://web.example.test' }]] },
          { name: 'api', selected: false, urls: [[{ label: 'health', url: 'https://api.example.test/health' }]] }, // prettier-ignore
          { name: 'docs', selected: false, urls: [[{ url: 'https://docs.example.test' }], [{ url: 'https://docs.example.test/api' }]] }, // prettier-ignore
          { name: 'admin', selected: false, urls: [[{ url: 'https://admin.example.test' }, { url: 'https://admin.example.test/logs' }]] }, // prettier-ignore
        ],
        infraUrls: [[{ url: 'https://mail.example.test' }]],
      },
      120,
    );
    expect(out).toEqual([
      'web',
      'api',
      'health',
      'docs',
      'https://docs.example.test',
      'https://docs.example.test/api',
      'admin',
      'https://admin.example.test https://admin.example.test/logs',
      'infra',
      'https://mail.example.test',
    ]);
  });

  test('links the heading to the url', () => {
    const out = frame({
      topLevelUrls: [],
      packageUrlGroups: [
        { name: 'web', selected: false, urls: [[{ url: 'https://web.example.test' }]] },
      ],
    });
    expect(out).toContain('\x1b]8;;https://web.example.test\x07web\x1b]8;;\x07');
  });

  test('renders nothing when there are no links at all', () => {
    expect(rows({ topLevelUrls: [], packageUrlGroups: [], infraUrls: [] })).toEqual([]);
  });
});

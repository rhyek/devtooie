import { Writable } from 'node:stream';
import React from 'react';
import chalk from 'chalk';
import { render } from 'ink';
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
  // oxlint-disable-next-line no-control-regex -- matches OSC 8 hyperlink escape sequences
  return stripAnsi(frame(props, columns).replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row !== '');
}

describe('LinksColumn', () => {
  test('lists the infra services that declare urls under an `infra` caption, after the packages', () => {
    const out = rows({
      topLevelUrls: [],
      packageUrlGroups: [{ name: 'web', selected: true, urls: [[{ label: 'home', url: 'https://web.example.test' }]] }], // oxfmt-ignore
      infraUrlGroups: [
        { name: 'mail', selected: false, urls: [[{ url: 'https://mail.example.test' }]] },
        { name: 'store', selected: false, urls: [[{ label: 'console', url: 'https://store.example.test/console' }]] }, // oxfmt-ignore
      ],
    });
    // `mail`'s one unlabelled link is its name; `store`'s labelled one goes under its name.
    expect(out).toEqual(['web', 'home', 'infra', 'mail', 'store', 'console']);
  });

  test("links an infra service's name to its one unlabelled url", () => {
    const out = frame({
      topLevelUrls: [],
      packageUrlGroups: [],
      infraUrlGroups: [{ name: 'mail', selected: false, urls: [[{ url: 'https://mail.example.test' }]] }], // oxfmt-ignore
    });
    expect(out).toContain('\x1b]8;;https://mail.example.test\x07mail\x1b]8;;\x07');
    expect(rows({ topLevelUrls: [], packageUrlGroups: [], infraUrlGroups: [{ name: 'mail', selected: false, urls: [[{ url: 'https://mail.example.test' }]] }] })).toEqual(['infra', 'mail']); // oxfmt-ignore
  });

  test('draws the `infra` caption in the default text color, apart from the links under it', () => {
    const original = chalk.level;
    let out: string;
    try {
      chalk.level = 3; // force truecolor so the frame carries its colors
      out = frame({
        topLevelUrls: [],
        packageUrlGroups: [],
        infraUrlGroups: [{ name: 'mail', selected: false, urls: [[{ url: 'https://mail.example.test' }]] }], // oxfmt-ignore
      });
    } finally {
      chalk.level = original;
    }
    const [caption, link] = out.split('\n').filter((row) => stripAnsi(row).trim() !== '');
    expect(stripAnsi(caption ?? '').trim()).toBe('infra');
    expect(caption).not.toContain('\x1b[3'); // no foreground color
    expect(link).toContain('\x1b[38;2;'); // the link color, for contrast
  });

  test("makes a package's heading the link when its urls are one unlabelled link", () => {
    const out = rows(
      {
        topLevelUrls: [],
        packageUrlGroups: [
          { name: 'web', selected: true, urls: [[{ url: 'https://web.example.test' }]] },
          { name: 'api', selected: false, urls: [[{ label: 'health', url: 'https://api.example.test/health' }]] }, // oxfmt-ignore
          { name: 'docs', selected: false, urls: [[{ url: 'https://docs.example.test' }], [{ url: 'https://docs.example.test/api' }]] }, // oxfmt-ignore
          { name: 'admin', selected: false, urls: [[{ url: 'https://admin.example.test' }, { url: 'https://admin.example.test/logs' }]] }, // oxfmt-ignore
        ],
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
    expect(rows({ topLevelUrls: [], packageUrlGroups: [], infraUrlGroups: [] })).toEqual([]);
  });
});

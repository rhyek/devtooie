import { Box, Text } from 'ink';
import React from 'react';
import { HOTKEY_KEY_COLOR, HOTKEY_LABEL_COLOR } from '../colors.js';

/**
 * One entry in a hotkey-hints row: a labelled key, a dim group `header` (e.g. `logs:`)
 * prefixed to the keys that follow it, or a visual separator between groups of keys.
 */
export type HotkeyHintItem =
  { key: string; label: string; dim?: boolean } | { separator: true } | { header: string };

export type HotkeyHintsProps = {
  hints: HotkeyHintItem[];
  /** Horizontal gap (columns) between hint entries. */
  gap?: number;
};

/**
 * Reusable footer/header renderer for a row of `key: label` hotkey hints.
 *
 * The row never shrinks below its content (`flexShrink: 0`), so a hint is never broken
 * across lines — a row parent squeezing it (the logfile path next to `t: rotate`) has to
 * squeeze its other, wrappable children instead. Hints still wrap *between* items when a
 * column parent stretches the row to a width narrower than all of them on one line.
 */
export function HotkeyHints({ hints, gap = 2 }: HotkeyHintsProps) {
  return (
    <Box flexWrap="wrap" columnGap={gap} flexShrink={0}>
      {hints.map((hint, i) => {
        if ('separator' in hint) {
          return (
            <Text key={`separator-${i}`} dimColor>
              │
            </Text>
          );
        }
        if ('header' in hint) {
          return (
            <Text key={`header-${i}`} dimColor>
              {hint.header}:
            </Text>
          );
        }
        if (hint.dim) {
          return (
            <Box key={hint.key} flexShrink={0}>
              <Text dimColor>
                {hint.key}: {hint.label}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={hint.key} flexShrink={0}>
            <Text color={HOTKEY_KEY_COLOR} bold>
              {hint.key}
            </Text>
            <Text color={HOTKEY_LABEL_COLOR}>: {hint.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

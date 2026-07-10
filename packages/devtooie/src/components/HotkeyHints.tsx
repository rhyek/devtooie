import { Box, Text } from 'ink';
import React from 'react';

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

/** Reusable footer/header renderer for a row of `key: label` hotkey hints, wrapping as needed. */
export function HotkeyHints({ hints, gap = 2 }: HotkeyHintsProps) {
  return (
    <Box flexWrap="wrap" columnGap={gap}>
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
            <Text color="white" bold>
              {hint.key}
            </Text>
            <Text color="#bbbbbb">: {hint.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

import { Box, Text, useApp, useInput } from 'ink';
import React, { useMemo, useState } from 'react';
import type { AnyPackageConfig } from '../config.js';
import { HotkeyHints } from './HotkeyHints.js';

export type PackageSelectorProps = {
  /** Selectable packages in display order, as returned by `getSelectablePackages()`. */
  items: AnyPackageConfig[];
  /** App name -> its runtime dep pkg names, as returned by `getRuntimeDepsMap()`. */
  runtimeDeps: Record<string, string[]>;
  initialSelected?: string[];
  onSubmit: (selected: string[]) => void;
};

/**
 * Single-column multi-select for choosing which packages to run: up/down move a
 * cursor over the list, space toggles the pkg under the cursor, and a selected
 * pkg's runtime deps are auto-included (shown locked, un-toggleable) so the choice
 * always yields a runnable set.
 */
export function PackageSelector({
  items,
  runtimeDeps,
  initialSelected = [],
  onSubmit,
}: PackageSelectorProps) {
  const { exit } = useApp();

  const itemNames = useMemo(() => new Set(items.map((a) => a.name)), [items]);

  const [row, setRow] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));

  // Runtime deps of selected packages that are also visible in the selector: shown
  // locked-in rather than toggleable, mapped to the pkg name that pulled them in.
  const locked = useMemo(() => {
    const result = new Map<string, string>();
    for (const name of selected) {
      for (const dep of runtimeDeps[name] ?? []) {
        if (itemNames.has(dep) && !selected.has(dep) && !result.has(dep)) {
          result.set(dep, name);
        }
      }
    }
    return result;
  }, [selected, runtimeDeps, itemNames]);

  useInput((input, key) => {
    if (items.length === 0) {
      return;
    }
    if (input === 'c' && key.ctrl) {
      exit();
      process.exit(0);
    } else if (key.downArrow) {
      setRow((r) => (r + 1) % items.length);
    } else if (key.upArrow) {
      setRow((r) => (r - 1 + items.length) % items.length);
    } else if (input === ' ') {
      const item = items[row]!;
      if (locked.has(item.name)) {
        return;
      }
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.name)) {
          next.delete(item.name);
        } else {
          next.add(item.name);
        }
        return next;
      });
    } else if (input === 'c') {
      setSelected(new Set());
    } else if (key.return) {
      if (selected.size === 0 && locked.size === 0) {
        return;
      }
      onSubmit([...selected]);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text backgroundColor="cyan" color="black" bold>
          {' devtooie '}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>Select packages to run</Text>
      </Box>
      <HotkeyHints
        hints={[
          { key: 'space', label: 'toggle' },
          { key: '↑↓', label: 'navigate' },
          { key: 'c', label: 'clear' },
          { key: 'enter', label: 'confirm' },
          { key: '^c', label: 'exit' },
        ]}
        gap={3}
      />
      {items.length === 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">No selectable packages configured.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {items.map((item, ii) => {
            const isActive = row === ii;
            const isSelected = selected.has(item.name);
            const lockedBy = locked.get(item.name);
            const isLocked = Boolean(lockedBy);

            let checkbox: string;
            let color: string | undefined;
            let suffix = '';

            if (isLocked) {
              checkbox = '■';
              color = 'gray';
              suffix = ` (required by ${lockedBy})`;
            } else if (isSelected) {
              checkbox = '■';
              color = isActive ? 'cyan' : 'green';
            } else {
              checkbox = '□';
              color = isActive ? 'cyan' : undefined;
            }

            return (
              <Box key={item.name}>
                <Text color={color}>
                  {isActive ? '❯' : ' '} {checkbox} {item.name}
                </Text>
                {isLocked && <Text color="gray">{suffix}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

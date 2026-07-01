import { Box, Text, useApp, useInput } from 'ink';
import React, { useMemo, useState } from 'react';
import type { AnyAppConfig } from '../config.js';
import { HotkeyHints } from './HotkeyHints.js';

/** One labelled column of the grid (e.g. "Backend" / "Frontend"), fed by `getServiceGroups()`. */
export type ServiceSelectorGroup = { label: string; items: AnyAppConfig[] };

export type ServiceSelectorProps = {
  groups: ServiceSelectorGroup[];
  /** App name -> its runtime dep app names, as returned by `getRuntimeDepsMap()`. */
  runtimeDeps: Record<string, string[]>;
  initialSelected?: string[];
  onSubmit: (selected: string[]) => void;
};

/**
 * Grouped multi-select for choosing which services to run: arrow keys move a
 * cursor across a grid of labelled columns, space toggles the app under the
 * cursor, and a selected app's runtime deps are auto-included (shown locked,
 * un-toggleable) so the choice always yields a runnable set.
 */
export function ServiceSelector({
  groups,
  runtimeDeps,
  initialSelected = [],
  onSubmit,
}: ServiceSelectorProps) {
  const { exit } = useApp();

  // Columns with no selectable apps would break grid navigation (an empty
  // items array has no valid row index), so they're dropped up front.
  const visibleGroups = useMemo(() => groups.filter((g) => g.items.length > 0), [groups]);

  const allItemNames = useMemo(() => {
    const names = new Set<string>();
    for (const group of visibleGroups) {
      for (const item of group.items) {
        names.add(item.name);
      }
    }
    return names;
  }, [visibleGroups]);

  const [col, setCol] = useState(0);
  const [row, setRow] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));

  // Runtime deps of selected apps that are also visible in the selector: shown
  // locked-in rather than toggleable, mapped to the app name that pulled them in.
  const locked = useMemo(() => {
    const result = new Map<string, string>();
    for (const name of selected) {
      for (const dep of runtimeDeps[name] ?? []) {
        if (allItemNames.has(dep) && !selected.has(dep) && !result.has(dep)) {
          result.set(dep, name);
        }
      }
    }
    return result;
  }, [selected, runtimeDeps, allItemNames]);

  useInput((input, key) => {
    if (visibleGroups.length === 0) {
      return;
    }
    if (input === 'c' && key.ctrl) {
      exit();
      process.exit(0);
    } else if (key.downArrow) {
      const items = visibleGroups[col]!.items;
      if (row < items.length - 1) {
        setRow(row + 1);
      } else if (col < visibleGroups.length - 1) {
        setCol(col + 1);
        setRow(0);
      } else {
        setCol(0);
        setRow(0);
      }
    } else if (key.upArrow) {
      if (row > 0) {
        setRow(row - 1);
      } else if (col > 0) {
        setCol(col - 1);
        setRow(visibleGroups[col - 1]!.items.length - 1);
      } else {
        const lastCol = visibleGroups.length - 1;
        setCol(lastCol);
        setRow(visibleGroups[lastCol]!.items.length - 1);
      }
    } else if (key.rightArrow) {
      const nextCol = (col + 1) % visibleGroups.length;
      setCol(nextCol);
      setRow(Math.min(row, visibleGroups[nextCol]!.items.length - 1));
    } else if (key.leftArrow) {
      const prevCol = (col - 1 + visibleGroups.length) % visibleGroups.length;
      setCol(prevCol);
      setRow(Math.min(row, visibleGroups[prevCol]!.items.length - 1));
    } else if (input === ' ') {
      const item = visibleGroups[col]!.items[row]!;
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
        <Text bold>Select services to run</Text>
      </Box>
      <HotkeyHints
        hints={[
          { key: 'space', label: 'toggle' },
          { key: '↑↓←→', label: 'navigate' },
          { key: 'c', label: 'clear' },
          { key: 'enter', label: 'confirm' },
          { key: '^c', label: 'exit' },
        ]}
        gap={3}
      />
      {visibleGroups.length === 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">No selectable services configured.</Text>
        </Box>
      ) : (
        <Box flexDirection="row" marginTop={1} columnGap={4}>
          {visibleGroups.map((group, gi) => (
            <Box key={group.label} flexDirection="column">
              <Text bold color="white">
                {group.label}
              </Text>
              {group.items.map((item, ii) => {
                const isActive = col === gi && row === ii;
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
          ))}
        </Box>
      )}
    </Box>
  );
}

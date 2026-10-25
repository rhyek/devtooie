import { defineConfig } from 'oxfmt';

export default defineConfig({
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  sortPackageJson: false,
  ignorePatterns: [
    // Build + cache output (mirrors oxlint.config.ts's ignorePatterns)
    '**/dist/**',
    '**/build/**',
    '**/.output/**',
    '**/.tanstack/**',
    // Generated — never hand-formatted
    '**/routeTree.gen.ts',
    // Lockfiles
    'pnpm-lock.yaml',
  ],
  // Import order: builtin, then react and @tanstack/**, other packages, the workspace's own
  // @example/** packages, the app's ~/ alias, then parent, sibling and index imports. Alphabetical
  // within a group, ignoring case, with no blank line between groups. Side-effect imports stay
  // where they are.
  sortImports: {
    newlinesBetween: false,
    ignoreCase: true,
    order: 'asc',
    internalPattern: [],
    customGroups: [
      { groupName: 'react', elementNamePattern: ['react', 'react-dom', 'react-dom/**'] },
      { groupName: 'tanstack', elementNamePattern: ['@tanstack/**'] },
      { groupName: 'workspace', elementNamePattern: ['@example/**'] },
      { groupName: 'alias', elementNamePattern: ['~/**'] },
    ],
    groups: [
      'builtin',
      'react',
      'tanstack',
      'external',
      'workspace',
      'alias',
      'parent',
      'sibling',
      'index',
      'unknown',
    ],
  },
  overrides: [
    {
      // shadcn/ui's CLI output, kept as generated so `shadcn diff` stays clean.
      files: ['apps/frontend/src/components/ui/**'],
      options: { sortImports: false },
    },
  ],
});

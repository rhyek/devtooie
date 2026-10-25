import { defineConfig } from 'oxfmt';

export default defineConfig({
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  sortPackageJson: false,
  // Import order: builtin, then react, other packages, then parent, sibling and index imports.
  // Alphabetical within a group, ignoring case, with no blank line between groups. Side-effect
  // imports stay where they are.
  sortImports: {
    newlinesBetween: false,
    ignoreCase: true,
    order: 'asc',
    customGroups: [{ groupName: 'react', elementNamePattern: ['react'] }],
    groups: ['builtin', 'react', 'external', 'internal', 'parent', 'sibling', 'index', 'unknown'],
  },
  ignorePatterns: [
    // `example/` is a nested workspace with its own oxfmt config — don't format it from here.
    'example/**',
    // README, CHANGELOG and the docs are formatted by hand.
    '**/*.md',
    // managed by pnpm
    'pnpm-lock.yaml',
  ],
});

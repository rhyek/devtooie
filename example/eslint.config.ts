// Shared flat ESLint config for every TypeScript package in this example workspace.
// Not type-aware (no parserOptions.project): linting stays fast and needs only the root install.
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/routeTree.gen.ts',
    '**/devtooie-env.d.ts',
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      curly: ['error', 'all'],
      'unused-imports/no-unused-imports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // React lives in .tsx files. Also give browser globals to client DOM code.
  {
    files: ['**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
    // eslint-plugin-react / -react-hooks ship types that don't satisfy ESLint 10's flat-config
    // `Plugin` type; they work fine at runtime. Cast to keep the rest of this file type-checked.
    plugins: { react, 'react-hooks': reactHooks } as Record<string, import('eslint').ESLint.Plugin>,
    // Hardcoded rather than 'detect': the plugin's version detection throws under ESLint 10 flat
    // config. Keep in sync with the React version the frontend uses.
    settings: { react: { version: '19.2' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/prop-types': 'off',
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Prettier LAST: runs Prettier as the `prettier/prettier` rule and disables conflicting rules.
  prettierRecommended,
]);

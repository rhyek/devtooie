// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/build/**', '**/node_modules/**']),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // This is a Node.js CLI project; Node globals (process, console, etc.)
    // are available everywhere, including plain scripts like postinstall.mjs.
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
  // React (Ink) components live in .tsx files.
  {
    files: ['**/*.tsx'],
    // eslint-plugin-react / -react-hooks @7.x ship types that don't satisfy ESLint 10's
    // flat-config `Plugin` type, which (via defineConfig) poisons the whole config array's
    // type under `// @ts-check`. They work fine at runtime; cast to keep type-checking the
    // rest of this file.
    plugins: /** @type {Record<string, import('eslint').ESLint.Plugin>} */ ({
      react,
      'react-hooks': reactHooks,
    }),
    // Hardcoded rather than 'detect': eslint-plugin-react@7.37.5's version
    // detection calls the removed `context.getFilename()` API under
    // ESLint 10's flat config, which throws. Keep in sync with the
    // `react` dependency version in package.json.
    settings: { react: { version: '19.2.7' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/prop-types': 'off',
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Prettier LAST: eslint-plugin-prettier/recommended runs Prettier as the
  // `prettier/prettier` rule and disables ESLint's conflicting formatting rules.
  prettierRecommended,
]);

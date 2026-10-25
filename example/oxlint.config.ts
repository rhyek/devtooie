// Shared lint config for every TypeScript package in this example workspace: eslint's recommended
// rules, typescript-eslint's recommended set, and eslint-plugin-react's recommended + jsx-runtime
// sets with the classic hooks rules on `.tsx`. typescript-eslint's type-checked rules run through
// oxlint-tsgolint. Formatting is oxfmt's (oxfmt.config.ts).
import { type DummyRuleMap, defineConfig } from 'oxlint';

const errors = (names: string[]): DummyRuleMap =>
  Object.fromEntries(names.map((name) => [name, 'error']));
const off = (names: string[]): DummyRuleMap =>
  Object.fromEntries(names.map((name) => [name, 'off']));

const ESLINT_RECOMMENDED = errors([
  'constructor-super',
  'for-direction',
  'getter-return',
  'no-async-promise-executor',
  'no-case-declarations',
  'no-class-assign',
  'no-compare-neg-zero',
  'no-cond-assign',
  'no-const-assign',
  'no-constant-binary-expression',
  'no-constant-condition',
  'no-control-regex',
  'no-debugger',
  'no-delete-var',
  'no-dupe-class-members',
  'no-dupe-else-if',
  'no-dupe-keys',
  'no-duplicate-case',
  'no-empty',
  'no-empty-character-class',
  'no-empty-pattern',
  'no-empty-static-block',
  'no-ex-assign',
  'no-extra-boolean-cast',
  'no-fallthrough',
  'no-func-assign',
  'no-global-assign',
  'no-import-assign',
  'no-invalid-regexp',
  'no-irregular-whitespace',
  'no-loss-of-precision',
  'no-misleading-character-class',
  'no-new-native-nonconstructor',
  'no-nonoctal-decimal-escape',
  'no-obj-calls',
  'no-prototype-builtins',
  'no-redeclare',
  'no-regex-spaces',
  'no-self-assign',
  'no-setter-return',
  'no-shadow-restricted-names',
  'no-sparse-arrays',
  'no-this-before-super',
  'no-unreachable',
  'no-unsafe-finally',
  'no-unsafe-negation',
  'no-unsafe-optional-chaining',
  'no-undef',
  'no-unassigned-vars',
  'no-unexpected-multiline',
  'no-unused-labels',
  'no-unused-private-class-members',
  'no-useless-backreference',
  'no-useless-catch',
  'no-useless-assignment',
  'no-useless-escape',
  'no-with',
  'preserve-caught-error',
  'require-yield',
  'use-isnan',
  'valid-typeof',
]);

// typescript-eslint's eslint-recommended: drops what the TypeScript compiler already checks.
const TYPESCRIPT_ESLINT_RECOMMENDED = {
  ...off([
    'constructor-super',
    'getter-return',
    'no-class-assign',
    'no-const-assign',
    'no-dupe-class-members',
    'no-dupe-keys',
    'no-func-assign',
    'no-import-assign',
    'no-new-native-nonconstructor',
    'no-obj-calls',
    'no-redeclare',
    'no-undef',
    'no-setter-return',
    'no-this-before-super',
    'no-unreachable',
    'no-unsafe-negation',
    'no-with',
  ]),
  ...errors(['no-var', 'prefer-const', 'prefer-rest-params', 'prefer-spread']),
};

// typescript-eslint's recommended set, `no-unused-vars` aside (configured below).
const TYPESCRIPT_RECOMMENDED = errors([
  'no-array-constructor',
  'no-unused-expressions',
  'typescript/ban-ts-comment',
  'typescript/no-duplicate-enum-values',
  'typescript/no-empty-object-type',
  'typescript/no-explicit-any',
  'typescript/no-extra-non-null-assertion',
  'typescript/no-misused-new',
  'typescript/no-namespace',
  'typescript/no-non-null-asserted-optional-chain',
  'typescript/no-require-imports',
  'typescript/no-this-alias',
  'typescript/no-unnecessary-type-constraint',
  'typescript/no-unsafe-declaration-merging',
  'typescript/no-unsafe-function-type',
  'typescript/no-wrapper-object-types',
  'typescript/prefer-as-const',
  'typescript/prefer-namespace-keyword',
  'typescript/triple-slash-reference',
]);

// typescript-eslint's recommended-type-checked set, less what recommended already holds. They need
// type information, which oxlint-tsgolint reads from each file's nearest tsconfig.json.
const TYPESCRIPT_TYPE_CHECKED = errors([
  'typescript/await-thenable',
  'typescript/no-array-delete',
  'typescript/no-base-to-string',
  'typescript/no-duplicate-type-constituents',
  'typescript/no-floating-promises',
  'typescript/no-for-in-array',
  'typescript/no-implied-eval',
  'typescript/no-misused-promises',
  'typescript/no-redundant-type-constituents',
  'typescript/no-unnecessary-type-assertion',
  'typescript/no-unsafe-argument',
  'typescript/no-unsafe-assignment',
  'typescript/no-unsafe-call',
  'typescript/no-unsafe-enum-comparison',
  'typescript/no-unsafe-member-access',
  'typescript/no-unsafe-return',
  'typescript/no-unsafe-unary-minus',
  'typescript/only-throw-error',
  'typescript/prefer-promise-reject-errors',
  'typescript/require-await',
  'typescript/restrict-plus-operands',
  'typescript/restrict-template-expressions',
  'typescript/unbound-method',
]);

// eslint-plugin-react's recommended set, less what its jsx-runtime set turns off
// (`react-in-jsx-scope`, `jsx-uses-react`) and `prop-types`, which TypeScript covers.
const REACT_RECOMMENDED = errors([
  'react/display-name',
  'react/jsx-key',
  'react/jsx-no-comment-textnodes',
  'react/jsx-no-duplicate-props',
  'react/jsx-no-target-blank',
  'react/jsx-no-undef',
  'react/no-children-prop',
  'react/no-danger-with-children',
  'react/no-direct-mutation-state',
  'react/no-find-dom-node',
  'react/no-is-mounted',
  'react/no-render-return-value',
  'react/no-string-refs',
  'react/no-unescaped-entities',
  'react/no-unknown-property',
  'react/require-render-return',
]);

export default defineConfig({
  plugins: ['eslint', 'typescript'],
  categories: {
    correctness: 'off',
  },
  // Unused disable directives warn, as in ESLint.
  options: {
    typeAware: true,
    reportUnusedDisableDirectives: 'warn',
  },
  env: {
    builtin: true,
    node: true,
  },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.output/**',
    '**/.tanstack/**',
    '**/routeTree.gen.ts',
  ],
  rules: {
    ...ESLINT_RECOMMENDED,
    ...TYPESCRIPT_RECOMMENDED,
    curly: ['error', 'all'],
    // One rule for unused variables and imports. Its `fix` makes `--fix` delete unused imports;
    // variables are only reported.
    'no-unused-vars': [
      'error',
      {
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        fix: {
          imports: 'safe-fix',
          variables: 'off',
        },
      },
    ],
    'typescript/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
    ],
    'typescript/no-import-type-side-effects': 'error',
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      rules: { ...TYPESCRIPT_ESLINT_RECOMMENDED, ...TYPESCRIPT_TYPE_CHECKED },
    },
    // React lives in .tsx files. Also give browser globals to client DOM code.
    {
      files: ['**/*.tsx'],
      plugins: ['eslint', 'typescript', 'react'],
      env: { browser: true },
      rules: {
        ...REACT_RECOMMENDED,
        'react/rules-of-hooks': 'error',
        'react/exhaustive-deps': 'warn',
      },
    },
    {
      files: ['**/*.d.ts'],
      rules: { 'no-unused-vars': 'off' },
    },
  ],
});

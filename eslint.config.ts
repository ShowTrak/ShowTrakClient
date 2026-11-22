import js from '@eslint/js';
import globals from 'globals';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import type { Linter } from 'eslint';

import { defineConfig } from 'eslint/config';

// ESLint loads this file through jiti (the `jiti` devDependency), which
// transpiles it on the fly. tsconfig.tooling.json typechecks it as part of
// `npm run typecheck`.

// A catch binding named after a built-in error constructor shadows that
// constructor for the whole block, so a `throw new Error(...)` inside the
// handler fails in a way that reads as impossible. The tree had seven of these
// (all named `Error`); none constructed an error, so none had actually broken
// yet. `no-shadow-restricted-names` does not cover this — it only guards
// undefined/NaN/Infinity/eval/arguments — and `no-shadow` with
// builtinGlobals:true is far too broad here, so this is targeted at the exact
// shape. `Err` is the convention used everywhere else in the codebase.
const NoShadowedErrorCatch: Linter.RulesRecord = {
  'no-restricted-syntax': [
    'error',
    {
      selector:
        'CatchClause > Identifier[name=/^(Error|TypeError|RangeError|SyntaxError|EvalError|ReferenceError|URIError|AggregateError)$/]',
      message:
        'Do not name a catch binding after a built-in error constructor — it shadows the global for the whole block. Use `Err`.',
    },
  ],
};

export default defineConfig([
  {
    ignores: [
      // Bootstrap's published CSS, input to scripts/purge-bootstrap-css.js.
      'scripts/vendor/**',
      'node_modules/**',
      'dist/**',
      'dist-test/**',
      // c8's generated HTML report (added with the coverage script in WP-0).
      'coverage/**',
      'out/**',
      // Types-only protocol submodule; linted in its own repo.
      'shared/**',
      '.vscode/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [
      js.configs.recommended, // Correct way to extend @eslint/js recommended config
      prettier,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Correct way to configure options for the 'no-unused-vars' rule
      'no-unused-vars': [
        'error', // Or "warn", depending on your preference
        {
          argsIgnorePattern: '^_[^_].*$|^_$',
          varsIgnorePattern: '^_[^_].*$|^_$',
          caughtErrorsIgnorePattern: '^_[^_].*$|^_$',
        },
      ],
      ...NoShadowedErrorCatch,
    },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      // Type-aware linting, for the no-unsafe-* rules below. Every linted .ts
      // file must belong to one of these programs: the main process and preloads
      // (tsconfig.json), the renderer (tsconfig.renderer.json), and the two
      // configs at the root (tsconfig.tooling.json). shared/ is not linted here
      // at all (see the ignores above).
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.renderer.json', './tsconfig.tooling.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The base rule must be off for the TypeScript-aware version to report
      // correctly; the options mirror the JS block above.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_[^_].*$|^_$',
          varsIgnorePattern: '^_[^_].*$|^_$',
          caughtErrorsIgnorePattern: '^_[^_].*$|^_$',
        },
      ],
      // The tree is clean of explicit `any`; keep it that way. When a boundary is
      // genuinely unknown, widen to `unknown` and narrow inside rather than `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      // ...and keep implicit `any` out too. These need type information (see
      // parserOptions above) and catch the `any` that arrives without being
      // written: JSON.parse, Array.isArray on an unknown, untyped library
      // fields, a stream's 'data' chunk. Narrow such a value from `unknown`
      // rather than letting it flow on as `any`.
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      // `require()` stays the idiom at a few CommonJS interop points — notably
      // the package.json version read in src/Modules/Config, which sits outside
      // rootDir and cannot be a plain import.
      '@typescript-eslint/no-require-imports': 'off',
      ...NoShadowedErrorCatch,
    },
  },
  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
  },
]);

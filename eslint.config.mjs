import js from '@eslint/js';
import globals from 'globals';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: [
      // Vendored browser libraries (jQuery, Bootstrap) shipped as-is.
      'src/UI/vendors/**',
      'node_modules/**',
      'dist/**',
      'dist-test/**',
      // c8's generated HTML report (added with the coverage script in WP-0).
      'coverage/**',
      'out/**',
      // Types-only protocol submodule; linted in its own repo.
      'shared/**',
      'forge.config.mjs',
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
    },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
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
      // `require()` stays the idiom at a few CommonJS interop points — notably
      // the package.json version read in src/Modules/Config, which sits outside
      // rootDir and cannot be a plain import.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
  },
]);

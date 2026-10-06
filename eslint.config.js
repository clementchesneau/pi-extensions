import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['work/', '.fallow/'] },
  js.configs.recommended,
  {
    // Exceptions belong in this file, where review sees them, not in source comments.
    linterOptions: { noInlineConfig: true },
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Terminal output sanitization matches control characters on purpose.
      'no-control-regex': 'off',
    },
  },
  {
    // Size and complexity limits keep code decomposed. eslint-suppressions.json
    // is empty: fix a violation by splitting the code, never by suppressing it.
    files: ['packages/**/*.js', 'scripts/**/*.mjs'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      // Pi calls tool execute(toolCallId, params, signal, onUpdate, ctx) with five arguments.
      'max-params': ['error', 5],
    },
  },
  {
    // Each package is installed alone: reach other packages through their declared name only.
    files: ['packages/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*'],
              message: 'Import another package by its name (e.g. @clement_chsn/pi-shared/…), never by relative path.',
            },
          ],
        },
      ],
    },
  },
  {
    // Brave transport errors can echo request headers, including the API key.
    files: ['packages/web/search.js'],
    rules: { 'preserve-caught-error': 'off' },
  },
];

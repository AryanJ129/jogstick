import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/target/**',
      'packages/native/index.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        'setTimeout',
        'setInterval',
        'setImmediate',
        'process',
        'Date',
      ],
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron', 'fs', 'path'] }],
    },
  },
);

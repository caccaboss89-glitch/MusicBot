import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/',
      '.git/',
      'logs/',
      'temp/',
      'audio_engine/target/',
      'data/'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'indent': ['error', 2],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      'no-unused-vars': ['warn'],
      'no-console': 'off',
      'eqeqeq': ['error', 'always'],
      'prefer-const': 'warn',
      'no-var': 'warn',
      'no-multiple-empty-lines': ['error', { max: 2 }],
      'comma-dangle': ['error', 'never'],
      'no-trailing-spaces': 'error',
      'eol-last': ['error', 'always'],

      // Caught real bugs in this codebase: a `return` inside `finally` that
      // swallowed every failure, and an always-false concurrency guard.
      'no-unsafe-finally': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-dupe-else-if': 'error'
    }
  }
];

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['**/dist/', 'convex/_generated/', '.convex/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.js'], rules: { '@typescript-eslint/no-unused-vars': 'off', 'no-unused-vars': 'error', '@typescript-eslint/no-unused-expressions': 'off' } },
  { files: ['**/*.ts'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['vite.config.js', 'eslint.config.js', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
];

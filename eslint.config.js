import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/coverage/**', '**/drizzle/**', '.dev-*/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports (default exports only where a framework requires them).',
        },
      ],
    },
  },
  // Tool config files sit outside the package tsconfigs.
  {
    files: ['**/*.js', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  { files: ['**/*.config.{js,ts}'], rules: { 'no-restricted-syntax': 'off' } },
  // Theme scripts run in the visitor's browser.
  {
    files: ['themes/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        matchMedia: 'readonly',
        IntersectionObserver: 'readonly',
      },
    },
  },
);

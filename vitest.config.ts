import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@lithocms/source'] },
  ssr: { resolve: { conditions: ['@lithocms/source'] } },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests share one real Postgres container.
    globalSetup: ['packages/core/src/testing/global-setup.ts'],
    hookTimeout: 120_000,
  },
});

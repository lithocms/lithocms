import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@lithocms/source'] },
  ssr: { resolve: { conditions: ['@lithocms/source'] } },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    passWithNoTests: true,
    // Integration tests start a real Postgres container.
    hookTimeout: 120_000,
  },
});

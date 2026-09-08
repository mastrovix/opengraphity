import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // vitest 4 no longer excludes `**/dist/**` by default: without this the
    // compiled copies of the tests under dist/ (tsc output of an older
    // tsconfig) would run too, against stale imports.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      // Every source file counts, not only the ones a test happens to import:
      // a new untested module lowers the ratio instead of being invisible.
      include: ['src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', 'src/scripts/**', 'src/index.ts', 'src/worker.ts'],
      // Non-regression floors (G-10), measured on 8 Sep 2026 and set just
      // below the value of the day — lib 68/68/68/52, services 57/56/49/56
      // (lines/statements/functions/branches). Raise them as coverage grows;
      // never lower them to make a red run green.
      thresholds: {
        'src/lib/**':      { lines: 67, statements: 66, functions: 66, branches: 50 },
        'src/services/**': { lines: 56, statements: 55, functions: 47, branches: 55 },
      },
    },
  },
})

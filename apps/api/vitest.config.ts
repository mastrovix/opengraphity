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
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist'],
    },
  },
})

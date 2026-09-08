import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // isolated-vm on Node >= 20 needs the process started with
    // --no-node-snapshot, otherwise creating an Isolate kills the process
    // silently. Same flag the API must use at runtime.
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
  },
})

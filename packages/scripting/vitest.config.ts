import { defineConfig } from 'vitest/config'
// I numeri stanno in un posto solo: vedi `copertura.mjs` alla radice.
// @ts-expect-error — modulo JS senza tipi, alla radice del monorepo
import { copertura } from '../../copertura.mjs'

export default defineConfig({
  test: {
    coverage: copertura('packages/scripting'),
    globals: true,
    environment: 'node',
    // isolated-vm on Node >= 20 needs the process started with
    // --no-node-snapshot, otherwise creating an Isolate kills the process
    // silently. Same flag the API must use at runtime.
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
  },
})

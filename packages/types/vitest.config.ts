import { defineConfig } from 'vitest/config'
// I numeri stanno in un posto solo: vedi `copertura.mjs` alla radice.
// @ts-expect-error — modulo JS senza tipi, alla radice del monorepo
import { copertura } from '../../copertura.mjs'

export default defineConfig({
  test: {
    coverage: copertura('packages/types'),
    globals: true,
    environment: 'node',
  },
})

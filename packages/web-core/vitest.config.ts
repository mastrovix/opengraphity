import { defineConfig } from 'vitest/config'
// I numeri stanno in un posto solo: vedi `copertura.mjs` alla radice.
// @ts-expect-error — modulo JS senza tipi, alla radice del monorepo
import { copertura } from '../../copertura.mjs'

export default defineConfig({
  test: {
    coverage: copertura('packages/web-core'),
    // jsdom e non node: il renderer dei moduli del catalogo vive qui, ed e'
    // il motivo per cui questo pacchetto esiste — uno solo per web e portale.
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})

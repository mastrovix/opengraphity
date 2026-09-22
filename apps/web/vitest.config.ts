/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
// I numeri stanno in un posto solo: vedi `copertura.mjs` alla radice.
// @ts-expect-error — modulo JS senza tipi, alla radice del monorepo
import { copertura } from '../../copertura.mjs'
import react from '@vitejs/plugin-react'
import path from 'path'

// Le date formattate nei test (lib/datetime) dipendono dal fuso: fissato una
// volta qui, prima che partano i worker (che ereditano process.env).
process.env['TZ'] = 'Europe/Rome'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    coverage: copertura('apps/web'),
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    restoreMocks: true,
    /**
     * QUINDICI SECONDI E NON CINQUE (22 set 2026).
     *
     * Questa suite crea centosettantanove ambienti jsdom e ci mette quattro
     * minuti: su un runner condiviso, i test piu' pesanti — quelli che
     * aspettano tre giri di Apollo in fila — superavano i cinque secondi di
     * fabbrica e cadevano per lentezza della macchina, non per un difetto.
     * Due sono gia' caduti cosi', in due giorni diversi e su due file
     * diversi: e' il limite a essere sbagliato, non i test.
     *
     * Non e' una pezza sulla lentezza: un test che ci mette davvero quindici
     * secondi ha un problema suo, e questo limite continua a dirlo.
     */
    testTimeout: 15_000,
    // `import.meta.env` visto dai moduli sotto test (lib/keycloak, lib/apiBase, …).
    env: {
      VITE_KEYCLOAK_URL:       'http://keycloak.test',
      VITE_KEYCLOAK_CLIENT_ID: 'opengrafo-web',
      VITE_TENANT_SLUG:        'test-tenant',
      VITE_API_URL:            '/graphql',
    },
  },
})

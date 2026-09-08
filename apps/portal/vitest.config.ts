/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Stesso fuso dei test di apps/web: le date formattate sono deterministiche.
process.env['TZ'] = 'Europe/Rome'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    restoreMocks: true,
    env: {
      VITE_KEYCLOAK_URL:       'http://keycloak.test',
      VITE_KEYCLOAK_CLIENT_ID: 'opengrafo-portal',
      VITE_TENANT_SLUG:        'test-tenant',
      VITE_API_URL:            '/graphql',
    },
  },
})

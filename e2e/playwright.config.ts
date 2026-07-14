import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Smoke tests against the local docker stack (http://c-one.localhost via nginx).
 * Prerequisites: `docker compose -f infra/docker-compose.yml up -d` and the
 * Keycloak test user (E2E_USER/E2E_PASSWORD, default admin/opengrafo_local).
 * Run: pnpm test:e2e
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://c-one.localhost',
    storageState: resolve(__dirname, '.auth/state.json'),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})

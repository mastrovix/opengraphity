import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Smoke tests against the local docker stack (http://demo-opengrafo.localhost
 * via nginx; E2E_BASE_URL for another tenant).
 * Prerequisites: `docker compose -f infra/docker-compose.yml up -d` and a user
 * of that tenant in E2E_USER / E2E_PASSWORD — there is no default user: the
 * old one (admin/opengrafo_local) belonged to c-one, deleted on 23 Sep 2026.
 * Run: E2E_USER=… E2E_PASSWORD=… pnpm test:e2e
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,   // absorbs render-swap click flakes on list rows
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://demo-opengrafo.localhost',
    storageState: resolve(__dirname, '.auth/state.json'),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})

import { chromium, type FullConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Playwright transpiles this file as CJS (no "type: module" at the root)
const HERE = __dirname

/**
 * Logs into Keycloak once and persists the session (cookies + token in
 * localStorage) so every test starts authenticated.
 */
export default async function globalSetup(_config: FullConfig) {
  const baseURL  = process.env['E2E_BASE_URL'] ?? 'http://demo-opengrafo.localhost'
  const user     = process.env['E2E_USER']
  const password = process.env['E2E_PASSWORD']
  // No default user: the one the tests used to assume (admin/opengrafo_local)
  // belonged to c-one, deleted on 23 Sep 2026, and a login with a user that
  // does not exist fails as a 15-second timeout on the Keycloak form.
  if (!user || !password) {
    throw new Error(`E2E_USER and E2E_PASSWORD are required: a user of the tenant at ${baseURL}`)
  }

  const statePath = resolve(HERE, '.auth/state.json')
  mkdirSync(dirname(statePath), { recursive: true })

  const browser = await chromium.launch()
  const page    = await browser.newPage()

  await page.goto(baseURL)
  // App redirects to the Keycloak login form (login-required)
  await page.waitForSelector('#username', { timeout: 15_000 })
  await page.fill('#username', user)
  await page.fill('#password', password)
  await page.click('#kc-login')

  // Back in the app: the sidebar is the "authenticated shell" marker
  await page.waitForSelector('nav, [class*="sidebar"], a[href="/incidents"]', { timeout: 20_000 })

  await page.context().storageState({ path: statePath })
  await browser.close()
}

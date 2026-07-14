import { test, expect } from '@playwright/test'

/**
 * Smoke: the 5 core operator flows against the live local stack.
 * Data-light: creates one incident per run (titled E2E-smoke-<ts>).
 */

test('dashboard shell loads after login', async ({ page }) => {
  await page.goto('/')
  // Authenticated shell: dashboard heading + topbar search button
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: /search|cerca/i }).first()).toBeVisible()
})

test('incident list renders with SLA column', async ({ page }) => {
  await page.goto('/incidents')
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  // SLA column shipped with the operator-SLA work
  await expect(page.getByRole('columnheader', { name: 'SLA' })).toBeVisible()
})

test('create incident end-to-end', async ({ page }) => {
  const title = `E2E-smoke-${Date.now()}`
  await page.goto('/incidents/new')

  // Title + description are the two required text fields
  await page.locator('input[type="text"]').first().fill(title)
  await page.locator('textarea').first().fill('Creato dallo smoke test Playwright')

  // Categoria: options load async from the enum query — wait, then pick the first real one
  const categoria = page.locator('select').first()
  await expect(categoria.locator('option').nth(1)).toBeAttached({ timeout: 15_000 })
  await categoria.selectOption({ index: 1 })

  // Severity is a preselected button group (Medium) — nothing to do
  const submit = page.getByRole('button', { name: /crea|create/i }).last()
  await expect(submit).toBeEnabled({ timeout: 10_000 })
  await submit.click()

  // Success lands back on the list (or shows a success toast)
  await page.waitForURL(/\/incidents(\?.*)?$/, { timeout: 20_000 })
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 })
})

test('incident detail shows attachments and comments cards', async ({ page }) => {
  await page.goto('/incidents')
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('table').locator('tbody tr').first().click()
  await page.waitForURL(/\/incidents\/[0-9a-f-]+/, { timeout: 15_000 })
  // Cards shipped with the attachments work (i18n: Allegati/Attachments)
  await expect(page.getByText(/allegati|attachments/i).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/commenti|comments/i).first()).toBeVisible()
})

test('command palette finds incidents', async ({ page }) => {
  await page.goto('/incidents')
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })

  // Open via the topbar button (more robust than the OS-dependent shortcut in headless)
  await page.getByRole('button', { name: /search|cerca/i }).first().click()
  const input = page.getByPlaceholder(/cerca|search/i)
  await expect(input).toBeVisible({ timeout: 5_000 })

  await input.fill('E2E-smoke')
  // Grouped results appear with at least one hit (created by the e2e test above)
  await expect(page.getByText(/E2E-smoke/).first()).toBeVisible({ timeout: 10_000 })

  await page.keyboard.press('Escape')
  await expect(input).not.toBeVisible()
})

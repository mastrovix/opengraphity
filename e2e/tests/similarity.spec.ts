import { test, expect } from '@playwright/test'

test('similar incidents panel shows semantic matches', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/incidents')
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 })
  const firstRow = page.getByRole('table').locator('tbody tr').first()
  await expect(firstRow).toBeVisible()
  await page.waitForTimeout(600)
  await firstRow.click()
  await page.waitForURL(/\/incidents\/[0-9a-f-]+/, { timeout: 15_000 })
  await expect(page.getByText('Incident simili')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(4000) // query + eventuale polling

  const panel = page.locator('div', { has: page.getByText('Incident simili') }).last()
  const text = await page.locator('body').innerText()
  const hasError = /Errore ricerca semantica/i.test(text)
  const hasPending = /Analisi semantica in corso/i.test(text)
  const hasScores = /\d+%/.test(text)
  console.log('ERRORE:', hasError, '| PENDING:', hasPending, '| SCORE % PRESENTI:', hasScores)
  console.log('KB SUGGERITA:', /KB suggerita/i.test(text))
  expect(hasError).toBe(false)
  expect(hasScores).toBe(true)
  await page.screenshot({ path: '../test-results/similar-panel.png', fullPage: false })
})

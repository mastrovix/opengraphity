import { test, expect } from '@playwright/test'

/**
 * Contratto del triage AI: cliccando "Suggerisci triage" l'esito è SEMPRE
 * esplicito — o il suggerimento (con chiave configurata) o l'errore reale
 * (senza chiave). Mai un fallimento silenzioso.
 */
test('triage suggestion — explicit outcome, never silent', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/incidents/new')
  await page.getByPlaceholder(/database produzione/i).fill('Timeout connessioni al database di produzione')
  await page.locator('textarea').first().fill('Gli utenti segnalano errori 500, il DB non risponde alle query')
  const btn = page.getByRole('button', { name: /suggerisci triage/i })
  await expect(btn).toBeVisible()
  await btn.click()

  const outcome = page.getByText(/Suggerimento AI|Errore triage AI/i).first()
  await expect(outcome).toBeVisible({ timeout: 60_000 })
  const text = await page.locator('body').innerText()
  const gotSuggestion = /Suggerimento AI/i.test(text)
  console.log(gotSuggestion ? 'ESITO: suggerimento generato' : 'ESITO: errore esplicito (chiave assente)')
  if (gotSuggestion) {
    await expect(page.getByRole('button', { name: /applica suggerimento/i })).toBeVisible()
  }
  await page.screenshot({ path: '../test-results/triage-outcome.png' })
})

import { test, expect } from '@playwright/test'

/**
 * Contratto dell'assistente AI: l'esito di una domanda è SEMPRE esplicito —
 * risposta fondata sul grafo (chiave configurata) o errore reale in chat
 * (chiave assente). Mai silenzio.
 */
test('assistant chat — explicit outcome, never silent', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/assistant')
  await expect(page.getByRole('heading', { name: /assistente ai/i })).toBeVisible({ timeout: 15_000 })

  await page.getByPlaceholder(/chiedi qualcosa/i).fill('Quali change sono in corso?')
  await page.getByRole('button', { name: /invia/i }).click()

  // esito esplicito: o compare "Errore: ..." o una risposta dell'assistente
  // (l'input si riabilita a fine stream)
  await expect(page.getByPlaceholder(/chiedi qualcosa/i)).toBeEnabled({ timeout: 90_000 })
  const text = await page.locator('body').innerText()
  const gotError = /Errore:/i.test(text)
  const gotConfigError = /ANTHROPIC_API_KEY|non configurato/i.test(text)
  console.log(gotError ? (gotConfigError ? 'ESITO: errore esplicito (chiave assente)' : 'ESITO: errore esplicito') : 'ESITO: risposta generata')
  // mai silenzio: o errore esplicito o una seconda bolla oltre alla domanda
  const bubbles = await page.locator('div[style*="border-radius: 12px"], div[style*="borderRadius"]').count()
  expect(gotError || bubbles >= 2).toBe(true)
  await page.screenshot({ path: '../test-results/assistant-outcome.png' })
})

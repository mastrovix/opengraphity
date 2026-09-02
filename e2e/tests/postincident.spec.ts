import { test, expect } from '@playwright/test'

/**
 * Post-incident AI (step 4) — contratto esito-sempre-esplicito:
 * ogni azione produce un risultato visibile o l'errore reale, mai silenzio.
 */

test('problem candidates — explicit outcome', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/problems')
  await page.getByRole('button', { name: /candidati problem/i }).click()
  // esito: pannello con candidati/messaggio "nessun cluster", o toast errore
  const outcome = page.getByText(/Candidati Problem da incident ricorrenti|Analisi fallita/i).first()
  await expect(outcome).toBeVisible({ timeout: 120_000 })
  const text = await page.locator('body').innerText()
  const failed = /Analisi fallita/i.test(text)
  console.log(failed ? 'ESITO: errore esplicito' : 'ESITO: analisi completata')
  if (!failed) {
    const none = /Nessun cluster/i.test(text)
    console.log(none ? 'CANDIDATI: nessun cluster trovato' : 'CANDIDATI: trovati (vedi screenshot)')
  }
  await page.screenshot({ path: '../test-results/problem-candidates.png', fullPage: true })
})

test('resolution draft button in transition dialog', async ({ page }) => {
  test.setTimeout(120_000)
  // incident con team già assegnato (INC00000001) — i gate di transizione passano
  await page.goto('/incidents/c36c0e71-a8c4-47dc-8f1a-144dd97a9e60')
  await page.waitForTimeout(2500)
  // apri una transizione qualsiasi (bottone workflow nell'header)
  const transBtn = page.getByRole('button', { name: /risolvi|resolve/i }).first()
  if (await transBtn.count() === 0) { console.log('nessuna transizione disponibile — skip'); return }
  await transBtn.click()
  const draftBtn = page.getByRole('button', { name: /bozza ai dalle attività/i })
  await expect(draftBtn).toBeVisible({ timeout: 10_000 })
  await draftBtn.click()
  // esito: textarea popolata o toast errore
  await page.waitForTimeout(30_000)
  const notes = await page.getByPlaceholder(/memory leak|note sulla transizione/i).inputValue()
  const text = await page.locator('body').innerText()
  const failed = /Bozza AI fallita/i.test(text)
  console.log(failed ? 'ESITO: errore esplicito' : `ESITO: bozza generata (${notes.length} caratteri)`)
  console.log('BOZZA:', notes.slice(0, 200))
  expect(failed || notes.length >= 10).toBe(true)
  await page.screenshot({ path: '../test-results/resolution-draft.png' })
})

test('kb draft from resolved incident — explicit outcome', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/incidents/f52da71a-d7b2-4dc7-ae9c-f8fa3761bb3c')
  await page.waitForTimeout(2500)
  const kbBtn = page.getByRole('button', { name: /bozza articolo kb/i })
  await expect(kbBtn).toBeVisible({ timeout: 10_000 })
  await kbBtn.click()
  const outcome = page.getByText(/Bozza KB creata|Bozza KB fallita/i).first()
  await expect(outcome).toBeVisible({ timeout: 60_000 })
  const text = await page.locator('body').innerText()
  console.log(/fallita/i.test(text) ? 'ESITO: errore esplicito' : 'ESITO: bozza KB creata')
  await page.screenshot({ path: '../test-results/kb-draft.png' })
})

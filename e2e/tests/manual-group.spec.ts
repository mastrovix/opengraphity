import { test, expect } from '@playwright/test'

test('manual group: criteria hidden, creation works, member addable', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/ci/dynamic_ci_group')
  await page.getByRole('button', { name: /new dynamic|nuov/i }).first().click()

  const form = page.locator('form')
  await expect(form.locator('input[type="text"]').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(2500) // sandbox async

  const bodyText = await form.innerText()
  const criteriaCount = (bodyText.match(/criteri/gi) ?? []).length
  const bannerVisible = await page.getByText('Errore sandbox scripting').isVisible().catch(() => false)
  console.log('MANUAL: "criteri" (atteso 0):', criteriaCount, '| banner sandbox (atteso false):', bannerVisible)
  expect(bannerVisible).toBe(false)
  expect(criteriaCount).toBe(0)

  const memberSelect = form.locator('select').filter({ has: page.locator('option[value="dynamic"]') }).first()
  await memberSelect.selectOption('dynamic')
  await page.waitForTimeout(2000)
  const criteriaCount2 = ((await form.innerText()).match(/criteri/gi) ?? []).length
  console.log('DYNAMIC: "criteri" (atteso >0):', criteriaCount2)
  expect(criteriaCount2).toBeGreaterThan(0)

  await memberSelect.selectOption('manual')
  await page.waitForTimeout(1500)
  const groupName = `E2E ManualFix ${Date.now()}`
  await form.locator('input[type="text"]').first().fill(groupName)
  await form.getByRole('button', { name: /salva|save/i }).click()
  await page.waitForTimeout(2500)

  await page.getByText(groupName).first().click()
  await expect(page.getByText(/^Relazioni \(/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /add relation|aggiungi relazione/i }).first().click()
  const relSelect = page.locator('select').filter({ has: page.locator('option[value="HAS_MEMBER"]') })
  const hasMember = await relSelect.count()
  console.log('DROPDOWN HAS_MEMBER (atteso 1):', hasMember)
  expect(hasMember).toBe(1)
  await relSelect.first().selectOption('HAS_MEMBER')

  const searchInput = page.getByPlaceholder(/search ci|cerca ci/i).last()
  await searchInput.fill('srv')
  await page.waitForTimeout(1500)
  const firstResult = page.locator('text=/srv/i').last()
  console.log('primo risultato:', await firstResult.innerText().catch(() => 'NESSUNO'))
  await firstResult.click()

  await page.getByRole('button', { name: /add relation|aggiungi relazione/i }).last().click()
  await page.waitForTimeout(2500)

  // il membro appena aggiunto deve comparire nella pagina (mappa membri / relazioni)
  await page.reload()
  await page.waitForTimeout(3000)
  const pageText = await page.locator('body').innerText()
  const memberShown = /SRV-009/i.test(pageText)
  console.log('MEMBRO SRV-009 VISIBILE NEL DETTAGLIO (atteso true):', memberShown)
  expect(memberShown).toBe(true)
})

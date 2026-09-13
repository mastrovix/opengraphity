/**
 * I REPORT DI RISPETTO HANNO UNA TESTATA SOLA: `ReportHeader`.
 *
 * Divise in due pagine, l'OLA / UC Report aveva il link «Manage contracts» e
 * l'SLA Report nessun link verso le policy: ogni pagina costruiva la sua
 * testata a mano. Ora titolo, link di gestione (prop obbligatoria) e finestra
 * stanno in `reportWindow.tsx`, e questo test impedisce a una pagina di tornare
 * a comporli da sé.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

const COMUNE = path.join(SRC, 'pages', 'reports', 'reportWindow.tsx')
const pagine = tsx().filter((f) => f !== COMUNE && /from '\.\/reportWindow'|from '@\/pages\/reports\/reportWindow'/.test(fs.readFileSync(f, 'utf8')))

describe('report di rispetto: una testata sola', () => {
  it('trova le pagine dei report (altrimenti il test non guarda niente)', () => {
    expect(pagine.map((f) => path.basename(f)).sort()).toEqual(expect.arrayContaining(['OLAReportPage.tsx', 'SLAReportPage.tsx']))
  })

  it.each(pagine.map((f) => [path.relative(SRC, f), f]))('%s usa ReportHeader e non compone la testata a mano', (_nome, file) => {
    const src = fs.readFileSync(file, 'utf8')
    expect(src).toMatch(/<ReportHeader\b[\s\S]{0,400}?\bmanageTo=/)
    expect(src).not.toMatch(/<WindowSelector\b/)
    expect(src).not.toMatch(/<PageTitle\b/)
  })
})

/** Verifica «Cosa resta cablato», ondata 2: come conta il tempo e l'obiettivo di conformità. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { ALWAYS_ON, calendarChoiceOf, calendarIdFor, complianceValid } from './ServiceTargetFields'
import { pctColor, PctCell } from '@/pages/reports/reportWindow'
import { palette } from '@/lib/tokens'

describe('come conta il tempo', () => {
  it('24×7, un calendario, o nessuna scelta per una policy vecchia in orario lavorativo senza calendario', () => {
    expect(calendarChoiceOf(null, false)).toBe(ALWAYS_ON)
    expect(calendarChoiceOf('cal-1', true)).toBe('cal-1')
    expect(calendarChoiceOf(null, true)).toBe('')
    expect(calendarIdFor(ALWAYS_ON)).toBeNull()
    expect(calendarIdFor('cal-1')).toBe('cal-1')
  })
})

describe('obiettivo di conformità', () => {
  it('la soglia sta sotto l\'obiettivo, l\'obiettivo al massimo 100', () => {
    expect(complianceValid('99.5', '97')).toBe(true)
    expect(complianceValid('', '97')).toBe(false)
    expect(complianceValid('90', '95')).toBe(false)
    expect(complianceValid('101', '95')).toBe(false)
  })

  it('il report colora rispetto all\'obiettivo della riga, e senza obiettivo non colora', () => {
    const objective = { target: 99.5, warning: 97 }
    expect(pctColor(96, objective)).toBe(palette.danger.text)      // con 95/80 fissi era verde
    expect(pctColor(98, objective)).toBe(palette.warning.text)
    expect(pctColor(99.6, objective)).toBe(palette.success.text)
    expect(pctColor(96)).toBe('var(--color-slate)')
  })
})

/**
 * Dal giro nel browser: nel report OLA/UC il 100% era nero, perché la regola
 * delle celle di tabella (`.sft-td *`) forzava un colore con `!important` su
 * tutto. Il colore contro l'obiettivo esisteva solo nei test.
 */
describe('il colore della percentuale arriva nella tabella', () => {
  it('la cella si marca con data-tone, e la regola delle celle rispetta il marchio', () => {
    const { container } = render(<PctCell pct={100} target={95} warning={80} />)
    expect(container.querySelector('[data-tone]')).not.toBeNull()
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')
    const regoleColore = [...css.matchAll(/([^{}]*\.sft-td[^{}]*)\{[^}]*\bcolor:[^}]*\}/g)].map((m) => m[1]!)
    expect(regoleColore.length).toBeGreaterThan(0)
    for (const selettori of regoleColore) {
      for (const sel of selettori.split(',').map((x) => x.trim()).filter((x) => x.endsWith('*') || x.includes('* '))) {
        expect(sel, 'una regola di colore sui figli della cella deve escludere [data-tone]').toMatch(/:not\(\[data-tone\]\)/)
      }
    }
  })
})

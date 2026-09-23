import { describe, it, expect, vi } from 'vitest'
import { toEnumOptions, ciStatusStyle } from './ciEnums'
import { palette } from './tokens'
import { NEUTRAL_VALUE_STYLE } from './domainStyle'

/**
 * D29 (tour of 23 Sep 2026): one rule for a value without a label —
 * `humanizeValue` of @opengraphity/web-core. A machine key becomes a sentence,
 * a value written as a sentence stays as it is (it used to become «Pick Up
 * At The IT Desk»), and a Dictionary label always wins.
 */
describe('toEnumOptions', () => {
  it.each([
    ['active', 'Active'],
    ['database_instance', 'Database instance'],
    ['ssl_certificate', 'Ssl certificate'],
    ['in_progress', 'In progress'],
    ['Pick up at the IT desk', 'Pick up at the IT desk'],
    ['', ''],
  ])('"%s" → "%s"', (v, label) => {
    expect(toEnumOptions([v])).toEqual([{ value: v, label }])
  })

  it('keeps the order', () => {
    expect(toEnumOptions(['production', 'dev_env'])).toEqual([
      { value: 'production', label: 'Production' },
      { value: 'dev_env',    label: 'Dev env' },
    ])
    expect(toEnumOptions([])).toEqual([])
  })

  it('the Dictionary label wins when there is one; without one the value is humanized', () => {
    const labelOf = (v: string) => ({ in_progress: 'Lavorazione' } as Record<string, string>)[v] ?? null
    expect(toEnumOptions(['in_progress', 'on_hold'], labelOf)).toEqual([
      { value: 'in_progress', label: 'Lavorazione' },
      { value: 'on_hold', label: 'On hold' },
    ])
  })
})

describe('ciStatusStyle', () => {
  const VOCABULARY = ['active', 'inactive', 'maintenance', 'decommissioned', 'expired', 'revoked']

  /** Revisione del 14 set 2026 · F9: il colore dello stato è quello del Dizionario (`ci_status`), non `CI_STATUS_STYLE`. */
  it('stato con un colore nel Dizionario → quella famiglia della palette', () => {
    expect(ciStatusStyle('maintenance', VOCABULARY, 'warning')).toMatchObject({ bg: palette.warning.tint, color: palette.warning.text })
    expect(ciStatusStyle('active', VOCABULARY, 'success')).toMatchObject({ bg: palette.success.tint, color: palette.success.text })
  })

  it('stato NEL vocabolario del cliente senza colore → neutro e silenzioso', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ciStatusStyle('expired', VOCABULARY, null)).toEqual(NEUTRAL_VALUE_STYLE)
    expect(ciStatusStyle('revoked', VOCABULARY, null)).toEqual(NEUTRAL_VALUE_STYLE)
    expect(err).not.toHaveBeenCalled()
  })

  it('stato FUORI dal vocabolario del cliente → stile rotto (rosso) e console.error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ciStatusStyle('zombie', VOCABULARY, null)).toMatchObject({ bg: 'var(--color-danger)', color: 'var(--color-white)' })
    expect(err).toHaveBeenCalledWith(`[ci_status] "zombie" is not in the vocabulary of this tenant (${VOCABULARY.join(', ')})`)
  })

  it('vocabolario non disponibile → neutro e console.warn', () => {
    const err  = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ciStatusStyle('zombie', null, null)).toEqual(NEUTRAL_VALUE_STYLE)
    expect(err).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[ci_status] "zombie" has no color and the vocabulary of this tenant is unavailable: neutral style')
  })
})


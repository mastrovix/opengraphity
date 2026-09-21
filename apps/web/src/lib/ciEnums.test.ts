import { describe, it, expect, vi } from 'vitest'
import { enumLabel, toEnumOptions, ciStatusStyle } from './ciEnums'
import { palette } from './tokens'
import { NEUTRAL_VALUE_STYLE } from './domainStyle'

describe('enumLabel / toEnumOptions', () => {
  it.each([
    ['active', 'Active'],
    ['database_instance', 'Database Instance'],
    ['ssl_certificate', 'Ssl Certificate'],
    ['in_progress', 'In Progress'],
    ['', ''],
  ])('"%s" → "%s"', (v, label) => {
    expect(enumLabel(v)).toBe(label)
  })

  it('toEnumOptions preserva l\'ordine e usa enumLabel', () => {
    expect(toEnumOptions(['production', 'dev_env'])).toEqual([
      { value: 'production', label: 'Production' },
      { value: 'dev_env',    label: 'Dev Env' },
    ])
    expect(toEnumOptions([])).toEqual([])
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


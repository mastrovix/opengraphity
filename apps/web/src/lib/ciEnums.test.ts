import { describe, it, expect, vi } from 'vitest'
import { enumLabel, toEnumOptions, ciStatusStyle, CI_STATUS_STYLE, ciTypeLabelKey, CI_TYPE_LABEL_KEYS } from './ciEnums'
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
  const VOCABULARY = [...Object.keys(CI_STATUS_STYLE), 'expired', 'revoked']

  it('stato noto → palette', () => {
    for (const k of Object.keys(CI_STATUS_STYLE)) expect(ciStatusStyle(k, VOCABULARY)).toBe(CI_STATUS_STYLE[k])
  })

  /**
   * CONTRATTO RINEGOZIATO (ondata 7 · D-15). Prima questo test pretendeva che
   * `ciStatusStyle('zombie')` tornasse lo stile «rotto» rosso con
   * `console.error`, senza distinguere fra uno stato che il cliente ha nel suo
   * vocabolario e uno che non c'è. Ma `expired` e `revoked` SONO nel
   * vocabolario (49 e 19 CI dal vivo su c-one, aggiunti dall'ondata 0) e non
   * hanno un colore assegnato: erano cinquanta pastiglie rosse e cinquanta
   * righe di errore per una configurazione giusta.
   */
  it('stato NEL vocabolario del cliente senza colore → neutro e silenzioso', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ciStatusStyle('expired', VOCABULARY)).toEqual(NEUTRAL_VALUE_STYLE)
    expect(ciStatusStyle('revoked', VOCABULARY)).toEqual(NEUTRAL_VALUE_STYLE)
    expect(err).not.toHaveBeenCalled()
  })

  it('stato FUORI dal vocabolario del cliente → stile rotto (rosso) e console.error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ciStatusStyle('zombie', VOCABULARY)).toEqual({ bg: 'var(--color-danger)', color: 'var(--color-white)' })
    expect(err).toHaveBeenCalledWith(`[CI_STATUS_STYLE] "zombie" non è nel vocabolario di questo cliente (${VOCABULARY.join(', ')})`)
  })

  it('vocabolario non disponibile → neutro e console.warn', () => {
    const err  = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ciStatusStyle('zombie')).toEqual(NEUTRAL_VALUE_STYLE)
    expect(err).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[CI_STATUS_STYLE] "zombie" senza stile e vocabolario del cliente non disponibile: stile neutro')
  })
})

describe('ciTypeLabelKey', () => {
  it('tipo storico → chiave i18n; tipo custom / assente → null (si usa ciType.label)', () => {
    expect(ciTypeLabelKey('server')).toBe('sidebar.server')
    expect(ciTypeLabelKey('ssl_certificate')).toBe(CI_TYPE_LABEL_KEYS['certificate'])
    expect(ciTypeLabelKey('kubernetes_cluster')).toBeNull()
    expect(ciTypeLabelKey(null)).toBeNull()
    expect(ciTypeLabelKey(undefined)).toBeNull()
    expect(ciTypeLabelKey('')).toBeNull()
  })
})

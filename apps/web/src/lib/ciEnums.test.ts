import { describe, it, expect, vi } from 'vitest'
import { enumLabel, toEnumOptions, ciStatusStyle, CI_STATUS_STYLE, ciTypeLabelKey, CI_TYPE_LABEL_KEYS } from './ciEnums'

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
  it('stato noto → palette', () => {
    for (const k of Object.keys(CI_STATUS_STYLE)) expect(ciStatusStyle(k)).toBe(CI_STATUS_STYLE[k])
  })
  it('stato ignoto → stile rotto (rosso) e console.error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ciStatusStyle('zombie')).toEqual({ bg: 'var(--color-danger)', color: '#fff' })
    expect(err).toHaveBeenCalledWith('[CI_STATUS_STYLE] valore sconosciuto: "zombie"')
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

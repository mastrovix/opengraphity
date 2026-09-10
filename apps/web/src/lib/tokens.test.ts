import { describe, it, expect, vi } from 'vitest'
import { lookupOrError, lookupStyle, colors, layoutPalette, fontSize, fontWeight } from './tokens'

describe('lookupOrError', () => {
  it('ritorna il valore mappato senza loggare', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(lookupOrError({ a: 1, b: 2 }, 'b', 'MAP', 0)).toBe(2)
    expect(err).not.toHaveBeenCalled()
  })

  it('chiave sconosciuta → console.error con nome mappa e chiave, e fallback', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(lookupOrError({ a: 1 }, 'zzz', 'MY_MAP', -1)).toBe(-1)
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0]![0]).toBe('[MY_MAP] valore sconosciuto: "zzz"')
  })

  it('un valore mappato "falsy" (0, "", false) è un hit, non un fallback', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(lookupOrError({ zero: 0 }, 'zero', 'M', 9)).toBe(0)
    expect(lookupOrError({ empty: '' }, 'empty', 'M', 'x')).toBe('')
    expect(lookupOrError({ no: false }, 'no', 'M', true)).toBe(false)
    expect(err).not.toHaveBeenCalled()
  })
})

describe('lookupStyle', () => {
  it('chiave sconosciuta → stile "rotto" rosso/bianco', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(lookupStyle({ ok: { bg: '#fff', color: '#000' } }, 'nope', 'STYLE')).toEqual({ bg: 'var(--color-danger)', color: 'var(--color-white)' })
  })
  it('chiave nota → lo stile mappato', () => {
    expect(lookupStyle({ ok: { bg: '#fff', color: '#000' } }, 'ok', 'STYLE')).toEqual({ bg: '#fff', color: '#000' })
  })
})

describe('token', () => {
  it('ogni colore risolve a una custom property CSS', () => {
    const flat = [
      colors.brand, colors.slate, colors.white, colors.border, colors.success,
      ...Object.values(colors.severity).flatMap((s) => Object.values(s)),
      ...Object.values(colors.trigger),
      ...Object.values(layoutPalette),
      ...Object.values(fontSize),
    ]
    for (const v of flat) expect(v).toMatch(/^var\(--[a-z0-9-]+\)$/)
  })
  it('i pesi font sono numerici', () => {
    expect(Object.values(fontWeight).every((w) => typeof w === 'number')).toBe(true)
  })
})

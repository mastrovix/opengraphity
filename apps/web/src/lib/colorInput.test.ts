/** Giro UI del 15 set 2026 · U-15: il selettore mostrava nero per un colore salvato come token. */
import { describe, it, expect, afterEach } from 'vitest'
import { colorInputValue, isColorToken, toColorInputHex } from './colorInput'

afterEach(() => { document.documentElement.style.removeProperty('--color-test-brand') })

describe('colorInput', () => {
  it('esadecimali corti e lunghi, rgb(): sempre #rrggbb; altro → null', () => {
    expect(toColorInputHex('#0284C7')).toBe('#0284c7')
    expect(toColorInputHex('#abc')).toBe('#aabbcc')
    expect(toColorInputHex('rgb(2, 132, 199)')).toBe('#0284c7')
    expect(toColorInputHex('teal')).toBeNull()
  })

  it('un token si risolve nel colore che il browser usa; un token non definito → null (non nero)', () => {
    document.documentElement.style.setProperty('--color-test-brand', 'rgb(13, 148, 136)')
    expect(isColorToken('var(--color-test-brand)')).toBe(true)
    expect(colorInputValue('var(--color-test-brand)')).toBe('#0d9488')
    expect(colorInputValue('var(--color-undefined)')).toBeNull()
  })
})

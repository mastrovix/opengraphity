/**
 * THE COLOUR PICKER'S VALUE: a plain colour, and a token outside the browser.
 *
 * A colour saved as itself (not a token) goes to the picker as `#rrggbb`. A
 * token can only be resolved against a page: without one (no document, or no
 * root to read it from) the answer is «unknown», and the caller says so —
 * never black, which the picker would otherwise show as if it were the colour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { colorInputValue } from './colorInput'

afterEach(() => { vi.unstubAllGlobals() })

describe('colorInputValue', () => {
  it('a colour saved as itself goes to the picker as #rrggbb', () => {
    expect(colorInputValue('#ABC')).toBe('#aabbcc')
    expect(colorInputValue('rgb(13, 148, 136)')).toBe('#0d9488')
    expect(colorInputValue('teal')).toBeNull()
  })

  it('a token with nothing to resolve it against is unknown, not black', () => {
    expect(colorInputValue('var(--color-brand)', null)).toBeNull()
  })

  it('outside the browser (no document) a token is unknown too', () => {
    vi.stubGlobal('document', undefined)
    expect(colorInputValue('var(--color-brand)')).toBeNull()
    // A plain colour needs no page.
    expect(colorInputValue('#0284c7')).toBe('#0284c7')
  })
})

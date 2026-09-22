/**
 * Per-value colors of a vocabulary (Dictionary, F9).
 *
 * Why these behaviours matter: `value_colors` is a JSON string on the
 * EnumTypeDefinition node. A corrupt value must not make the whole vocabulary
 * unreadable (the badges lose their color, the values stay usable) and the
 * reason must be reported; colors outside the palette are dropped one by one,
 * not all together. Renaming a value must carry its color along, removing a
 * value must drop its color, and the Dictionary input must be refused when it
 * names a color the UI cannot render or a value the vocabulary does not have.
 */
import { describe, it, expect } from 'vitest'
import { VALUE_COLORS } from '@opengraphity/types'
import {
  assertValueColorsInput, parseValueColors, pruneValueColors, renameValueColor, serializeValueColors, valueColorEntries,
} from '../enumValueColors.js'
import { ValidationError } from '../errors.js'

describe('parseValueColors', () => {
  it('absent or empty means no colors and no error', () => {
    expect(parseValueColors(null)).toEqual({ colors: {}, error: null })
    expect(parseValueColors(undefined)).toEqual({ colors: {}, error: null })
    expect(parseValueColors('')).toEqual({ colors: {}, error: null })
  })

  it('a non-string value is reported with its type', () => {
    expect(parseValueColors(42)).toEqual({ colors: {}, error: 'value_colors is not a string (number)' })
  })

  it('invalid JSON loses the colors and says why', () => {
    const r = parseValueColors('{nope')
    expect(r.colors).toEqual({})
    expect(r.error).toMatch(/^value_colors is not valid JSON: /)
  })

  it('an array, null or a scalar is not a value → color object', () => {
    for (const raw of ['[]', 'null', '"danger"']) {
      expect(parseValueColors(raw)).toEqual({ colors: {}, error: 'value_colors is not an object value → color' })
    }
  })

  it('keeps the palette colors and names only the ones outside the palette', () => {
    const r = parseValueColors(JSON.stringify({ high: 'danger', low: 'success', odd: 'magenta' }))
    expect(r.colors).toEqual({ high: 'danger', low: 'success' })
    expect(r.error).toBe('value_colors has colors outside the palette: odd=magenta')
  })

  it('a fully valid object has no error', () => {
    expect(parseValueColors('{"high":"danger"}')).toEqual({ colors: { high: 'danger' }, error: null })
  })
})

describe('lifecycle helpers', () => {
  const colors = { high: 'danger', low: 'success' } as const

  it('valueColorEntries follows the vocabulary order and skips values without a color', () => {
    expect(valueColorEntries(['low', 'medium', 'high'], colors)).toEqual([
      { value: 'low', color: 'success' }, { value: 'high', color: 'danger' },
    ])
  })

  it('renaming a value carries its color; renaming an uncolored value changes nothing', () => {
    expect(renameValueColor(colors, 'high', 'critical')).toEqual({ low: 'success', critical: 'danger' })
    expect(renameValueColor(colors, 'medium', 'mid')).toBe(colors)
  })

  it('removing values drops their colors', () => {
    expect(pruneValueColors(colors, ['low'])).toEqual({ low: 'success' })
  })

  it('serializes to null when there is nothing to store (no empty JSON left on the node)', () => {
    expect(serializeValueColors({})).toBeNull()
    expect(JSON.parse(serializeValueColors(colors)!)).toEqual(colors)
  })
})

describe('assertValueColorsInput', () => {
  const values = ['low', 'high']

  it('accepts palette colors for existing values', () => {
    expect(assertValueColorsInput([{ value: 'high', color: 'danger' }], values, 'priority')).toEqual({ high: 'danger' })
  })

  it('refuses a color outside the palette, listing the palette', () => {
    let err: unknown
    try { assertValueColorsInput([{ value: 'high', color: 'magenta' }], values, 'priority') } catch (e) { err = e }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toBe(`Color "magenta" for "high" is not in the palette (${VALUE_COLORS.join(', ')}).`)
  })

  it('refuses a color for a value the vocabulary does not have', () => {
    expect(() => assertValueColorsInput([{ value: 'urgent', color: 'danger' }], values, 'priority'))
      .toThrow('"urgent" is not a value of "priority" (low, high): it cannot have a color.')
  })
})

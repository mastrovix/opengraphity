/**
 * The icon of a dictionary value (tour of 24 Sep 2026, G40): the same life as
 * its colour — a rename carries it, a removed value drops it, a name outside
 * the product's list is refused, a corrupt JSON is said and not guessed.
 */
import { describe, it, expect } from 'vitest'
import { assertValueIconsInput, parseValueIcons, pruneValueIcons, renameValueIcon, serializeValueIcons, valueIconEntries } from '../enumValueIcons.js'

describe('enumValueIcons', () => {
  it('reads the stored map, keeps the known icons and says which are not', () => {
    expect(parseValueIcons(null)).toEqual({ icons: {}, error: null })
    expect(parseValueIcons('{"infrastructure":"server","people":"unicorn"}')).toEqual({
      icons: { infrastructure: 'server' }, error: 'value_icons has icons outside the list: people=unicorn',
    })
    expect(parseValueIcons('{not json').error).toMatch(/not valid JSON/)
  })

  it('in the order of the values; a rename carries the icon, a removed value drops it', () => {
    const icons = { people: 'users', workplace: 'building' } as const
    expect(valueIconEntries(['workplace', 'hardware', 'people'], icons)).toEqual([{ value: 'workplace', icon: 'building' }, { value: 'people', icon: 'users' }])
    expect(renameValueIcon(icons, 'people', 'staff')).toEqual({ workplace: 'building', staff: 'users' })
    expect(pruneValueIcons(icons, ['people'])).toEqual({ people: 'users' })
    expect(serializeValueIcons({})).toBeNull()
  })

  it('the Dictionary may choose only icons of the list, and only for values of the dictionary', () => {
    expect(assertValueIconsInput([{ value: 'people', icon: 'users' }], ['people'], 'category')).toEqual({ people: 'users' })
    expect(() => assertValueIconsInput([{ value: 'people', icon: 'unicorn' }], ['people'], 'category')).toThrow(/Icon "unicorn" for "people" is not in the list/)
    expect(() => assertValueIconsInput([{ value: 'ghost', icon: 'users' }], ['people'], 'category')).toThrow(/cannot have an icon/)
  })
})

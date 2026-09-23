/**
 * THE STYLE OF A VOCABULARY VALUE (impact, team type, CI status…).
 *
 * The colour of a value is the one the customer gave it in the Dictionary.
 * A value with no colour is normal and neutral; so is a value while the
 * vocabulary of this tenant is not known yet (said as a warning). A value
 * OUTSIDE the vocabulary is a record to fix: it is shown in the broken style
 * and reported with the values that would be valid — never quietly neutral.
 */
import { describe, it, expect, vi } from 'vitest'
import { palette } from '@/lib/tokens'
import { valueColorStyle, vocabularyValueStyle, NEUTRAL_VALUE_STYLE, BROKEN_VALUE_STYLE } from './domainStyle'

describe('valueColorStyle', () => {
  it('a colour family gives its tint, text and accent; «neutral» the neutral style', () => {
    expect(valueColorStyle('danger')).toEqual({ bg: palette.danger.tint, color: palette.danger.text, accent: palette.danger.base })
    expect(valueColorStyle('neutral')).toBe(NEUTRAL_VALUE_STYLE)
  })
})

describe('vocabularyValueStyle', () => {
  it('the colour the Dictionary gave the value wins', () => {
    expect(vocabularyValueStyle('impact', 'high', ['high', 'low'], 'warning')).toEqual(valueColorStyle('warning'))
  })

  it('a value of the vocabulary with no colour is neutral, and nothing is reported', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(vocabularyValueStyle('team_type', 'support', ['owner', 'support'], null)).toBe(NEUTRAL_VALUE_STYLE)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('while the vocabulary of this tenant is not known, the value is neutral and the wait is noted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(vocabularyValueStyle('team_type', 'support', null, null)).toBe(NEUTRAL_VALUE_STYLE)
    expect(warn).toHaveBeenCalledWith('[team_type] "support" has no color and the vocabulary of this tenant is unavailable: neutral style')
  })

  it('a value outside the vocabulary is shown broken and reported with the valid values', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(vocabularyValueStyle('team_type', 'vendor', ['owner', 'support'], null)).toBe(BROKEN_VALUE_STYLE)
    expect(error).toHaveBeenCalledWith('[team_type] "vendor" is not in the vocabulary of this tenant (owner, support)')
  })

  it('an empty vocabulary says it is empty', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(vocabularyValueStyle('team_type', 'owner', [], null)).toBe(BROKEN_VALUE_STYLE)
    expect(error).toHaveBeenCalledWith('[team_type] "owner" is not in the vocabulary of this tenant (empty)')
  })
})

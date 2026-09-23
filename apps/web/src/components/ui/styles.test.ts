/**
 * THE SHARED FORM STYLES (E-09): the inline styles that raw inputs, selects
 * and the designers' lists spread onto their elements.
 *
 * Two things matter to the person filling a form. A read-only field must still
 * READ as content: the Dictionary once painted the fields of a shipped
 * vocabulary in the placeholder grey, and «status_change / Change Status /
 * ITIL» looked like hints in three empty boxes — live, the vocabulary was taken
 * for empty (17 Sep 2026). And a select or a text area must look like the
 * input it sits next to.
 */
import { describe, it, expect } from 'vitest'
import { colors } from '@/lib/tokens'
import { inputS, readOnlyInputS, selectS, textareaS } from './styles'

describe('shared form styles', () => {
  it('a read-only field keeps the colour of content, not the placeholder grey; the background says it is locked', () => {
    expect(readOnlyInputS.color).toBe(colors.slateDark)
    expect(readOnlyInputS.color).not.toBe(colors.slateLight)
    expect(readOnlyInputS.backgroundColor).toBe(colors.slateBg)
    expect(readOnlyInputS.cursor).toBe('default')
  })

  it('selects and text areas are drawn as inputs: same box, border and radius', () => {
    for (const s of [selectS, textareaS]) {
      expect(s).toMatchObject({ width: inputS.width, border: inputS.border, borderRadius: inputS.borderRadius, boxSizing: inputS.boxSizing })
    }
    expect(selectS.cursor).toBe('pointer')
    expect(textareaS.resize).toBe('vertical')
  })
})

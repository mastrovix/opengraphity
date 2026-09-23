/**
 * The canvas selection, one more case: a kind of selection it does not know.
 *
 * `stessaSelezione` decides which tile is drawn as selected and which one the
 * properties modal edits. The companion `FormCanvas.test.tsx` covers the two
 * kinds that exist; if a third one is ever added (a table column, a row)
 * without teaching it this function, it must match nothing — not light up
 * every tile, nor open the properties of something else.
 */
import { describe, it, expect } from 'vitest'
import { stessaSelezione, type Selezione } from './FormCanvas'

describe('stessaSelezione', () => {
  it('a kind of selection it does not know matches nothing, not even itself', () => {
    const column = { tipo: 'column', iSez: 0, iVoce: 0 } as unknown as Selezione
    expect(stessaSelezione(column, column)).toBe(false)
    expect(stessaSelezione(column, { ...column })).toBe(false)
  })
})

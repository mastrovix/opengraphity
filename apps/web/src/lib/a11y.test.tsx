/**
 * KEYBOARD AND SCREEN-READER HELPERS.
 *
 * `keyActivate` gives Enter and Space to elements that cannot be a <button>
 * (a clickable table row, a card with controls inside). It must activate on
 * those two keys only, keep Space from scrolling the page, and leave alone
 * the keys pressed INSIDE a nested control — Enter in an input of the row is
 * the input's, not a click on the row.
 *
 * `srOnlyStyle` is anchored at (0, 0): without it, a screen-reader text inside
 * a wide scrolling table ended up at x=1195 on a 731px window and made the
 * whole page scroll sideways (measured on monitoring/health).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { keyActivate, srOnlyStyle } from './a11y'

function Row({ onOpen }: { onOpen: () => void }) {
  return (
    <div role="button" tabIndex={0} aria-label="row" onKeyDown={keyActivate(onOpen)}>
      <input aria-label="note" />
    </div>
  )
}

describe('keyActivate', () => {
  it('Enter and Space activate the element, and Space does not scroll the page', () => {
    const onOpen = vi.fn()
    render(<Row onOpen={onOpen} />)
    const row = screen.getByRole('button', { name: 'row' })
    expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(false)
    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('any other key does nothing, and keeps its default', () => {
    const onOpen = vi.fn()
    render(<Row onOpen={onOpen} />)
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'row' }), { key: 'a' })).toBe(true)
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'row' }), { key: 'Tab' })).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Enter or Space in a control inside the element belongs to the control', () => {
    const onOpen = vi.fn()
    render(<Row onOpen={onOpen} />)
    const note = screen.getByRole('textbox', { name: 'note' })
    expect(fireEvent.keyDown(note, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(note, { key: ' ' })).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('srOnlyStyle', () => {
  it('is out of sight but anchored at the corner, so it never widens the page', () => {
    expect(srOnlyStyle).toMatchObject({ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'hidden' })
  })
})

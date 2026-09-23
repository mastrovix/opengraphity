/**
 * RELEASE WINDOWS ARE WRITTEN IN THE ORGANIZATION'S TIME ZONE (F-13).
 *
 * The deploy plan form shows each window in a `datetime-local` field and
 * saves it as an instant. `toLocal` and `fromLocal` are the two halves of
 * that round trip: an operator travelling abroad who types 22:00 must save
 * 22:00 of the ORGANIZATION, not of the place they are in — otherwise the
 * release happens an hour (or nine) away from what the change board
 * approved. The night the clocks change is where a naive conversion slips by
 * an hour, so it is pinned here too. The tests run in Europe/Rome.
 *
 * `StickyAction` is the completion button every form shares: it must refuse
 * a click when the task cannot be completed, and say why.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StickyAction, fromLocal, toLocal } from './shared'

describe('toLocal: an instant as the field shows it', () => {
  it('in the organization\'s time zone', () => {
    expect(toLocal('2026-09-23T10:00:00Z', 'America/New_York')).toBe('2026-09-23T06:00')
    expect(toLocal('2026-09-23T10:00:00Z', 'Asia/Tokyo')).toBe('2026-09-23T19:00')
  })

  it('in the browser\'s zone until the organization\'s is known', () => {
    expect(toLocal('2026-09-23T10:00:00Z')).toBe('2026-09-23T12:00')
    expect(toLocal('2026-01-05T08:05:00Z', null)).toBe('2026-01-05T09:05')
  })

  it('nothing, or something that is not a date, shows an empty field', () => {
    expect(toLocal('')).toBe('')
    expect(toLocal('not a date', 'Europe/Rome')).toBe('')
  })
})

describe('fromLocal: what was typed, as an instant', () => {
  it('read in the organization\'s time zone', () => {
    expect(fromLocal('2026-09-23T06:00', 'America/New_York')).toBe('2026-09-23T10:00:00.000Z')
    expect(fromLocal('2026-09-23T22:00', 'Europe/Rome')).toBe('2026-09-23T20:00:00.000Z')
  })

  it('read in the browser\'s zone until the organization\'s is known', () => {
    expect(fromLocal('2026-09-23T12:00')).toBe('2026-09-23T10:00:00.000Z')
  })

  it('the nights the clocks change keep the hour that was typed', () => {
    // 29 March: 01:30 is still winter time (+1), 03:30 already summer time (+2).
    expect(fromLocal('2026-03-29T01:30', 'Europe/Rome')).toBe('2026-03-29T00:30:00.000Z')
    expect(fromLocal('2026-03-29T03:30', 'Europe/Rome')).toBe('2026-03-29T01:30:00.000Z')
    // 25 October: 01:30 is still summer time (+2), 04:00 winter time again (+1).
    expect(fromLocal('2026-10-25T01:30', 'Europe/Rome')).toBe('2026-10-24T23:30:00.000Z')
    expect(fromLocal('2026-10-25T04:00', 'Europe/Rome')).toBe('2026-10-25T03:00:00.000Z')
  })

  it('what is saved reads back as what was typed', () => {
    for (const typed of ['2026-03-29T01:30', '2026-07-01T22:15', '2026-10-25T01:30', '2026-12-31T23:59']) {
      expect(toLocal(fromLocal(typed, 'Europe/Rome'), 'Europe/Rome')).toBe(typed)
      expect(toLocal(fromLocal(typed, 'America/New_York'), 'America/New_York')).toBe(typed)
    }
  })

  it('an empty or broken field saves nothing', () => {
    expect(fromLocal('')).toBe('')
    expect(fromLocal('', 'Europe/Rome')).toBe('')
    expect(fromLocal('2026-13-45T99:99', 'Europe/Rome')).toBe('')
  })
})

describe('StickyAction', () => {
  it('a task that cannot be completed yet refuses the click and says why', async () => {
    const onClick = vi.fn()
    render(<StickyAction label="Complete the plan" disabled blockReason="Fill in every step before completing" onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Complete the plan' })
    expect(button).toBeDisabled()
    expect(button).toHaveStyle({ cursor: 'not-allowed' })
    expect(screen.getByText('Fill in every step before completing')).toBeInTheDocument()
    await userEvent.setup().click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('a task ready to complete takes the click, with no reason shown', async () => {
    const onClick = vi.fn()
    render(<StickyAction label="Complete the plan" disabled={false} onClick={onClick} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Complete the plan' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'false')
  })

  it('while a completion is in flight it waits, even if it could be completed', () => {
    render(<StickyAction label="Complete the plan" disabled={false} onClick={vi.fn()} busyLabel="Completing…" />)
    expect(screen.getByRole('button', { name: 'Completing…' })).toHaveStyle({ cursor: 'wait' })
  })
})

/**
 * THE BULK ACTIONS BAR: what a person sees above a list once rows are ticked.
 *
 * It says how many rows the actions will touch, carries the page's own
 * actions, and drops the selection in one click. With nothing selected it must
 * not be there at all: a bar with actions on zero rows invites a click that
 * does nothing, or worse, one the page does not expect.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { BulkActionsBar } from './BulkActionsBar'

describe('BulkActionsBar', () => {
  it('with nothing selected there is no bar, and no action is offered', () => {
    renderWithProviders(<BulkActionsBar count={0} onClear={vi.fn()}><button type="button">Resolve</button></BulkActionsBar>)
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull()
  })

  it('names how many rows are selected and carries the actions of the page', () => {
    renderWithProviders(<BulkActionsBar count={3} onClear={vi.fn()}><button type="button">Resolve</button></BulkActionsBar>)
    const bar = screen.getByRole('toolbar', { name: '3 selected' })
    expect(within(bar).getByText('3 selected')).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
  })

  it('"Clear selection" hands the clearing back to the page, once', async () => {
    const onClear = vi.fn()
    const { user } = renderWithProviders(<BulkActionsBar count={1} onClear={onClear} />)
    await user.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

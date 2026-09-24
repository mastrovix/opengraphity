/**
 * Adding a transition without dragging (review of 23 Sep 2026): a keyboard
 * user picks the step the arrow leads to; the step it starts from is not offered.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { AddTransitionControl } from './AddTransitionControl'

const STEPS = [
  { id: 's1', name: 'new', label: 'New' },
  { id: 's2', name: 'in_progress', label: 'In progress' },
  { id: 's3', name: 'resolved', label: '' },
]

describe('AddTransitionControl', () => {
  it('offers the other steps, and adds the arrow to the one picked', async () => {
    const onAdd = vi.fn(async () => undefined)
    const { user } = renderWithProviders(<AddTransitionControl fromStepId="s1" steps={STEPS} onAdd={onAdd} />)
    const select = screen.getByLabelText('Add a transition to')
    // A step without a label reads as its name.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Step —', 'In progress', 'resolved'])
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    await user.selectOptions(select, 's2')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onAdd).toHaveBeenCalledWith('s2')
    expect(select).toHaveValue('')
  })
})

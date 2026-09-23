/**
 * THE CUSTOMER'S FIELDS ON A TICKET: abandoning an edit.
 *
 * «Cancel» must throw the edit away: nothing is sent to the API, the card goes
 * back to reading the values the ticket really has, and a later «Edit» starts
 * again from those values rather than from the abandoned draft.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { CustomFieldsCard } from './CustomFieldsCard'
import type { CustomFieldValueView } from './customFields'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const FIELDS: CustomFieldValueView[] = [
  { name: 'cost_center', label: 'Cost center', fieldType: 'string', required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false, value: 'IT-01' },
]

describe('CustomFieldsCard — cancelling an edit', () => {
  it('Cancel sends nothing, shows the stored value again, and a new edit starts from it', async () => {
    const onSaved = vi.fn()
    // No mock for the save mutation: a request would fail the test as an unmatched mock.
    const { user } = renderWithProviders(<CustomFieldsCard entityType="change" ticketId="chg-1" fields={FIELDS} canEdit onSaved={onSaved} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText('Cost center')
    await user.clear(box)
    await user.type(box, 'draft')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByLabelText('Cost center')).toBeNull()
    expect(screen.getByText('IT-01')).toBeInTheDocument()
    expect(screen.queryByText('draft')).toBeNull()
    expect(onSaved).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Cost center')).toHaveValue('IT-01')
  })
})

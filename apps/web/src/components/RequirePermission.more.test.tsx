/**
 * THE ROUTE GUARD AFTER A FAILED LOAD OF `me`.
 *
 * When the query for the current user fails the guard shows the error with a
 * «Retry», never the page and never «Access denied» (either would be a guess).
 * «Retry» must really ask again: once `me` answers, a person who has the
 * permission is let in without reloading the whole app.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { meErrorMock, meMock } from '@/test/mocks/gql'
import { RequirePermission } from './RequirePermission'

describe('RequirePermission — retrying', () => {
  it('Retry asks for `me` again, and lets the person in when it answers with the permission', async () => {
    const { user } = renderWithProviders(
      <RequirePermission anyOf={['admin.audit']}><div data-testid="protected">Audit log</div></RequirePermission>,
      { mocks: [meErrorMock('me failed'), meMock('admin')] },
    )
    expect(await screen.findByText('me failed')).toBeInTheDocument()
    expect(screen.queryByTestId('protected')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('protected')).toHaveTextContent('Audit log')
    expect(screen.queryByText('me failed')).toBeNull()
  })
})

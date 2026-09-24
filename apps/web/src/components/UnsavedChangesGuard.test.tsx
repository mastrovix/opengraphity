/**
 * UnsavedChangesGuard — leaving with changes not saved asks first (review of
 * 23 Sep 2026: the workflow designer threw its local changes away on any
 * navigation). Under a real data router, as in the app.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, Link, useLocation } from 'react-router-dom'
import { ConfirmProvider } from '@/hooks/useConfirm'
import { UnsavedChangesGuard } from './UnsavedChangesGuard'
import '@/i18n/i18n'

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function app(dirty: boolean) {
  const router = createMemoryRouter([
    { path: '/editor', element: <><UnsavedChangesGuard when={dirty} title="Leave?" body="Changes not saved." confirmLabel="Leave" /><Link to="/list">List</Link><Where /></> },
    { path: '/list', element: <Where /> },
  ], { initialEntries: ['/editor'] })
  render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

describe('UnsavedChangesGuard', () => {
  it('with changes, an in-app navigation asks: stay keeps the page', async () => {
    app(true)
    const user = userEvent.setup()
    await user.click(screen.getByRole('link', { name: 'List' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/editor')
  })

  it('with changes, leave goes', async () => {
    app(true)
    const user = userEvent.setup()
    await user.click(screen.getByRole('link', { name: 'List' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Leave?' })).getByRole('button', { name: 'Leave' }))
    expect(await screen.findByTestId('where')).toHaveTextContent('/list')
  })

  it('without changes nothing is asked; closing the tab is left to the browser only with changes', async () => {
    app(false)
    const user = userEvent.setup()
    const quiet = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(quiet)
    expect(quiet.defaultPrevented).toBe(false)
    await user.click(screen.getByRole('link', { name: 'List' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent('/list')
  })

  it('with changes, closing or reloading the tab is stopped for the browser to ask', () => {
    app(true)
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
  })
})

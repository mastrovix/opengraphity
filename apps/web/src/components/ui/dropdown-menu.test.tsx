/**
 * The dropdown-menu wrappers sit on top of Base UI's Menu and make the header's
 * user menu. What a user relies on:
 * - the trigger opens a menu whose items are real `menuitem`s (keyboard and
 *   screen readers work) and clicking an item runs its action;
 * - a destructive item is marked as such (red styling hangs off `data-variant`);
 * - the parts carry their `og-menu*` class (index.css), and a caller's class
 *   is added, not substituted: since Tailwind left the web (24 Sep 2026) these
 *   classes are the whole look of the menu.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './dropdown-menu'

function setup() {
  const onEdit = vi.fn()
  const user = userEvent.setup()
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent className="extra">
        <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
        <DropdownMenuSeparator data-testid="sep" />
        <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  )
  return { user, onEdit }
}

describe('DropdownMenu', () => {
  it('is closed until the trigger is clicked, then shows its items as menu items', async () => {
    const { user } = setup()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveClass('og-menu', 'extra')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveClass('og-menu-item')
    expect(screen.getByTestId('sep')).toHaveClass('og-menu-separator')
  })

  it('clicking an item runs its action', async () => {
    const { user, onEdit } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('marks a destructive item so it is styled as dangerous', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-variant', 'destructive')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveAttribute('data-variant', 'default')
  })

  it('an item under the keyboard is the highlighted one: that is what the style follows', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await screen.findByRole('menu')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('menuitem').some((i) => i.hasAttribute('data-highlighted'))).toBe(true)
  })
})

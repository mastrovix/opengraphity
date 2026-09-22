/**
 * The dropdown-menu wrappers sit on top of Base UI's Menu and are used by the
 * header menus (user menu, row actions). What a user relies on:
 * - the trigger opens a menu whose items are real `menuitem`s (keyboard and
 *   screen readers work) and clicking an item runs its action;
 * - checkbox and radio items expose and toggle their checked state;
 * - a destructive item is marked as such (red styling hangs off `data-variant`);
 * - a submenu opens from its trigger.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger,
  DropdownMenuSubContent, DropdownMenuPortal,
} from './dropdown-menu'

function Menu({ onEdit, onCheck, onRadio }: { onEdit: () => void; onCheck: (v: boolean) => void; onRadio: (v: unknown) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent className="extra">
        <DropdownMenuGroup>
          <DropdownMenuLabel inset>Row</DropdownMenuLabel>
          <DropdownMenuItem onClick={onEdit}>Edit<DropdownMenuShortcut>⌘E</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={false} onCheckedChange={onCheck}>Show closed</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value="list" onValueChange={onRadio}>
          <DropdownMenuRadioItem value="list">List</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="board">Board</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Export</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function setup() {
  const onEdit = vi.fn()
  const onCheck = vi.fn()
  const onRadio = vi.fn()
  const user = userEvent.setup()
  render(<Menu onEdit={onEdit} onCheck={onCheck} onRadio={onRadio} />)
  return { user, onEdit, onCheck, onRadio }
}

describe('DropdownMenu', () => {
  it('is closed until the trigger is clicked, then shows its items as menu items', async () => {
    const { user } = setup()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    const menu = await screen.findByRole('menu')
    // A caller's className is kept on top of the base styling.
    expect(menu).toHaveClass('extra')
    expect(screen.getByRole('menuitem', { name: /Edit/ })).toBeInTheDocument()
    expect(screen.getByText('⌘E')).toHaveAttribute('data-slot', 'dropdown-menu-shortcut')
    expect(screen.getByText('Row')).toHaveAttribute('data-inset', 'true')
  })

  it('clicking an item runs its action', async () => {
    const { user, onEdit } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Edit/ }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('marks a destructive item so it is styled as dangerous', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-variant', 'destructive')
    expect(screen.getByRole('menuitem', { name: /Edit/ })).toHaveAttribute('data-variant', 'default')
  })

  it('checkbox and radio items expose their state and report changes', async () => {
    const { user, onCheck, onRadio } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    const box = await screen.findByRole('menuitemcheckbox', { name: 'Show closed' })
    expect(box).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitemradio', { name: 'List' })).toHaveAttribute('aria-checked', 'true')
    await user.click(box)
    expect(onCheck).toHaveBeenCalledWith(true, expect.anything())
    // Toggling a checkbox keeps the menu open, so the radio is still there.
    await user.click(screen.getByRole('menuitemradio', { name: 'Board' }))
    expect(onRadio).toHaveBeenCalledWith('board', expect.anything())
  })

  it('a submenu opens from its trigger', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'More' }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Export' })).toBeInTheDocument())
  })

  it('the portal wrapper renders its children outside the parent tree', () => {
    render(<div data-testid="host"><DropdownMenu open><DropdownMenuPortal><span>ported</span></DropdownMenuPortal></DropdownMenu></div>)
    expect(screen.getByText('ported')).toBeInTheDocument()
    expect(screen.getByTestId('host')).not.toContainElement(screen.getByText('ported'))
  })
})

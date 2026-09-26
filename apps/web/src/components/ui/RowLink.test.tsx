/**
 * THE ROW OPENS ITS ITEM (26 Sep 2026, «perché alcune tabelle hanno i link?»).
 *
 * What a user loses if this regresses: a table whose names look like links
 * while the next table's do not; a row that does not open on click; a button
 * in the row that opens the row as well.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { RowLink, rowOpens } from './RowLink'

describe('RowLink and rowOpens', () => {
  it('the name is an anchor that looks like the text around it', () => {
    render(<MemoryRouter><RowLink to="/roles/admin">Admin</RowLink></MemoryRouter>)
    const a = screen.getByRole('link', { name: 'Admin' })
    expect(a).toHaveAttribute('href', '/roles/admin')
    expect(a.style.color).toBe('inherit')
    expect(a.style.textDecoration).toBe('none')
  })

  it('a click on the row opens it; a click on a button in the row does not', async () => {
    const open = vi.fn()
    render(
      <table><tbody>
        <tr {...rowOpens(open)}><td>Admin</td><td><button type="button">Delete</button></td></tr>
      </tbody></table>,
    )
    await userEvent.click(screen.getByText('Admin'))
    expect(open).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(open).toHaveBeenCalledTimes(1)
  })
})

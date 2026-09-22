/**
 * SimpleTable renders the embedded lists of the detail pages. What a user
 * loses if it regresses: an empty list showing a bare header instead of the
 * caller's empty message, a missing value printed as "undefined", or a
 * clickable row that a keyboard user cannot open.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimpleTable, type SimpleColumn } from './SimpleTable'

interface Row { id: string; name: string; owner: string | null }
const columns: SimpleColumn<Row>[] = [
  { key: 'name', label: 'Name' },
  { key: 'owner', label: 'Owner', render: (v, row) => <em>{`${String(v ?? 'nobody')} (${row.id})`}</em> },
]
const rows: Row[] = [
  { id: 'a', name: 'Alpha', owner: 'Ann' },
  { id: 'b', name: 'Beta', owner: null },
]

describe('SimpleTable', () => {
  it('with no rows shows only the empty content, and nothing when none is given', () => {
    const { container, rerender } = render(<SimpleTable columns={columns} rows={[]} empty={<p>No items</p>} />)
    expect(screen.getByText('No items')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    rerender(<SimpleTable columns={columns} rows={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders headers, custom cells and a dash for a missing plain value', () => {
    const withMissingName = [...rows, { id: 'c', name: null as unknown as string, owner: 'Cy' }]
    render(<SimpleTable columns={columns} rows={withMissingName} />)
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByText('nobody (b)')).toBeInTheDocument()
    // A null plain value is a dash, never the string "null".
    expect(screen.getByText('—')).toBeInTheDocument()
    // Rows are not interactive without a handler.
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('tabindex')
  })

  it('clickable rows open on click and from the keyboard', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(<SimpleTable columns={columns} rows={rows} onRowClick={onRowClick} />)
    const [, first, second] = screen.getAllByRole('row')
    await user.click(first!)
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0])
    second!.focus()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1])
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SortableFilterTable, type ColumnDef } from './SortableFilterTable'

interface Row { id: string; name: string; count: number; owner: { name: string } | null }

const ROWS: Row[] = [
  { id: 'r1', name: 'bravo',   count: 10, owner: { name: 'Zed' } },
  { id: 'r2', name: 'alpha',   count: 2,  owner: { name: 'Amy' } },
  { id: 'r3', name: 'charlie', count: 1,  owner: null },
]

const COLUMNS: ColumnDef<Row>[] = [
  { key: 'name',  label: 'Nome',  sortable: true },
  { key: 'count', label: 'Conteggio', sortable: true },
  { key: 'owner', label: 'Owner', sortable: true, render: (v) => (v as Row['owner'])?.name ?? '—' },
]

function bodyRows() {
  return within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
}
function firstCellTexts() {
  return bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent)
}

describe('SortableFilterTable — rendering', () => {
  it('tabella con aria-label, intestazioni e celle (render personalizzato incluso)', () => {
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} label="Utenti" />)
    expect(screen.getByRole('table', { name: 'Utenti' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Nome', 'Conteggio', 'Owner'])
    expect(firstCellTexts()).toEqual(['bravo', 'alpha', 'charlie'])
    expect(within(bodyRows()[2]!).getAllByRole('cell')[2]).toHaveTextContent('—')
  })

  it('loading → 5 righe skeleton, nessun dato', () => {
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} loading />)
    expect(bodyRows()).toHaveLength(5)
    expect(screen.queryByText('bravo')).not.toBeInTheDocument()
  })

  it('vuota → messaggio di default tradotto, o emptyMessage / emptyComponent', () => {
    const { rerender } = render(<SortableFilterTable columns={COLUMNS} data={[]} />)
    expect(screen.getByText('No results')).toBeInTheDocument()
    rerender(<SortableFilterTable columns={COLUMNS} data={[]} emptyMessage="Niente" />)
    expect(screen.getByText('Niente')).toBeInTheDocument()
    rerender(<SortableFilterTable columns={COLUMNS} data={[]} emptyComponent={<b>custom</b>} />)
    expect(screen.getByText('custom')).toBeInTheDocument()
  })
})

describe('SortableFilterTable — ordinamento client-side (non controllato)', () => {
  it('click su intestazione ordina asc, secondo click desc; aria-sort aggiornato', async () => {
    const user = userEvent.setup()
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} />)
    const nameHeader = screen.getByRole('columnheader', { name: 'Nome' })
    expect(nameHeader).toHaveAttribute('aria-sort', 'none')

    await user.click(within(nameHeader).getByRole('button'))
    expect(firstCellTexts()).toEqual(['alpha', 'bravo', 'charlie'])
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')

    await user.click(within(nameHeader).getByRole('button'))
    expect(firstCellTexts()).toEqual(['charlie', 'bravo', 'alpha'])
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending')
  })

  it('ordinamento numerico e su oggetti { name }; i null vanno in fondo', async () => {
    const user = userEvent.setup()
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} />)
    await user.click(within(screen.getByRole('columnheader', { name: 'Conteggio' })).getByRole('button'))
    expect(firstCellTexts()).toEqual(['charlie', 'alpha', 'bravo'])   // 1, 2, 10 (numeric, non lessicografico)

    await user.click(within(screen.getByRole('columnheader', { name: 'Owner' })).getByRole('button'))
    expect(firstCellTexts()).toEqual(['alpha', 'bravo', 'charlie'])   // Amy, Zed, null
  })

  it('colonne non ordinabili non hanno bottone né aria-sort', () => {
    render(<SortableFilterTable columns={[{ key: 'name', label: 'Nome' }]} data={ROWS} />)
    const h = screen.getByRole('columnheader', { name: 'Nome' })
    expect(h).not.toHaveAttribute('aria-sort')
    expect(within(h).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('SortableFilterTable — ordinamento controllato (server-side)', () => {
  it('delega a onSort con il campo e la direzione invertita, senza riordinare localmente', async () => {
    const user = userEvent.setup()
    const onSort = vi.fn()
    const { rerender } = render(<SortableFilterTable columns={COLUMNS} data={ROWS} onSort={onSort} sortField={null} sortDir="asc" />)
    await user.click(within(screen.getByRole('columnheader', { name: 'Nome' })).getByRole('button'))
    expect(onSort).toHaveBeenCalledWith('name', 'asc')
    expect(firstCellTexts()).toEqual(['bravo', 'alpha', 'charlie'])   // ordine dei dati invariato

    rerender(<SortableFilterTable columns={COLUMNS} data={ROWS} onSort={onSort} sortField="name" sortDir="asc" />)
    expect(screen.getByRole('columnheader', { name: 'Nome' })).toHaveAttribute('aria-sort', 'ascending')
    await user.click(within(screen.getByRole('columnheader', { name: 'Nome' })).getByRole('button'))
    expect(onSort).toHaveBeenLastCalledWith('name', 'desc')

    rerender(<SortableFilterTable columns={COLUMNS} data={ROWS} onSort={onSort} sortField="name" sortDir="desc" />)
    await user.click(within(screen.getByRole('columnheader', { name: 'Conteggio' })).getByRole('button'))
    expect(onSort).toHaveBeenLastCalledWith('count', 'asc')
  })
})

describe('SortableFilterTable — righe cliccabili', () => {
  it('click e tastiera (Enter/Space) chiamano onRowClick; le righe sono focusabili', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} onRowClick={onRowClick} />)
    const rows = bodyRows()
    expect(rows[0]).toHaveAttribute('tabindex', '0')

    await user.click(rows[1]!)
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1])

    rows[2]!.focus()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[2])
    await user.keyboard(' ')
    expect(onRowClick).toHaveBeenCalledTimes(3)
  })

  it('senza onRowClick le righe non sono focusabili', () => {
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} />)
    expect(bodyRows()[0]).not.toHaveAttribute('tabindex')
  })

  it('riga espansa: renderExpandedRow sotto la riga con id corrispondente', () => {
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} expandedRowId="r2" renderExpandedRow={(r) => <div>dettaglio {r.name}</div>} />)
    expect(screen.getByText('dettaglio alpha')).toBeInTheDocument()
    expect(bodyRows()).toHaveLength(4)
  })
})

describe('SortableFilterTable — selezione', () => {
  it('checkbox per riga e "seleziona tutto" (pagina) con stato indeterminato', async () => {
    const user = userEvent.setup()
    const onToggleRow = vi.fn(); const onToggleAll = vi.fn(); const onRowClick = vi.fn()
    render(
      <SortableFilterTable columns={COLUMNS} data={ROWS} selectable selectedIds={new Set(['r1'])}
        onToggleRow={onToggleRow} onToggleAll={onToggleAll} onRowClick={onRowClick} />,
    )
    const all = screen.getByRole('checkbox', { name: 'Select all (page)' }) as HTMLInputElement
    expect(all.checked).toBe(false)
    expect(all.indeterminate).toBe(true)
    const rowBoxes = screen.getAllByRole('checkbox', { name: 'Select row' }) as HTMLInputElement[]
    expect(rowBoxes.map((b) => b.checked)).toEqual([true, false, false])

    await user.click(rowBoxes[1]!)
    expect(onToggleRow).toHaveBeenCalledWith('r2')
    expect(onRowClick).not.toHaveBeenCalled()   // il click sulla checkbox non apre la riga

    await user.click(all)
    expect(onToggleAll).toHaveBeenCalledWith(['r1', 'r2', 'r3'])
  })
})

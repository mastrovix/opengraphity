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
  it('un clic su un controllo dentro la riga NON apre la riga: e del controllo', async () => {
    // Visto nella pagina SLA Policies: con la riga cliccabile, spegnere una policy
    // o premere Elimina avrebbe aperto anche la modifica.
    const onRowClick = vi.fn()
    const onButton = vi.fn()
    const cols: ColumnDef<Row>[] = [
      ...COLUMNS,
      { key: 'id', label: 'Azioni', render: () => <button type="button" onClick={onButton}>Elimina</button> },
    ]
    render(<SortableFilterTable columns={cols} data={ROWS} label="Utenti" onRowClick={onRowClick} />)
    await userEvent.click(within(bodyRows()[0]!).getByRole('button', { name: 'Elimina' }))
    expect(onButton).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
    await userEvent.click(within(bodyRows()[0]!).getAllByRole('cell')[0]!)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('nessuna riga ha un bordo sinistro: in border-collapse sposta la tabella e lascia bianco prima della testata', () => {
    // Il difetto visto nel browser: `border-left: 8px transparent` sulle righe
    // (per la striscia al passaggio del mouse) faceva riservare alla tabella
    // 4px a sinistra di OGNI riga, testata compresa, che restavano bianchi.
    // La striscia ora e un'ombra interna della prima cella (`.sft-row`).
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} label="Utenti" onRowClick={() => {}} />)
    for (const r of screen.getAllByRole('row')) {
      expect(r.style.borderLeft).toBe('')
    }
    expect(bodyRows().every((r) => r.classList.contains('sft-row'))).toBe(true)
  })

  it('the stripe is for rows that open something (26 Sep 2026)', () => {
    const { unmount } = render(<SortableFilterTable columns={COLUMNS} data={ROWS} label="Utenti" onRowClick={() => {}} />)
    expect(bodyRows().every((r) => r.classList.contains('row-opens'))).toBe(true)
    unmount()
    render(<SortableFilterTable columns={COLUMNS} data={ROWS} label="Utenti" />)
    expect(bodyRows().some((r) => r.classList.contains('row-opens'))).toBe(false)
  })

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

  it('every column sorts by default (26 Sep 2026); only `sortable: false` (a column of buttons) has no button nor aria-sort', () => {
    render(<SortableFilterTable columns={[{ key: 'name', label: 'Nome' }, { key: 'id', label: 'Azioni', sortable: false }]} data={ROWS} />)
    const sortable = screen.getByRole('columnheader', { name: 'Nome' })
    expect(sortable).toHaveAttribute('aria-sort', 'none')
    expect(within(sortable).getByRole('button')).toBeInTheDocument()
    const actions = screen.getByRole('columnheader', { name: 'Azioni' })
    expect(actions).not.toHaveAttribute('aria-sort')
    expect(within(actions).queryByRole('button')).not.toBeInTheDocument()
  })

  it('a column sorts on its sortValue when given (a label in place of a code), and a list by how long it is', async () => {
    type R = { id: string; code: string; tags: string[] }
    const rows: R[] = [{ id: '1', code: 'b', tags: ['x', 'y'] }, { id: '2', code: 'a', tags: [] }, { id: '3', code: 'c', tags: ['x'] }]
    const label = (c: string) => ({ a: 'Zulu', b: 'Alpha', c: 'Mike' })[c]
    render(<SortableFilterTable<R> columns={[{ key: 'code', label: 'Code', sortValue: (r) => label(r.code), render: (v) => label(String(v)) }, { key: 'tags', label: 'Tags', render: (v) => (v as string[]).length }]} data={rows} />)
    await userEvent.click(screen.getByRole('button', { name: /Code/ }))
    expect(bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['Alpha', 'Mike', 'Zulu'])
    await userEvent.click(screen.getByRole('button', { name: /Tags/ }))
    expect(bodyRows().map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual(['0', '1', '2'])
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

describe('SortableFilterTable — a column pinned at the right edge (D36)', () => {
  const pinned: ColumnDef<Row>[] = [
    ...COLUMNS,
    { key: 'id', label: 'Azioni', width: '170px', sticky: 'end', render: () => <button type="button">Elimina</button> },
  ]

  it('the last column stays in view while the table scrolls sideways: header and cells', () => {
    render(<SortableFilterTable columns={pinned} data={ROWS} label="Utenti" />)
    const header = screen.getByRole('columnheader', { name: 'Azioni' })
    // The opaque header tint comes from index.css (`th.sft-sticky-end`).
    expect(header).toHaveClass('sft-sticky-end')
    expect(header).toHaveStyle({ position: 'sticky', right: '0px' })
    for (const r of bodyRows()) {
      const last = within(r).getAllByRole('cell').at(-1)!
      expect(last).toHaveStyle({ position: 'sticky', right: '0px', backgroundColor: 'var(--color-white)' })
    }
    // The other columns are not pinned.
    expect(screen.getByRole('columnheader', { name: 'Nome' })).not.toHaveClass('sft-sticky-end')
    expect(within(bodyRows()[0]!).getAllByRole('cell')[0]!.style.position).toBe('')
  })

  it('also while loading: the skeleton has the same pinned column', () => {
    render(<SortableFilterTable columns={pinned} data={[]} loading label="Utenti" />)
    const firstRow = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')[0]!
    expect(within(firstRow).getAllByRole('cell').at(-1)).toHaveStyle({ position: 'sticky' })
  })

  it('a sticky column that is not the last one is a caller mistake: said, and nothing is pinned', () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrong: ColumnDef<Row>[] = [{ ...COLUMNS[0]!, sticky: 'end' }, ...COLUMNS.slice(1)]
    render(<SortableFilterTable columns={wrong} data={ROWS} label="Utenti" />)
    expect(errore).toHaveBeenCalledWith(expect.stringContaining('only the last column can be sticky: name'))
    expect(screen.getByRole('columnheader', { name: 'Nome' })).not.toHaveClass('sft-sticky-end')
  })
})

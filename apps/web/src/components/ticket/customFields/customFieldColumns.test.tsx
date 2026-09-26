/**
 * THE CUSTOMER'S OWN FIELDS AS COLUMNS OF THE TICKET LISTS (wave 4).
 *
 * The lists of changes, problems and requests show one extra column per field
 * the customer added to the ticket type, and the CSV export reads the same
 * columns. If this breaks, the columns come out in the wrong order, show the
 * internal value of a vocabulary instead of the word the customer chose, or
 * offer a sort the server cannot do. Pinned here: which fields become columns
 * and in what order, how a cell reads, and that the rows carry one key per
 * column for the table and the export alike.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { SortableFilterTable } from '@/components/SortableFilterTable'
import { formatDate } from '@/lib/datetime'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { useCustomFieldColumns, withCustomFieldCells } = await import('./customFieldColumns')

interface Row { id: string; title: string; customFields?: { name: string; value: string | null }[] | null }

const field = (name: string, label: string, fieldType: string, order: number, over: Record<string, unknown> = {}) => ({
  name, label, fieldType, order, isSystem: false, required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false, ...over,
})

const ITIL_TYPES = [
  {
    name: 'change',
    fields: [
      field('title', 'Title', 'string', 0, { isSystem: true }),
      field('outcome', 'Outcome', 'enum', 2, { enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome' }),
      field('cost_center', 'Cost center', 'string', 1),
      // Same order as «outcome»: the name decides.
      field('approved', 'Approved', 'boolean', 2),
      field('go_live', 'Go live', 'date', 3),
      field('ticket_ref', '', 'string', 4),
    ],
  },
  { name: 'incident', fields: [field('impact_note', 'Impact note', 'string', 1)] },
]

const vocabularies: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name, value) => (name === 'change_outcome' ? ({ failed: 'Rolled back', successful: 'Done' } as Record<string, string>)[value] ?? null : null),
  colorOf: () => null,
  entriesOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}

function ChangeList({ rows }: { rows: Row[] }) {
  const custom = useCustomFieldColumns<Row>('change')
  return (
    <SortableFilterTable<Row>
      label="Changes"
      columns={[{ key: 'title', label: 'Title', sortable: true }, ...custom]}
      data={withCustomFieldCells(rows)}
    />
  )
}

const show = (rows: Row[]) => renderWithProviders(
  <DomainVocabularyContext.Provider value={vocabularies}><ChangeList rows={rows} /></DomainVocabularyContext.Provider>,
)

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: ITIL_TYPES }
})

describe('useCustomFieldColumns', () => {
  it('one column per customer field of THIS ticket type, after the product\'s, in the designer\'s order', () => {
    show([])
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    // System fields are the product's own; the incident's field belongs to another list.
    // A field without a label is headed by its name rather than by nothing.
    expect(headers).toEqual(['Title', 'Cost center', 'Approved', 'Outcome', 'Go live', 'ticket_ref'])
  })

  it('the customer columns sort too, on the server by their `cf:` key (26 Sep 2026: every column sorts)', () => {
    show([])
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute('aria-sort', 'none')
    const outcome = screen.getByRole('columnheader', { name: 'Outcome' })
    expect(outcome).toHaveAttribute('aria-sort', 'none')
    expect(within(outcome).getByRole('button')).toBeInTheDocument()
  })

  it('a cell reads like a person reads it: the vocabulary word, Yes/No, the date in the reader\'s format', () => {
    show([{ id: 'c1', title: 'Upgrade core switch', customFields: [
      { name: 'outcome', value: 'failed' },
      { name: 'approved', value: 'true' },
      { name: 'go_live', value: '2026-09-30' },
      { name: 'cost_center', value: 'IT-01' },
      { name: 'ticket_ref', value: '' },
    ] }])
    const cells = within(screen.getByRole('row', { name: /Upgrade core switch/ })).getAllByRole('cell')
    const [, costCenter, approved, outcome, goLive, ref] = cells
    expect(outcome).toHaveTextContent('Rolled back')
    expect(approved).toHaveTextContent('Yes')
    expect(goLive).toHaveTextContent(formatDate('2026-09-30'))
    expect(goLive).not.toHaveTextContent('2026-09-30')
    expect(costCenter).toHaveTextContent('IT-01')
    expect(costCenter!.querySelector('span')).not.toHaveStyle({ color: 'var(--color-slate-light)' })
    // An empty value is a muted dash, not a blank that looks like a rendering hole.
    expect(ref).toHaveTextContent('—')
    expect(ref!.querySelector('span')).toHaveStyle({ color: 'var(--color-slate-light)' })
  })

  it('a ticket without customer fields shows a muted dash in every customer column', () => {
    show([{ id: 'c2', title: 'Legacy change', customFields: null }])
    const cells = within(screen.getByRole('row', { name: /Legacy change/ })).getAllByRole('cell').slice(1)
    expect(cells).toHaveLength(5)
    for (const c of cells) {
      expect(c).toHaveTextContent('—')
      expect(c.querySelector('span')).toHaveStyle({ color: 'var(--color-slate-light)' })
    }
  })
})

describe('withCustomFieldCells', () => {
  it('spreads each value under its own column key, keeping the row and leaving the original untouched', () => {
    const rows = [{ id: 'c1', title: 'A', customFields: [{ name: 'outcome', value: 'failed' }, { name: 'cost_center', value: null }] }]
    const out = withCustomFieldCells(rows)
    expect(out).toEqual([{ ...rows[0], 'cf:outcome': 'failed', 'cf:cost_center': null }])
    expect(rows[0]).not.toHaveProperty('cf:outcome')
  })
})

/**
 * THE CATALOG FORM FIELDS AS COLUMNS of the service-request list.
 *
 * An administrator switches «in lists» on for a few fields of the catalog
 * form library, and those fields become columns of the request list (and of
 * its CSV export, which reads the same keys). What matters for the user: only
 * the chosen fields become columns; a cell shows the LABEL of the answer (the
 * API translates `production` into «Production»), a multiple choice as a
 * comma-separated list, and an unanswered field as a dash — never «null».
 * The columns cannot be sorted: the server only sorts on product fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { SortableFilterTable } from '@/components/SortableFilterTable'
import type { FormFieldValue } from './formFieldColumns'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { useFormFieldColumns } = await import('./formFieldColumns')

interface Request { id: string; title: string; formFieldValues?: FormFieldValue[] | null }

const answer = (name: string, displayValue: string | null, displayValues: string[] = []): FormFieldValue =>
  ({ name, label: name, fieldType: 'text', displayValue, displayValues })

/** The request list as the page builds it: its own columns, then the form ones. */
function RequestList({ rows }: { rows: Request[] }) {
  const { columns, withCells } = useFormFieldColumns<Request>()
  return (
    <SortableFilterTable<Request>
      label="Requests"
      columns={[{ key: 'title', label: 'Title' }, ...columns]}
      data={withCells(rows)}
    />
  )
}

const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent)
const rowOf = (title: string) => screen.getByText(title).closest('tr') as HTMLElement

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetFormFields'] = { formFields: [
    { name: 'environment', label: 'Environment', inList: true },
    { name: 'software', label: 'Software to install', inList: true },
    { name: 'justification', label: 'Business justification', inList: false },
  ] }
})

describe('useFormFieldColumns', () => {
  it('only the library fields with «in lists» on become columns, after the page\'s own', () => {
    render(<RequestList rows={[]} />)
    expect(headers()).toEqual(['Title', 'Environment', 'Software to install'])
  })

  it('asks the library in the language of the page, like the library page does (one cache)', () => {
    render(<RequestList rows={[]} />)
    expect(apolloFinto.chiamata('GetFormFields')).toEqual({ language: 'en' })
  })

  it('a cell shows the label of the answer; a multiple choice as a comma-separated list', () => {
    render(<RequestList rows={[{
      id: 'r1', title: 'New laptop',
      formFieldValues: [answer('environment', 'Production'), answer('software', null, ['Office', 'Visio'])],
    }]} />)
    const cells = within(rowOf('New laptop')).getAllByRole('cell').map((c) => c.textContent)
    expect(cells).toEqual(['New laptop', 'Production', 'Office, Visio'])
  })

  it('an unanswered field, or a request with no answers at all, shows a dash', () => {
    render(<RequestList rows={[
      { id: 'r1', title: 'Blank answer', formFieldValues: [answer('environment', ''), answer('software', null)] },
      { id: 'r2', title: 'No form', formFieldValues: null },
    ]} />)
    expect(within(rowOf('Blank answer')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Blank answer', '—', '—'])
    expect(within(rowOf('No form')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['No form', '—', '—'])
  })

  it('the form columns sort too, on the server by their `ff:` key (26 Sep 2026: every column sorts)', () => {
    render(<RequestList rows={[]} />)
    const envHeader = screen.getByRole('columnheader', { name: 'Environment' })
    expect(within(envHeader).getByRole('button')).toBeInTheDocument()
    expect(envHeader).toHaveAttribute('aria-sort', 'none')
  })

  it('an answer to a field that is not in the list is kept off screen', () => {
    render(<RequestList rows={[{ id: 'r1', title: 'Hidden', formFieldValues: [answer('justification', 'Budget 2026')] }]} />)
    expect(screen.queryByText('Budget 2026')).not.toBeInTheDocument()
  })

  it('while the library is loading there is no form column, and the rows are unchanged', () => {
    apolloFinto.risposte['GetFormFields'] = undefined
    render(<RequestList rows={[{ id: 'r1', title: 'Loading', formFieldValues: [answer('environment', 'Production')] }]} />)
    expect(headers()).toEqual(['Title'])
    expect(within(rowOf('Loading')).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Loading'])
  })
})

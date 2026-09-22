/**
 * The column editor of a repeatable TABLE field in the form library.
 *
 * What a regression costs the admin: the document this editor writes is sent
 * as-is to the API, which rejects what does not stand up (a choice column
 * without a vocabulary, a vocabulary left on a number column). If switching
 * the type did not clear the vocabulary, or removing a column removed the
 * wrong one, the admin would get a save error they cannot explain — or a table
 * whose rows no longer match their columns.
 */
import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FORM_TABLE_VERSION, type FormTableColumn, type FormTableDefinition } from '@opengraphity/types'
import { TableColumnsEditor } from '../TableColumnsEditor'

const VOCABULARIES = [{ name: 'environment', label: 'Environment' }, { name: 'bare', label: '' }]

const column = (over: Partial<FormTableColumn> = {}): FormTableColumn =>
  ({ name: 'role', labels: { it: 'Ruolo', en: 'Role' }, fieldType: 'text', vocabulary: null, required: false, ...over })

/** A controlled host, as the library designer is: every change is kept and recorded. */
function Host({ initial, seen }: { initial: FormTableDefinition; seen: FormTableDefinition[] }) {
  const [def, setDef] = useState(initial)
  return <TableColumnsEditor definizione={def} vocabolari={VOCABULARIES} onChange={(d) => { seen.push(d); setDef(d) }} />
}

const setup = (columns: FormTableColumn[]) => {
  const seen: FormTableDefinition[] = []
  const user = userEvent.setup()
  render(<Host initial={{ version: FORM_TABLE_VERSION, columns }} seen={seen} />)
  return { user, seen, last: () => seen.at(-1)! }
}

const rows = () => screen.getAllByRole('row').slice(1)

describe('TableColumnsEditor', () => {
  it('an empty table says it needs a column, and "Add a column" adds a blank text column', async () => {
    const { user, last } = setup([])
    expect(screen.getByText('No columns yet: a table needs at least one.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Add a column/ }))
    // The version travels with every change: the API reads the shape from it.
    expect(last()).toEqual({ version: FORM_TABLE_VERSION, columns: [{ name: '', labels: {}, fieldType: 'text', vocabulary: null, required: false }] })
    expect(screen.queryByText('No columns yet: a table needs at least one.')).toBeNull()
  })

  it('name and both labels are edited per column, without touching the other language', async () => {
    const { user, last } = setup([column({ labels: {} })])
    const [name, labelIt, labelEn] = within(rows()[0]!).getAllByRole('textbox') as HTMLInputElement[]
    expect(name).toHaveAttribute('placeholder', 'role')
    // Missing labels render empty, not "undefined".
    expect(labelIt).toHaveValue('')

    await user.clear(name!)
    await user.type(name!, 'owner')
    await user.type(labelIt!, 'Resp')
    await user.type(labelEn!, 'Own')
    expect(last().columns[0]).toMatchObject({ name: 'owner', labels: { it: 'Resp', en: 'Own' } })
  })

  it('a choice column offers the tenant vocabularies (label, or name when it has none) and stores the choice', async () => {
    const { user, last } = setup([column()])
    const typeSelect = within(rows()[0]!).getByRole('combobox')
    // A text column has no vocabulary to pick.
    expect(within(rows()[0]!).getByText('—')).toBeInTheDocument()

    await user.selectOptions(typeSelect, 'enum')
    const vocab = within(rows()[0]!).getAllByRole('combobox')[1]!
    expect(within(vocab).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select', 'Environment', 'bare'])
    await user.selectOptions(vocab, 'environment')
    expect(last().columns[0]).toMatchObject({ fieldType: 'enum', vocabulary: 'environment' })

    // Back to "Select": the vocabulary becomes null, not an empty string the API would reject.
    await user.selectOptions(vocab, '')
    expect(last().columns[0]!.vocabulary).toBeNull()
  })

  it('switching a choice column to another type drops its vocabulary; staying on enum keeps it', async () => {
    const { user, last } = setup([column({ fieldType: 'enum', vocabulary: 'environment' })])
    const typeSelect = within(rows()[0]!).getAllByRole('combobox')[0]!
    await user.selectOptions(typeSelect, 'enum')
    expect(last().columns[0]!.vocabulary).toBe('environment')
    await user.selectOptions(typeSelect, 'number')
    // Why: a number column with a vocabulary is refused by the API.
    expect(last().columns[0]).toMatchObject({ fieldType: 'number', vocabulary: null })
  })

  it('"required" toggles per column, and delete removes exactly that column', async () => {
    const { user, last } = setup([column({ name: 'a' }), column({ name: 'b' }), column({ name: 'c' })])
    await user.click(within(rows()[1]!).getByRole('checkbox', { name: 'Required' }))
    expect(last().columns.map((c) => c.required)).toEqual([false, true, false])

    await user.click(within(rows()[1]!).getByRole('button', { name: 'Delete' }))
    expect(last().columns.map((c) => c.name)).toEqual(['a', 'c'])
  })

  it('shows the table headers the admin reads the columns by', () => {
    setup([column()])
    for (const h of ['Name', 'Label (Italian)', 'Label (English)', 'Vocabulary', 'Required']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument()
    }
    expect(screen.getByText('Columns of the table')).toBeInTheDocument()
  })
})

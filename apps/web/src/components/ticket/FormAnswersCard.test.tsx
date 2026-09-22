/**
 * The answers to a service request's catalog form, as they were asked (the
 * form revision), and correctable one at a time (owner's decision, 17 Sep
 * 2026). Why these behaviours matter:
 * - an answer must READ as the requester chose it: the dictionary label, a
 *   «Yes»/«No», the referenced items, the attached files, a table as a table —
 *   never an internal value or an empty cell that looks like a broken form;
 * - only plain values are correctable, and only where the card knows which
 *   request it belongs to: a computed field is the formula's job;
 * - a correction the server refuses keeps the field in edit mode (the value
 *   was NOT saved) and leaves no unhandled rejection behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { FormAnswersCard, type FormAnswer } from './FormAnswersCard'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

function answer(over: Partial<FormAnswer> & { name: string }): FormAnswer {
  return {
    label: over.name, fieldType: 'text', value: null, values: [], displayValue: null, displayValues: [],
    references: [], files: [], options: [], tableColumns: [], rows: [], ...over,
  }
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

/** The <dd> of an answer, found through its label. */
const valueOf = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement

describe('FormAnswersCard', () => {
  it('no answers → no card at all (a request not born from a form is not a broken form)', () => {
    const { container } = renderWithProviders(<FormAnswersCard answers={[]} revision={3} />)
    expect(screen.queryByText(/Form answers/)).not.toBeInTheDocument()
    expect(container.querySelector('dl')).toBeNull()
  })

  it('the title names the form revision when there is one', () => {
    const { unmount } = renderWithProviders(<FormAnswersCard answers={[answer({ name: 'a' })]} revision={3} />)
    expect(screen.getByText('Form answers (revision 3)')).toBeInTheDocument()
    unmount()
    renderWithProviders(<FormAnswersCard answers={[answer({ name: 'a' })]} revision={null} />)
    expect(screen.getByText('Form answers')).toBeInTheDocument()
  })

  it('each kind of answer reads as a person would say it', () => {
    renderWithProviders(<FormAnswersCard revision={1} answers={[
      answer({ name: 'env', label: 'Environment', fieldType: 'enum', value: 'production', displayValue: 'Production' }),
      answer({ name: 'urgent', label: 'Urgent', fieldType: 'boolean', value: 'true', displayValue: 'true' }),
      answer({ name: 'backup', label: 'Backup', fieldType: 'boolean', value: 'false', displayValue: 'false' }),
      answer({ name: 'tags', label: 'Tags', fieldType: 'multi', values: ['a', 'b'], displayValues: ['Alpha', 'Beta'] }),
      answer({ name: 'server', label: 'Server', fieldType: 'reference', references: [{ id: 'c1', label: 'srv-01' }, { id: 'c2', label: 'srv-02' }] }),
      answer({ name: 'docs', label: 'Documents', fieldType: 'attachment', files: [{ id: 'f1', filename: 'plan.pdf', sizeBytes: 10 }] }),
      answer({ name: 'notes', label: 'Notes', displayValue: '' }),
    ]} />)
    expect(valueOf('Environment')).toHaveTextContent('Production')
    expect(valueOf('Urgent')).toHaveTextContent('Yes')
    expect(valueOf('Backup')).toHaveTextContent('No')
    expect(valueOf('Tags')).toHaveTextContent('Alpha, Beta')
    expect(valueOf('Server')).toHaveTextContent('srv-01, srv-02')
    expect(valueOf('Documents')).toHaveTextContent('plan.pdf')
    // An empty answer says so instead of leaving a blank cell.
    expect(valueOf('Notes')).toHaveTextContent('not answered')
    // Without a request id the card is read-only.
    expect(screen.queryByRole('button', { name: /Correct/ })).not.toBeInTheDocument()
  })

  it('a table answer reads as a table with the columns of THAT revision; empty cells and an empty table are said', () => {
    renderWithProviders(<FormAnswersCard revision={2} requestId="r1" answers={[
      answer({
        name: 'lines', label: 'Lines', fieldType: 'table',
        tableColumns: [{ name: 'item', label: 'Item', fieldType: 'text' }, { name: 'qty', label: 'Qty', fieldType: 'number' }],
        rows: [
          { cells: [{ column: 'item', value: 'laptop', displayValue: 'Laptop' }, { column: 'qty', value: '2', displayValue: null }] },
          { cells: [{ column: 'item', value: null, displayValue: null }, { column: 'qty', value: '1', displayValue: null }] },
        ],
      }),
      answer({ name: 'empty', label: 'Empty table', fieldType: 'table', tableColumns: [{ name: 'x', label: 'X', fieldType: 'text' }], rows: [] }),
    ]} />)
    const table = within(valueOf('Lines')).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Item', 'Qty'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([['Laptop', '2'], ['—', '1']])
    expect(within(valueOf('Empty table')).getByRole('cell')).toHaveTextContent('not answered')
    // A table is not corrected from here, even with a request id.
    expect(screen.queryByRole('button', { name: /Correct/ })).not.toBeInTheDocument()
  })

  it('only plain values are correctable: a computed or reference field has no pencil', () => {
    renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'cost', label: 'Cost', fieldType: 'computed', displayValue: '10' }),
      answer({ name: 'title', label: 'Title', fieldType: 'text', value: 'Hi', displayValue: 'Hi' }),
    ]} />)
    expect(screen.queryByRole('button', { name: 'Correct "Cost"' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Correct "Title"' })).toBeInTheDocument()
  })

  it('correcting a text answer sends the new value, confirms and closes the editor', async () => {
    apolloFinto.esiti['SetRequestFormAnswer'] = { data: { setServiceRequestFormAnswer: { id: 'r1' } } }
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'title', label: 'Title', fieldType: 'text', value: 'Hi', displayValue: 'Hi' }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Title"' }))
    const box = within(valueOf('Title')).getByRole('textbox')
    expect(box).toHaveValue('Hi')
    await user.clear(box)
    await user.type(box, 'Hello')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('SetRequestFormAnswer')).toEqual({ requestId: 'r1', field: 'title', value: 'Hello' })
    expect(toast.success).toHaveBeenCalledWith('"Title" corrected')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('an emptied answer is sent as null (no answer), not as an empty string', async () => {
    apolloFinto.esiti['SetRequestFormAnswer'] = { data: { ok: true } }
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'n', label: 'Count', fieldType: 'number', value: '3', displayValue: '3' }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Count"' }))
    // The control fits the type: a number field gets a number input.
    const input = within(valueOf('Count')).getByRole('spinbutton')
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('SetRequestFormAnswer')).toMatchObject({ value: null })
  })

  it('a dictionary field is corrected from a list of its LABELS, a yes/no from Yes/No', async () => {
    apolloFinto.esiti['SetRequestFormAnswer'] = { data: { ok: true } }
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'env', label: 'Environment', fieldType: 'enum', value: 'test', displayValue: 'Test',
        options: [{ value: 'test', label: 'Test' }, { value: 'production', label: 'Production' }] }),
      answer({ name: 'urgent', label: 'Urgent', fieldType: 'boolean', value: null, displayValue: null }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Environment"' }))
    const env = within(valueOf('Environment')).getByRole('combobox')
    await user.selectOptions(env, 'Production')
    await user.click(within(valueOf('Environment')).getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('SetRequestFormAnswer')).toEqual({ requestId: 'r1', field: 'env', value: 'production' })

    await user.click(screen.getByRole('button', { name: 'Correct "Urgent"' }))
    const yn = within(valueOf('Urgent')).getByRole('combobox')
    expect(within(yn).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select', 'Yes', 'No'])
    await user.selectOptions(yn, 'No')
    await user.click(within(valueOf('Urgent')).getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('SetRequestFormAnswer')).toEqual({ requestId: 'r1', field: 'urgent', value: 'false' })
  })

  it('date and date-time fields get the matching pickers', async () => {
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'd', label: 'Day', fieldType: 'date', value: '2026-09-01', displayValue: '1 Sep 2026' }),
      answer({ name: 'dt', label: 'Moment', fieldType: 'datetime', value: null, displayValue: null }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Day"' }))
    expect(valueOf('Day').querySelector('input')).toHaveAttribute('type', 'date')
    await user.click(screen.getByRole('button', { name: 'Correct "Moment"' }))
    // Only one answer is in correction at a time.
    expect(valueOf('Day').querySelector('input')).toBeNull()
    expect(valueOf('Moment').querySelector('input')).toHaveAttribute('type', 'datetime-local')
  })

  it('Cancel leaves the answer as it was, without saving', async () => {
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'title', label: 'Title', value: 'Hi', displayValue: 'Hi' }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Title"' }))
    await user.type(within(valueOf('Title')).getByRole('textbox'), 'XYZ')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(valueOf('Title')).toHaveTextContent('Hi')
    expect(apolloFinto.chiamata('SetRequestFormAnswer')).toBeUndefined()
  })

  it('a correction the server refuses keeps the field in edit mode, with no success message', async () => {
    apolloFinto.esiti['SetRequestFormAnswer'] = { error: new Error('a condition hides this field') }
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'title', label: 'Title', value: 'Hi', displayValue: 'Hi' }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Title"' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenCalledWith('a condition hides this field')
    expect(toast.success).not.toHaveBeenCalled()
    expect(within(valueOf('Title')).getByRole('textbox')).toBeInTheDocument()
  })

  it('a rejected mutation promise is caught: the field stays open and nothing is thrown', async () => {
    // Apollo 4 rejects mutate() even with onError: simulate the bare rejection.
    const { useMutation } = await import('@apollo/client/react')
    const [mutate] = (useMutation as unknown as (d: unknown) => [ReturnType<typeof vi.fn>])({ definitions: [{ kind: 'OperationDefinition', name: { value: 'SetRequestFormAnswer' } }] })
    mutate.mockRejectedValueOnce(new Error('network down'))
    const { user } = renderWithProviders(<FormAnswersCard revision={1} requestId="r1" answers={[
      answer({ name: 'title', label: 'Title', value: 'Hi', displayValue: 'Hi' }),
    ]} />)
    await user.click(screen.getByRole('button', { name: 'Correct "Title"' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(toast.success).not.toHaveBeenCalled()
    expect(within(valueOf('Title')).getByRole('textbox')).toBeInTheDocument()
  })
})

/**
 * THE FIELD LIBRARY of the catalog forms.
 *
 * A field is defined once and reused by every form: its NAME becomes the
 * property on the tickets, which is why reports can sum it — and why it can
 * never be renamed. What must not regress:
 *  - the table must say which forms use a field, and a used field must not be
 *    deletable (the server refuses; the page says why before anyone tries);
 *  - a deletion is asked first, and only the confirmed one is sent;
 *  - a new field is sent with its name and type, an edited one WITHOUT them
 *    (they are locked), and a field with no label in any language is refused
 *    here instead of reaching the server;
 *  - a refused save keeps the editor open with what was typed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { libraryField } from './__tests__/formBuilderFixtures'

/*
 * Apollo Client 4 calls a mutation's `onError` AND then rejects its promise
 * (`react/hooks/useMutation.js`); the shared fake resolves instead. Here a
 * refused save or deletion rejects, as it does in the app — and a refusal the
 * panel forgot to catch fails the run as an unhandled rejection.
 */
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  type Execute = (o?: Record<string, unknown>) => Promise<{ data?: unknown; errors?: Error[] }>
  return {
    ...base,
    useMutation: (doc: Parameters<typeof base.useMutation>[0], opts?: Parameters<typeof base.useMutation>[1]) => {
      const [execute, state] = base.useMutation(doc, opts) as unknown as [Execute, unknown]
      const likeApollo4 = async (o?: Record<string, unknown>) => {
        const r = await execute(o)
        if (r.errors?.[0]) throw r.errors[0]
        return r
      }
      return [likeApollo4, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { FieldLibraryPanel } = await import('./FieldLibraryPanel')

const FIELDS = [
  libraryField('cost_centre', 'enum', 'Cost centre', {
    required: true, help: 'Where it is billed', vocabulary: 'cost_centres', inList: true, usedBy: ['New laptop', 'App access'],
  }),
  libraryField('budget', 'number', 'Budget'),
]

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetFormFields'] = { formFields: FIELDS }
  apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [{ name: 'cost_centres', label: 'Cost centres' }] }
  apolloFinto.risposte['GetCatalogFormLimits'] = { catalogFormLimits: {
    maxLibraryFields: 120, maxFieldsPerForm: 40, maxTableRows: 50, libraryFieldsUsed: 2, min: 10, max: 500,
  } }
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
  ] } }
})

const rowOf = (name: string) => screen.getByRole('cell', { name }).closest('tr') as HTMLElement

async function typeInto(user: UserEvent, name: string, text: string) {
  const box = screen.getByRole('textbox', { name })
  await user.clear(box)
  await user.type(box, text)
}

describe('FieldLibraryPanel: the table', () => {
  it('lists each field: label, required mark, help, name, type, vocabulary, column flag and the forms using it', () => {
    renderWithProviders(<FieldLibraryPanel />)
    // The limits sit on top, next to what they limit.
    expect(screen.getByText('2 of 120 library fields')).toBeInTheDocument()

    const costRow = rowOf('cost_centre')
    expect(within(costRow).getByText('*')).toBeInTheDocument()
    expect(within(costRow).getByText('Where it is billed')).toBeInTheDocument()
    expect(within(costRow).getByText('One choice')).toBeInTheDocument()
    expect(within(costRow).getByText('cost_centres')).toBeInTheDocument()
    expect(within(costRow).getByRole('cell', { name: 'Yes' })).toBeInTheDocument()
    expect(within(costRow).getByRole('cell', { name: 'New laptop, App access' })).toBeInTheDocument()

    const budgetRow = rowOf('budget')
    expect(within(budgetRow).queryByText('*')).toBeNull()
    expect(within(budgetRow).getByRole('cell', { name: 'No' })).toBeInTheDocument()
    expect(within(budgetRow).getByRole('cell', { name: 'no form' })).toBeInTheDocument()
  })

  it('an empty library says the first field can be used by every form', () => {
    apolloFinto.risposte['GetFormFields'] = undefined
    renderWithProviders(<FieldLibraryPanel />)
    expect(screen.getByText(/No fields yet. The first one you add can be used by every form/)).toBeInTheDocument()
  })

  it('a field used by a form cannot be deleted, and the button says by which forms', () => {
    renderWithProviders(<FieldLibraryPanel />)
    const deleteButton = within(rowOf('cost_centre')).getByRole('button', { name: 'Delete' })
    expect(deleteButton).toBeDisabled()
    expect(deleteButton).toHaveAttribute('title', 'Used by the form of: New laptop, App access. Remove it from those forms first.')
    expect(within(rowOf('budget')).getByRole('button', { name: 'Delete' })).toBeEnabled()
  })
})

describe('FieldLibraryPanel: deleting', () => {
  it('asks first, naming the field; then deletes it and reads the library again', async () => {
    apolloFinto.esiti['DeleteFormField'] = { data: { deleteFormField: true } }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(within(rowOf('budget')).getByRole('button', { name: 'Delete' }))
    const question = screen.getByRole('dialog', { name: 'Delete this field?' })
    expect(within(question).getByText(/“Budget” will disappear from the library/)).toBeInTheDocument()
    await user.click(within(question).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Field deleted'))
    expect(apolloFinto.chiamata('DeleteFormField')).toEqual({ id: 'f-budget' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this field?' })).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('saying no sends nothing', async () => {
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(within(rowOf('budget')).getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this field?' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Delete this field?' })).toBeNull()
    expect(apolloFinto.chiamate['DeleteFormField']).toBeUndefined()
  })

  it('a refused deletion closes the question and claims nothing', async () => {
    apolloFinto.esiti['DeleteFormField'] = { error: new Error('The field is used by a form') }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(within(rowOf('budget')).getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this field?' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this field?' })).toBeNull())
    expect(toast.error).toHaveBeenCalledWith('The field is used by a form')
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('FieldLibraryPanel: creating and editing', () => {
  it('«New field» opens an empty editor; its close button closes it', async () => {
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(screen.getByRole('button', { name: 'New field' }))
    expect(screen.getByText('New field', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeEnabled()
    // Two «Cancel»: the close button of the box and the editor's own.
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull()
  })

  it('a field with no label in any language is refused before the server', async () => {
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(screen.getByRole('button', { name: 'New field' }))
    await typeInto(user, 'Name', 'cost_code')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenCalledWith('A field needs a label in at least one language.')
    expect(apolloFinto.chiamate['CreateFormField']).toBeUndefined()
  })

  it('creates the field with its trimmed name and its type, then closes and reads the library again', async () => {
    apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-cost_code' } } }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(screen.getByRole('button', { name: 'New field' }))
    await typeInto(user, 'Name', '  cost_code ')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'Number')
    await typeInto(user, 'Label (English)', 'Cost code')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Field created'))
    expect(apolloFinto.chiamata('CreateFormField')).toEqual({ input: expect.objectContaining({
      name: 'cost_code', fieldType: 'number', label: 'Cost code', labels: [{ language: 'en', text: 'Cost code' }],
    }) })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a double click on Save creates the field once', async () => {
    apolloFinto.esiti['CreateFormField'] = { data: { createFormField: { id: 'f-cost_code' } } }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(screen.getByRole('button', { name: 'New field' }))
    await typeInto(user, 'Name', 'cost_code')
    await typeInto(user, 'Label (English)', 'Cost code')
    const save = screen.getByRole('button', { name: 'Save' })
    // Two presses in a row, before the first save has come back.
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Field created'))
    expect(apolloFinto.chiamate['CreateFormField']).toHaveLength(1)
  })

  it('a refused creation keeps the editor open with what was typed', async () => {
    apolloFinto.esiti['CreateFormField'] = { error: new Error('The name is reserved') }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(screen.getByRole('button', { name: 'New field' }))
    await typeInto(user, 'Name', 'status')
    await typeInto(user, 'Label (English)', 'Status')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The name is reserved'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('status')
  })

  it('editing locks name and type, and saves the field without them', async () => {
    apolloFinto.esiti['UpdateFormField'] = { data: { updateFormField: { id: 'f-cost_centre' } } }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(within(rowOf('cost_centre')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Editing “Cost centre”')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('cost_centre')
    expect(screen.getByRole('textbox', { name: 'Help text (English)' })).toHaveValue('Where it is billed')
    await typeInto(user, 'Label (English)', 'Cost center')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Field saved'))
    const sent = apolloFinto.chiamata('UpdateFormField') as { id: string; input: Record<string, unknown> }
    expect(sent.id).toBe('f-cost_centre')
    expect(sent.input).toMatchObject({ vocabulary: 'cost_centres', required: true, inList: true, help: 'Where it is billed' })
    expect(sent.input).not.toHaveProperty('name')
    expect(sent.input).not.toHaveProperty('fieldType')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
  })

  it('a refused edit keeps the editor open', async () => {
    apolloFinto.esiti['UpdateFormField'] = { error: new Error('Vocabulary not found') }
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(within(rowOf('budget')).getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Vocabulary not found'))
    expect(screen.getByText('Editing “Budget”')).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('«New field» while editing starts a blank field, not a copy of the edited one', async () => {
    const { user } = renderWithProviders(<FieldLibraryPanel />)
    await user.click(within(rowOf('cost_centre')).getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'New field' }))
    expect(screen.queryByText('Editing “Cost centre”')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Label (English)' })).toHaveValue('')
  })
})

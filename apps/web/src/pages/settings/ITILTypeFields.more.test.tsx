/**
 * THE FIELD EDITOR OF THE ITIL TYPE DESIGNER.
 *
 * What an administrator sets here decides what agents and portal users can see
 * and change on every ticket of the type. If the editor regresses, the damage
 * is on the tickets: a field saved with the wrong step rules asks "Outcome" at
 * opening (the c-test bug that created these rules), a step list in the wrong
 * order saves rules the API reads differently, a system field that lets
 * "required" be flipped promises a change the server will not make, an enum
 * field that keeps a stale vocabulary when switched to text saves garbage.
 * These tests drive the editor as a user would and read what is handed to
 * `onSaveField` — the one contract the designer hook relies on.
 */
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ITILField, EnumTypeOption, FieldFormState } from './useITILTypeDesigner'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { ITILTypeFields, stepChoicesOf } = await import('./ITILTypeFields')

const field = (over: Partial<ITILField>): ITILField => ({
  id: 'f-x', name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false,
  enumTypeId: null, enumTypeName: null, validationScript: null, visibilityScript: null, defaultScript: null, ...over,
})

const SYSTEM = field({ id: 'f-title', name: 'title', label: 'Title', isSystem: true, required: true, order: 1 })
const OUTCOME = field({
  id: 'f-outcome', name: 'outcome', label: 'Outcome', order: 2, visibleToEndUser: true,
  stepVisibility: { mode: 'steps', steps: ['review'] }, stepEditability: { mode: 'visible', steps: [] },
})

const ENUMS = { enumTypes: [
  { id: 'e-sev', name: 'severity', label: 'Severity', values: ['low', 'high'], scope: 'incident', isShipped: true },
  { id: 'e-own', name: 'own', label: 'Own list', values: ['a'], scope: 'incident', isShipped: false },
] as EnumTypeOption[] }

/** Two active workflows: `review` exists only in the generic one, `closed` in both. */
const STEPS = { ticketWorkflowSteps: [
  { workflow: 'Generic', steps: [
    { name: 'new', label: 'New', labels: [] },
    { name: 'review', label: 'Review', labels: [] },
    { name: 'closed', label: 'Closed', labels: [] },
  ] },
  { workflow: 'Security', steps: [
    { name: 'new', label: 'New', labels: [] },
    { name: 'closed', label: 'Closed', labels: [] },
  ] },
] }

type Props = { typeName?: string; fields?: ITILField[]; editing?: string | null }

function mount({ typeName = 'incident', fields = [SYSTEM, OUTCOME], editing = null }: Props = {}) {
  const onSaveField = vi.fn<(typeId: string, fieldId: string | null, form: FieldFormState, isSystem?: boolean) => void>()
  const onDeleteField = vi.fn()
  // The page owns the "which row is open" state: the harness plays the page.
  function Harness() {
    const [editingFieldId, setEditingFieldId] = useState<string | null>(editing)
    const [addingField, setAddingField] = useState(false)
    return (
      <ITILTypeFields typeId="t-1" typeName={typeName} fields={fields}
        editingFieldId={editingFieldId} setEditingFieldId={setEditingFieldId}
        addingField={addingField} setAddingField={setAddingField}
        onSaveField={onSaveField} onDeleteField={onDeleteField} enumTypesData={ENUMS} />
    )
  }
  return { ...renderWithProviders(<Harness />), onSaveField, onDeleteField }
}

const savedForm = (spy: ReturnType<typeof mount>['onSaveField']) => spy.mock.calls.at(-1)!

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetTicketWorkflowSteps'] = STEPS
})

describe('stepChoicesOf', () => {
  it('lists each step once, in order, and says which workflows have it when not all do', () => {
    expect(stepChoicesOf(STEPS.ticketWorkflowSteps)).toEqual([
      { name: 'new', label: 'New', only: null },
      { name: 'review', label: 'Review', only: ['Generic'] },
      { name: 'closed', label: 'Closed', only: null },
    ])
  })
})

describe('ITILTypeFields: adding a custom field', () => {
  it('reads the steps of every active workflow of the type', () => {
    mount()
    expect(apolloFinto.chiamata('GetTicketWorkflowSteps')).toEqual({ entityType: 'incident' })
  })

  it('an empty custom list says so, and opening the editor hides that message and disables "Add"', async () => {
    const { user } = mount({ fields: [SYSTEM] })
    expect(screen.getByText(/No custom fields/)).toBeInTheDocument()
    const add = screen.getByRole('button', { name: /Add field/ })
    await user.click(add)
    expect(add).toBeDisabled()
    expect(screen.queryByText(/No custom fields/)).not.toBeInTheDocument()
    // A new field has an editable name.
    expect(screen.getByRole('textbox', { name: 'Field name' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(screen.queryByRole('textbox', { name: 'Field name' })).not.toBeInTheDocument()
    expect(add).toBeEnabled()
  })

  it('saves what was typed, with the portal flag and a step rule, as a NEW field (fieldId null)', async () => {
    const { user, onSaveField } = mount()
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    await user.type(screen.getByRole('textbox', { name: 'Field name' }), 'serial')
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Serial')
    const order = screen.getByRole('spinbutton')
    await user.clear(order)
    await user.type(order, '7')
    await user.click(screen.getByRole('checkbox', { name: 'Required' }))
    await user.click(screen.getByRole('checkbox', { name: 'Offer it in the portal' }))
    // "Only in these steps": a step that is only in one workflow says which.
    const visibility = screen.getByRole('group', { name: /In which workflow steps the field is shown/ })
    await user.click(within(visibility).getByRole('radio', { name: 'Only in these steps' }))
    expect(within(visibility).getByRole('alert')).toHaveTextContent('Choose at least one step.')
    expect(within(visibility).getByText('(only Generic)')).toBeInTheDocument()
    // Ticked out of order, saved in workflow order: the rule reads the same whatever the clicks.
    await user.click(within(visibility).getByRole('checkbox', { name: 'Closed' }))
    await user.click(within(visibility).getByRole('checkbox', { name: /Review/ }))
    expect(within(visibility).queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save/ }))
    const [typeId, fieldId, form] = savedForm(onSaveField)
    expect(typeId).toBe('t-1')
    expect(fieldId).toBeNull()
    expect(form).toMatchObject({
      name: 'serial', label: 'Serial', fieldType: 'string', required: true, order: 7, visibleToEndUser: true,
      visibilityMode: 'steps', visibilitySteps: ['review', 'closed'], editabilityMode: 'visible',
    })
  })

  it('"from this step on" saves the chosen step; editability can be limited to steps', async () => {
    const { user, onSaveField } = mount()
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    await user.click(screen.getByRole('radio', { name: 'From this step on' }))
    const from = screen.getByRole('combobox', { name: 'Shown from step' })
    expect(within(from).getByRole('option', { name: 'Review (only Generic)' })).toBeInTheDocument()
    await user.selectOptions(from, 'closed')
    const edit = screen.getByRole('group', { name: /In which steps it can be changed/ })
    await user.click(within(edit).getByRole('radio', { name: 'Only in these steps' }))
    await user.click(within(edit).getByRole('checkbox', { name: 'New' }))
    await user.click(within(edit).getByRole('checkbox', { name: 'Closed' }))
    // Unticking removes it again.
    await user.click(within(edit).getByRole('checkbox', { name: 'New' }))
    await user.click(within(edit).getByRole('radio', { name: 'Wherever it is shown' }))
    await user.click(within(edit).getByRole('radio', { name: 'Only in these steps' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(savedForm(onSaveField)[2]).toMatchObject({
      visibilityMode: 'from', visibilityFrom: 'closed', editabilityMode: 'steps', editabilitySteps: ['closed'],
    })
  })

  it('an enum field needs a vocabulary; switching away from enum forgets it', async () => {
    const { user, onSaveField } = mount()
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    const [type] = screen.getAllByRole('combobox')
    await user.selectOptions(type!, 'enum')
    const enumSelect = screen.getAllByRole('combobox').find((s) => within(s).queryByRole('option', { name: '— Select enum —' }))!
    // The owner of each vocabulary is shown: a client must tell its own from the shipped ones.
    expect(within(enumSelect).getByRole('option', { name: 'Severity (incident) — Shipped with the product' })).toBeInTheDocument()
    expect(within(enumSelect).getByRole('option', { name: 'Own list (incident) — Yours' })).toBeInTheDocument()
    await user.selectOptions(enumSelect, 'e-own')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(savedForm(onSaveField)[2]).toMatchObject({ fieldType: 'enum', enumTypeId: 'e-own' })
    // Back to "none", then to a text type: no stale vocabulary travels with it.
    await user.selectOptions(enumSelect, '')
    await user.selectOptions(enumSelect, 'e-sev')
    await user.selectOptions(type!, 'number')
    expect(screen.queryByRole('option', { name: '— Select enum —' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(savedForm(onSaveField)[2]).toMatchObject({ fieldType: 'number', enumTypeId: null })
  })

  it('the three scripts are written on their own tabs and all saved', async () => {
    const { user, onSaveField } = mount()
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    await user.click(screen.getByText(/Advanced scripts/))
    await user.type(screen.getByRole('textbox', { name: /At least 3 characters/ }), 'v()')
    await user.click(screen.getByRole('button', { name: 'visibilityScript' }))
    expect(screen.queryByRole('textbox', { name: /At least 3 characters/ })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: /Show only when severity/ }), 's()')
    await user.click(screen.getByRole('button', { name: 'defaultScript' }))
    await user.type(screen.getByRole('textbox', { name: /immediate/ }), 'd()')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(savedForm(onSaveField)[2]).toMatchObject({ validationScript: 'v()', visibilityScript: 's()', defaultScript: 'd()' })
  })

  it('a type opened only from the agent app does not offer the portal flag', async () => {
    const { user } = mount({ typeName: 'problem' })
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    expect(screen.queryByRole('checkbox', { name: 'Offer it in the portal' })).not.toBeInTheDocument()
  })

  it('without a type name there is no workflow to read, and the editor says the field is always shown', async () => {
    const { user } = mount({ typeName: '' })
    expect(apolloFinto.chiamate['GetTicketWorkflowSteps']).toBeUndefined()
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    expect(screen.getByText(/This ticket type has no workflow/)).toBeInTheDocument()
  })
})

describe('ITILTypeFields: editing existing fields', () => {
  it('a custom field opens with its saved rules, a fixed name, and saves under its own id', async () => {
    const { user, onSaveField } = mount()
    const row = screen.getByText('Outcome').closest('div')!.parentElement!.parentElement!.parentElement!
    await user.click(within(row).getByRole('button', { name: 'Edit' }))
    // The name and the type of an existing field never change: its values are on the tickets.
    expect(screen.getByRole('textbox', { name: 'Field name' })).toBeDisabled()
    expect(screen.getAllByRole('combobox')[0]).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Offer it in the portal' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Review/ })).toBeChecked()
    await user.clear(screen.getByRole('textbox', { name: 'Label' }))
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Result')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    const [, fieldId, form, isSystem] = savedForm(onSaveField)
    expect(fieldId).toBe('f-outcome')
    expect(isSystem).toBeUndefined()
    expect(form).toMatchObject({ name: 'outcome', label: 'Result', visibilitySteps: ['review'] })
  })

  it('cancelling a custom edit closes the editor', async () => {
    const { user } = mount({ editing: 'f-outcome' })
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(screen.queryByRole('textbox', { name: 'Field name' })).not.toBeInTheDocument()
  })

  it('a system field keeps "required" locked and has no step rules or portal flag', async () => {
    const { user, onSaveField } = mount()
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    expect(screen.getByRole('checkbox', { name: 'Required' })).toBeDisabled()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Offer it in the portal' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save/ }))
    const [, fieldId, , isSystem] = savedForm(onSaveField)
    expect(fieldId).toBe('f-title')
    // The hook needs to know: a system field saves through a different path.
    expect(isSystem).toBe(true)
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(screen.queryByRole('textbox', { name: 'Field name' })).not.toBeInTheDocument()
  })

  it('only a custom field can be deleted', async () => {
    const { user, onDeleteField } = mount()
    expect(screen.queryByRole('button', { name: 'Delete title' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete outcome' }))
    expect(onDeleteField).toHaveBeenCalledWith('t-1', 'f-outcome')
  })

  it('a system list is sorted by order', () => {
    mount({ fields: [field({ id: 'b', name: 'b', label: 'Bravo', isSystem: true, order: 2 }), field({ id: 'a', name: 'a', label: 'Alpha', isSystem: true, order: 1 })] })
    const labels = screen.getAllByText(/Alpha|Bravo/).map((n) => n.textContent)
    expect(labels[0]).toMatch(/^Alpha/)
  })
})

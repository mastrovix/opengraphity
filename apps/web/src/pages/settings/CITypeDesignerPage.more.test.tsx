/**
 * CI type designer: what the page SENDS when an administrator edits a type.
 *
 * The designer is where a tenant shapes its CMDB: every CI form, every CI
 * list column and every service map reads the types written here. The
 * sibling test covers the guard rails (shipped types are read-only, names are
 * validated, deletion lists its impact). This one covers the wiring the page
 * owns itself, where a regression is silent until data is wrong:
 *
 * - "Save settings" must send the per-language labels WITHOUT the empty ones
 *   (they are replaced as a block), and an empty service role as `null`
 *   (= "proposed by the product"), not as the previous role.
 * - Editing a field must call UPDATE, never ADD: ADD on an existing name is
 *   always refused by the API ("the field already exists"), which is the
 *   A·3.1 defect this page once had. The same holds for base fields (G-4).
 * - A failed type creation must keep the dialog open (it throws), otherwise
 *   the administrator believes the type exists.
 * - Deleting a type or a field must not delete anything when the impact or
 *   the value count cannot be read.
 *
 * The heavy child editors are replaced by small fakes that call `onSave`
 * with a known form: their own validation has its own tests, and here the
 * contract under test is what the page does with the form it gets back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { FieldForm } from './citype/CIFieldEditor'
import type { RelationForm } from './citype/CIRelationEditor'
import { CITypeDesignerPage } from './CITypeDesignerPage'

// The fake Apollo keeps ONE mutation function per operation name, and this
// page has two hooks on ADD_CI_FIELD and two on UPDATE_CI_FIELD (type vs base)
// with different reactions. Each call is bound to its own hook's callbacks, as
// real Apollo does, so the right `onCompleted` runs.
vi.mock('@apollo/client/react', async () => {
  const base = (await import('@/test/apolloFinto')).moduloApollo()
  type Cb = { onCompleted?: (d: unknown) => void; onError?: (e: Error) => void }
  return {
    ...base,
    useMutation: (doc: Parameters<typeof base.useMutation>[0], opts: Cb = {}) => {
      const [fn, state] = base.useMutation(doc, opts) as [(o?: Record<string, unknown>) => Promise<unknown>, unknown]
      return [(o: Record<string, unknown> = {}) => fn({ onCompleted: opts.onCompleted, onError: opts.onError, ...o }), state]
    },
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const FIELD_FORM: FieldForm = {
  name: 'costCenter', label: 'Cost center', fieldType: 'enum', required: true,
  defaultValue: '', enumTypeId: 'enum-1', validationScript: '', visibilityScript: 'return true',
  defaultScript: '', order: 3,
}

// Fakes for the child editors: each renders only while open and hands a known
// form to the page's `onSave`, so what reaches the mutation is the page's doing.
vi.mock('./citype/CIFieldInlineEditor', async (orig) => ({
  ...(await orig<typeof import('./citype/CIFieldInlineEditor')>()),
  CIFieldInlineEditor: (p: { initial: FieldForm | null; onSave: (f: FieldForm) => Promise<void>; onCancel: () => void; existingFieldNames?: string[] }) => (
    <div data-testid="inline-editor" data-initial={p.initial?.name ?? ''} data-taken={(p.existingFieldNames ?? []).join(',')}>
      <button type="button" onClick={() => void p.onSave(p.initial ? { ...FIELD_FORM, name: p.initial.name, fieldType: 'string' } : FIELD_FORM)}>fake save field</button>
      <button type="button" onClick={p.onCancel}>fake cancel field</button>
    </div>
  ),
}))
vi.mock('./citype/CIFieldEditor', async (orig) => ({
  ...(await orig<typeof import('./citype/CIFieldEditor')>()),
  CIFieldEditor: (p: { open: boolean; initial: FieldForm | null; onSave: (f: FieldForm) => Promise<void>; onClose: () => void }) => p.open ? (
    <div data-testid="base-field-modal" data-initial={p.initial?.name ?? ''}>
      <button type="button" onClick={() => void p.onSave(FIELD_FORM)}>fake save base field</button>
      <button type="button" onClick={p.onClose}>fake close base field</button>
    </div>
  ) : null,
}))
const REL_FORM: RelationForm = { name: 'runsOn', label: 'Runs on', relationshipType: 'RUNS_ON', targetType: 'server', cardinality: 'one', direction: 'outgoing', order: 1 }
vi.mock('./citype/CIRelationEditor', async (orig) => ({
  ...(await orig<typeof import('./citype/CIRelationEditor')>()),
  CIRelationEditor: (p: { open: boolean; onSave: (f: RelationForm) => Promise<void>; onClose: () => void }) => p.open ? (
    <div data-testid="relation-modal">
      <button type="button" onClick={() => void p.onSave(REL_FORM)}>fake save relation</button>
      <button type="button" onClick={p.onClose}>fake close relation</button>
    </div>
  ) : null,
}))
const createOutcome: { error?: unknown } = {}
vi.mock('./citype/CreateTypeDialog', () => ({
  CreateTypeDialog: (p: { open: boolean; onSave: (f: { name: string; label: string; icon: string; color: string }) => Promise<void>; onClose: () => void }) => p.open ? (
    <div data-testid="create-dialog">
      <button type="button" onClick={() => {
        p.onSave({ name: 'firewall', label: 'Firewall', icon: 'shield', color: '#000' })
          .then(() => { createOutcome.error = null }, (e: unknown) => { createOutcome.error = e })
      }}>fake create</button>
      <button type="button" onClick={p.onClose}>fake close create</button>
    </div>
  ) : null,
}))
vi.mock('./shared/FieldRulesPanel', () => ({
  FieldRulesPanel: (p: { entityType: string; fields: { name: string }[] }) => (
    <div data-testid="rules-panel">{p.entityType}:{p.fields.map((f) => f.name).join(',')}</div>
  ),
}))
vi.mock('@/components/CIDynamicForm', () => ({
  CIDynamicForm: (p: { onSubmit: () => Promise<void>; onCancel: () => void }) => (
    <div data-testid="preview-form">
      <button type="button" onClick={() => void p.onSubmit()}>fake preview submit</button>
      <button type="button" onClick={p.onCancel}>fake preview cancel</button>
    </div>
  ),
}))

const field = (over: Record<string, unknown>) => ({
  id: 'f-1', name: 'port', label: 'Port', fieldType: 'number', required: false, enumValues: [], order: 1,
  enumTypeName: null, isSystem: false, validationScript: null, visibilityScript: null, defaultScript: null,
  ...over,
})

const ciType = (over: Record<string, unknown>) => ({
  id: 't-own', name: 'load_balancer', label: 'Load Balancer', icon: 'box', color: '#0284c7',
  active: true, scope: 'tenant', tenantId: 'c-two', labels: [],
  validationScript: null, chainFamilies: ['Infrastructure'], serviceRole: null,
  fields: [], relations: [], systemRelations: [],
  ...over,
})

const BASE = ciType({
  id: 'base', name: '__base__', label: '__base__', scope: 'base', tenantId: 'system',
  fields: [field({ id: 'b-2', name: 'owner', label: 'Owner', order: 2, isSystem: true }), field({ id: 'b-1', name: 'name', label: 'Name', order: 1, isSystem: true })],
})

function setTypes(types: unknown[], languages: string[] = []) {
  apolloFinto.risposte['GetCITypes'] = { ciTypes: types }
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: BASE }
  apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [] }
  apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { available: languages } }
}

async function open(label: string) {
  const r = renderWithProviders(<CITypeDesignerPage />)
  await r.user.click(await screen.findByText(label))
  return r
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.info).mockClear()
  createOutcome.error = undefined
})

describe('with no type selected', () => {
  it('asks the administrator to pick one', () => {
    setTypes([ciType({})])
    renderWithProviders(<CITypeDesignerPage />)
    expect(screen.getByText('Pick a type to edit it')).toBeInTheDocument()
  })
})

describe('settings tab: what "Save settings" sends', () => {
  it('drops empty per-language labels, sends an empty role as null and the chain families as ticked', async () => {
    setTypes([ciType({ labels: [{ language: 'it', label: 'Bilanciatore' }], serviceRole: 'component', validationScript: 'x' })], ['it', 'en'])
    const r = await open('Load Balancer')

    // The Italian label comes from the type; English is left empty on purpose.
    expect(screen.getByLabelText('Label in Italiano')).toHaveValue('Bilanciatore')
    await r.user.clear(screen.getByLabelText('Label'))
    await r.user.type(screen.getByLabelText('Label'), 'LB')
    await r.user.type(screen.getByLabelText('Label in English'), '   ')
    await r.user.selectOptions(screen.getByLabelText('Icon'), 'server')
    // Tick, untick and tick again: both directions of each checkbox are exercised.
    await r.user.click(screen.getByRole('checkbox', { name: 'Application' }))
    await r.user.click(screen.getByRole('checkbox', { name: 'Application' }))
    await r.user.click(screen.getByRole('checkbox', { name: 'Application' }))
    await r.user.click(screen.getByRole('checkbox', { name: 'Infrastructure' }))
    fireEvent.change(document.querySelector('input[type="color"]')!, { target: { value: '#112233' } })
    await r.user.selectOptions(screen.getByRole('combobox', { name: /Role in a service map/ }), '')
    await r.user.clear(screen.getByRole('textbox', { name: /Example: a validation/ }))
    await r.user.click(screen.getByRole('button', { name: 'Save settings' }))

    await waitFor(() => expect(apolloFinto.chiamata('UpdateCIType')).toBeDefined())
    expect(apolloFinto.chiamata('UpdateCIType')).toEqual({
      id: 't-own',
      input: {
        label: 'LB',
        // Only the language with text: an empty one would overwrite the fallback.
        labels: [{ language: 'it', label: 'Bilanciatore' }],
        icon: 'server',
        color: '#112233',
        validationScript: null,
        chainFamilies: ['Application'],
        serviceRole: null,
        // Every status offered: none excluded (G35).
        statusesExcluded: [],
      },
    })
    expect(toast.success).toHaveBeenCalledWith('Saved')
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // The button comes back once the save is over.
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })

  it('the active badge toggles the type', async () => {
    setTypes([ciType({ active: false })])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('button', { name: '○ Inactive' }))
    expect(apolloFinto.chiamata('UpdateCIType')).toEqual({ id: 't-own', input: { active: true } })
  })

  it('a failed save shows the error and gives the button back', async () => {
    setTypes([ciType({})])
    apolloFinto.esiti['UpdateCIType'] = { error: new Error('scope mismatch') }
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })
})

describe('fields tab', () => {
  const typed = () => ciType({
    fields: [
      field({ id: 'f-sys', name: 'status', label: 'Status', isSystem: true, order: 0 }),
      field({ id: 'f-2', name: 'vip', label: 'VIP', order: 2 }),
      field({ id: 'f-1', name: 'port', label: 'Port', order: 1 }),
    ],
  })

  it('lists inherited fields apart, and a NEW field is added with its full definition', async () => {
    setTypes([typed()])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    expect(screen.getByText(/BASE FIELD \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('SPECIFIC FIELDS (2)')).toBeInTheDocument()

    await r.user.click(screen.getByRole('button', { name: /Add a field/ }))
    // A-12: the names already taken include the ones inherited from __base__.
    expect(screen.getByTestId('inline-editor').dataset['taken']).toBe('status,vip,port,owner,name')
    await r.user.click(screen.getByRole('button', { name: 'fake save field' }))

    await waitFor(() => expect(apolloFinto.chiamata('AddCIField')).toBeDefined())
    expect(apolloFinto.chiamata('AddCIField')).toEqual({
      typeId: 't-own',
      input: {
        name: 'costCenter', label: 'Cost center', fieldType: 'enum', required: true,
        // Empty strings become null; the dictionary goes only with an enum.
        defaultValue: null, enumTypeId: 'enum-1', order: 3,
        validationScript: null, visibilityScript: 'return true', defaultScript: null,
      },
    })
    expect(toast.success).toHaveBeenCalledWith('Field added')
    await waitFor(() => expect(screen.queryByTestId('inline-editor')).not.toBeInTheDocument())
  })

  it.each([
    ['adding', 'AddCIField', 0],
    ['editing', 'UpdateCIField', 1],
  ] as const)('a refused save while %s keeps the editor open and shows the error', async (_label, op, editIndex) => {
    setTypes([typed()])
    apolloFinto.esiti[op] = { error: new Error('refused by the API') }
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    if (editIndex === 0) await r.user.click(screen.getByRole('button', { name: /Add a field/ }))
    else await r.user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    await r.user.click(screen.getByRole('button', { name: 'fake save field' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    // The administrator's input is not thrown away on a refusal.
    expect(screen.getByTestId('inline-editor')).toBeInTheDocument()
  })

  it('a refused field removal shows the error', async () => {
    setTypes([typed()])
    apolloFinto.query.mockResolvedValue({ data: { ciFieldValueCount: 0 } })
    apolloFinto.esiti['RemoveCIField'] = { error: new Error('scope') }
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getByRole('button', { name: 'Delete port' }))
    await r.user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('EDITING a field calls update (never add), without name or type, and drops the dictionary of a non-enum', async () => {
    setTypes([typed()])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    const editButtons = screen.getAllByRole('button', { name: 'Edit' })
    // Sorted by order: "port" (1) comes before "vip" (2).
    await r.user.click(editButtons[0]!)
    expect(screen.getByTestId('inline-editor').dataset['initial']).toBe('port')
    await r.user.click(screen.getByRole('button', { name: 'fake save field' }))

    await waitFor(() => expect(apolloFinto.chiamata('UpdateCIField')).toBeDefined())
    expect(apolloFinto.chiamata('AddCIField')).toBeUndefined()
    expect(apolloFinto.chiamata('UpdateCIField')).toEqual({
      typeId: 't-own', fieldId: 'f-1',
      input: {
        label: 'Cost center', required: true, defaultValue: null, enumTypeId: null, order: 3,
        validationScript: null, visibilityScript: 'return true', defaultScript: null,
      },
    })
    expect(toast.success).toHaveBeenCalledWith('Field saved.')
  })

  it('cancelling the inline editors closes them, and an empty type says so', async () => {
    setTypes([ciType({})])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    expect(screen.getByText(/No specific field\. Click/)).toBeInTheDocument()
    await r.user.click(screen.getByRole('button', { name: /Add a field/ }))
    expect(screen.queryByText(/No specific field\. Click/)).not.toBeInTheDocument()
    await r.user.click(screen.getByRole('button', { name: 'fake cancel field' }))
    expect(screen.queryByTestId('inline-editor')).not.toBeInTheDocument()
  })

  it('cancelling the edit of an existing field brings the row back', async () => {
    setTypes([typed()])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    await r.user.click(screen.getByRole('button', { name: 'fake cancel field' }))
    expect(screen.queryByTestId('inline-editor')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2)
  })

  it('deleting a field with no values: the confirmation says so, and the field is removed', async () => {
    setTypes([typed()])
    apolloFinto.query.mockResolvedValue({ data: { ciFieldValueCount: 0 } })
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getByRole('button', { name: 'Delete port' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('No CI has a value in this field.')
    await r.user.click(within(dialog).getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(apolloFinto.chiamata('RemoveCIField')).toEqual({ typeId: 't-own', fieldId: 'f-1' }))
    expect(toast.success).toHaveBeenCalledWith('Field removed')
  })

  it('declining the confirmation removes nothing', async () => {
    setTypes([typed()])
    apolloFinto.query.mockResolvedValue({ data: { ciFieldValueCount: 2 } })
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getByRole('button', { name: 'Delete port' }))
    const dialog = await screen.findByRole('dialog')
    await r.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('RemoveCIField')).toBeUndefined()
  })

  it.each([
    ['the count query fails', () => apolloFinto.query.mockRejectedValue(new Error('neo4j down'))],
    ['the count query returns no data', () => apolloFinto.query.mockResolvedValue({ data: null })],
  ])('when %s, nothing is deleted and the reason is shown', async (_label, arrange) => {
    setTypes([typed()])
    arrange()
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getByRole('button', { name: 'Delete port' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Could not count the CIs that use this field')))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('RemoveCIField')).toBeUndefined()
  })
})

describe('base fields (__base__)', () => {
  it('lists the base fields in order, adds a new one through ADD', async () => {
    setTypes([ciType({})])
    const r = renderWithProviders(<CITypeDesignerPage />)
    await r.user.click(screen.getByRole('button', { name: /Base fields/ }))
    expect(screen.getByText('2 fields — cannot be deleted')).toBeInTheDocument()

    await r.user.click(screen.getByRole('button', { name: /Add a base field/ }))
    expect(screen.getByTestId('base-field-modal').dataset['initial']).toBe('')
    await r.user.click(screen.getByRole('button', { name: 'fake save base field' }))
    await waitFor(() => expect(apolloFinto.chiamata('AddCIField')).toMatchObject({ typeId: 'base', input: { name: 'costCenter' } }))
    expect(toast.success).toHaveBeenCalledWith('Base field added')
    await waitFor(() => expect(screen.queryByTestId('base-field-modal')).not.toBeInTheDocument())
  })

  it('G-4: editing a base field opens it pre-filled and saves through UPDATE with its id', async () => {
    setTypes([ciType({})])
    const r = renderWithProviders(<CITypeDesignerPage />)
    await r.user.click(screen.getByRole('button', { name: /Base fields/ }))
    await r.user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    expect(screen.getByTestId('base-field-modal').dataset['initial']).toBe('name')
    await r.user.click(screen.getByRole('button', { name: 'fake save base field' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateCIField')).toMatchObject({ typeId: 'base', fieldId: 'b-1' }))
    expect(apolloFinto.chiamata('AddCIField')).toBeUndefined()
    expect(toast.success).toHaveBeenCalledWith('Field saved.')

    await r.user.click(screen.getByRole('button', { name: 'fake close base field' }))
    expect(screen.queryByTestId('base-field-modal')).not.toBeInTheDocument()
  })

  it.each([
    ['adding', 'AddCIField', 'Add a base field'],
    ['editing', 'UpdateCIField', 'Edit'],
  ] as const)('a refused base field while %s keeps the dialog open', async (_label, op, button) => {
    setTypes([ciType({})])
    apolloFinto.esiti[op] = { error: new Error('refused') }
    const r = renderWithProviders(<CITypeDesignerPage />)
    await r.user.click(screen.getByRole('button', { name: /Base fields/ }))
    await r.user.click(screen.getAllByRole('button', { name: new RegExp(button) })[0]!)
    await r.user.click(screen.getByRole('button', { name: 'fake save base field' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByTestId('base-field-modal')).toBeInTheDocument()
  })

  it('without a base type loaded, a save goes nowhere', async () => {
    setTypes([ciType({})])
    apolloFinto.risposte['GetBaseCIType'] = undefined
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getByRole('button', { name: /Add a field/ }))
    // The type-specific path still works: the base is only needed for __base__.
    await r.user.click(screen.getByRole('button', { name: 'fake save field' }))
    await waitFor(() => expect(apolloFinto.chiamata('AddCIField')).toMatchObject({ typeId: 't-own' }))
    // And the base entry shows nothing to edit when there is no base type.
    await r.user.click(screen.getByRole('button', { name: /Base fields/ }))
    expect(screen.getByText('Pick a type to edit it')).toBeInTheDocument()
  })
})

describe('relations tab', () => {
  it('adds a relation with the form fields and removes one after confirmation', async () => {
    setTypes([ciType({ relations: [{ id: 'r-1', name: 'hosts', label: 'Hosts', relationshipType: 'HOSTS', targetType: 'server', cardinality: 'many', direction: 'outgoing', order: 0 }] })])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'CI relationships' }))
    await r.user.click(screen.getByRole('button', { name: /Add a relationship/ }))
    await r.user.click(screen.getByRole('button', { name: 'fake save relation' }))
    await waitFor(() => expect(apolloFinto.chiamata('AddCIRelation')).toEqual({
      typeId: 't-own',
      input: { name: 'runsOn', label: 'Runs on', relationshipType: 'RUNS_ON', targetType: 'server', cardinality: 'one', direction: 'outgoing', order: 1 },
    }))
    expect(toast.success).toHaveBeenCalledWith('Relation added')
    await waitFor(() => expect(screen.queryByTestId('relation-modal')).not.toBeInTheDocument())

    await r.user.click(screen.getByRole('button', { name: 'Delete relationship hosts' }))
    const dialog = await screen.findByRole('dialog')
    await r.user.click(within(dialog).getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(apolloFinto.chiamata('RemoveCIRelation')).toEqual({ typeId: 't-own', relationId: 'r-1' }))
    expect(toast.success).toHaveBeenCalledWith('Relation removed')
  })

  it('a refused relation keeps the dialog open; a refused removal shows the error', async () => {
    setTypes([ciType({ relations: [{ id: 'r-1', name: 'hosts', label: 'Hosts', relationshipType: 'HOSTS', targetType: 'server', cardinality: 'many', direction: 'outgoing', order: 0 }] })])
    apolloFinto.esiti['AddCIRelation'] = { error: new Error('bad target') }
    apolloFinto.esiti['RemoveCIRelation'] = { error: new Error('scope') }
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'CI relationships' }))
    await r.user.click(screen.getByRole('button', { name: /Add a relationship/ }))
    await r.user.click(screen.getByRole('button', { name: 'fake save relation' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('relation-modal')).toBeInTheDocument()
    await r.user.click(screen.getByRole('button', { name: 'fake close relation' }))

    await r.user.click(screen.getByRole('button', { name: 'Delete relationship hosts' }))
    await r.user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('closing the relation dialog adds nothing', async () => {
    setTypes([ciType({})])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'CI relationships' }))
    await r.user.click(screen.getByRole('button', { name: /Add a relationship/ }))
    await r.user.click(screen.getByRole('button', { name: 'fake close relation' }))
    expect(screen.queryByTestId('relation-modal')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('AddCIRelation')).toBeUndefined()
  })
})

describe('rules and preview tabs', () => {
  it('the rules panel gets the type name and its fields', async () => {
    setTypes([ciType({ fields: [field({})] })])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Rules' }))
    expect(screen.getByTestId('rules-panel')).toHaveTextContent('load_balancer:port')
  })

  it('a type without fields has nothing to preview', async () => {
    setTypes([ciType({})])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByText(/No specific field\. Add fields/)).toBeInTheDocument()
  })

  it('the preview never saves, and its cancel goes to the fields tab', async () => {
    setTypes([ciType({ fields: [field({})] })])
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('tab', { name: 'Preview' }))
    await r.user.click(screen.getByRole('button', { name: 'fake preview submit' }))
    expect(toast.info).toHaveBeenCalledWith('Preview — nothing saved')
    expect(Object.keys(apolloFinto.chiamate).filter((n) => /^(Add|Update|Create|Remove)/.test(n))).toEqual([])
    await r.user.click(screen.getByRole('button', { name: 'fake preview cancel' }))
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('creating a type', () => {
  it('a successful creation resolves, so the dialog can close', async () => {
    setTypes([])
    apolloFinto.esiti['CreateCIType'] = { data: { createCIType: { id: 't-new' } } }
    const r = renderWithProviders(<CITypeDesignerPage />)
    await r.user.click(screen.getByRole('button', { name: /New/ }))
    await r.user.click(screen.getByRole('button', { name: 'fake create' }))
    await waitFor(() => expect(createOutcome.error).toBeNull())
    expect(apolloFinto.chiamata('CreateCIType')).toEqual({ input: { name: 'firewall', label: 'Firewall', icon: 'shield', color: '#000' } })
    expect(toast.success).toHaveBeenCalledWith('Type created')
    await r.user.click(screen.getByRole('button', { name: 'fake close create' }))
    expect(screen.queryByTestId('create-dialog')).not.toBeInTheDocument()
  })

  it('a failed creation REJECTS, so the dialog stays open instead of pretending the type exists', async () => {
    setTypes([])
    apolloFinto.esiti['CreateCIType'] = { error: new Error('name taken') }
    const r = renderWithProviders(<CITypeDesignerPage />)
    await r.user.click(screen.getByRole('button', { name: /New/ }))
    await r.user.click(screen.getByRole('button', { name: 'fake create' }))
    // Apollo 4 rejects with the server's own error, after onError has shown it.
    await waitFor(() => expect(createOutcome.error).toBeInstanceOf(Error))
    expect(String(createOutcome.error)).toContain('name taken')
  })
})

describe('deleting a type', () => {
  const ZERO = { cis: 0, ticketCIs: 0, tickets: 0, ticketCIExclusions: 0, groupsUpdated: 0, groupsDeleted: 0, fieldVisibilityRules: 0, fieldRequirementRules: 0, businessRules: 0, autoTriggers: 0, customWidgets: 0, reportSections: 0, assessmentQuestionLinks: 0, blockingServiceMaps: [] as string[] }

  it('after confirmation the type is deleted and the editor empties', async () => {
    setTypes([ciType({})])
    apolloFinto.query.mockResolvedValue({ data: { ciTypeDeletionImpact: ZERO } })
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    const dialog = await screen.findByRole('dialog')
    await r.user.click(within(dialog).getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteCIType')).toEqual({ id: 't-own' }))
    expect(toast.success).toHaveBeenCalledWith('Type deleted')
    expect(await screen.findByText('Pick a type to edit it')).toBeInTheDocument()
  })

  it('a refused deletion keeps the type selected', async () => {
    setTypes([ciType({})])
    apolloFinto.query.mockResolvedValue({ data: { ciTypeDeletionImpact: ZERO } })
    apolloFinto.esiti['DeleteCIType'] = { error: new Error('in use') }
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    await r.user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeInTheDocument()
  })

  it('declining the confirmation deletes nothing', async () => {
    setTypes([ciType({})])
    apolloFinto.query.mockResolvedValue({ data: { ciTypeDeletionImpact: ZERO } })
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    const dialog = await screen.findByRole('dialog')
    await r.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('DeleteCIType')).toBeUndefined()
  })

  it.each([
    ['the impact query fails', () => apolloFinto.query.mockRejectedValue(new Error('timeout'))],
    ['the impact query returns no data', () => apolloFinto.query.mockResolvedValue({ data: undefined })],
  ])('when %s, no confirmation is offered and nothing is deleted', async (_label, arrange) => {
    setTypes([ciType({})])
    arrange()
    const r = await open('Load Balancer')
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Could not compute what the deletion would remove')))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('DeleteCIType')).toBeUndefined()
  })
})

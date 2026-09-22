/**
 * THE ITIL TYPE DESIGNER'S STATE — what it sends, and what it refuses to send.
 *
 * Two refusals happen in the browser because the server would reject the
 * same thing with a less useful message: an enum field with no vocabulary,
 * and a step rule ("visible in these steps") with no step chosen. And the
 * delete asks FIRST how many tickets carry a value for that field (U-28):
 * the values go with the field, so the confirmation has to say how many.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const m = vi.hoisted(() => ({
  types: [] as unknown[],
  refetch: vi.fn(),
  mutations: {} as Record<string, { fn: ReturnType<typeof vi.fn>; opts: { onCompleted?: () => void; onError?: (e: Error) => void } }>,
  query: vi.fn(),
  confirm: vi.fn(async () => true),
  toastError: vi.fn(), toastSuccess: vi.fn(), showError: vi.fn(),
}))

/** The OPERATION's name: the fragment comes first in these documents. */
type Doc = { definitions: Array<{ kind: string; name?: { value: string } }> }
const opName = (doc: Doc) => doc.definitions.find((d) => d.kind === 'OperationDefinition')?.name?.value ?? ''

vi.mock('@apollo/client/react', () => ({
  useQuery: (doc: Doc) => {
    const name = opName(doc)
    if (/ITIL/i.test(name) && /Type/i.test(name) && !/Count/.test(name)) return { data: { itilTypes: m.types }, loading: false, refetch: m.refetch }
    return { data: undefined, loading: false, refetch: vi.fn() }
  },
  useMutation: (doc: Doc, opts: { onCompleted?: () => void; onError?: (e: Error) => void }) => {
    const name = opName(doc)
    // One spy per mutation for the whole test: a re-render must not swap it
    // for a fresh one and lose the call.
    const fn = m.mutations[name]?.fn ?? vi.fn(async () => ({ data: {} }))
    m.mutations[name] = { fn, opts }
    return [fn]
  },
  useApolloClient: () => ({ query: m.query }),
}))
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => m.confirm }))
vi.mock('sonner', () => ({ toast: { error: m.toastError, success: m.toastSuccess } }))
vi.mock('@/lib/showError', () => ({ showError: m.showError, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))

const { useITILTypeDesigner, emptyForm, fieldToForm } = await import('./useITILTypeDesigner')

const tipo = (over: Record<string, unknown> = {}) => ({
  id: 'it-inc', name: 'incident', label: 'Incident', icon: 'alert', color: 'red', active: true, validationScript: null, fields: [], ...over,
})
const mutazione = (fragment: string) => Object.entries(m.mutations).find(([n]) => n.toLowerCase().includes(fragment.toLowerCase()))![1]

beforeEach(() => {
  m.types = [tipo(), tipo({ id: 'it-prb', name: 'problem', label: 'Problem', icon: null, color: null, validationScript: 'return 1' })]
  m.mutations = {}
  for (const f of [m.refetch, m.query, m.toastError, m.toastSuccess, m.showError]) f.mockReset()
  m.confirm.mockReset(); m.confirm.mockResolvedValue(true)
})

describe('emptyForm / fieldToForm', () => {
  it('a new field starts as an optional string, always visible, editable where visible', () => {
    expect(emptyForm(4)).toMatchObject({ fieldType: 'string', required: false, order: 4, visibilityMode: 'always', editabilityMode: 'visible' })
  })

  it('an existing field becomes a form, with nulls as empty strings', () => {
    const f = fieldToForm({
      id: 'f1', name: 'cc', label: 'CC', fieldType: 'enum', required: true, enumValues: [], order: 2, isSystem: false,
      enumTypeId: 'et-1', enumTypeName: 'x', validationScript: null, visibilityScript: null, defaultScript: 'return 1',
      visibleToEndUser: true, stepVisibility: { mode: 'steps', steps: ['new'] }, stepEditability: { mode: 'steps', steps: ['new'] },
    })
    expect(f).toMatchObject({ enumTypeId: 'et-1', validationScript: '', defaultScript: 'return 1', visibleToEndUser: true,
      visibilityMode: 'steps', visibilitySteps: ['new'], editabilityMode: 'steps', editabilitySteps: ['new'] })
  })

  it('a "from step" rule keeps the step, and steps only count in "steps" mode', () => {
    const f = fieldToForm({
      id: 'f1', name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false,
      enumTypeId: null, enumTypeName: null, validationScript: null, visibilityScript: null, defaultScript: null,
      stepVisibility: { mode: 'from', steps: ['ignored'], step: 'resolved' },
    })
    expect(f).toMatchObject({ visibilityMode: 'from', visibilityFrom: 'resolved', visibilitySteps: [], editabilityMode: 'visible', visibleToEndUser: false })
  })
})

describe('useITILTypeDesigner', () => {
  it('selects the first type on load and fills its settings, with defaults for what is missing', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    expect(result.current.selectedType?.id).toBe('it-inc')
    act(() => { result.current.handleSelectType(m.types[1] as never) })
    expect(result.current.settingsForm).toEqual({ label: 'Problem', icon: '', color: 'var(--color-trigger-manual)', validationScript: 'return 1' })
    expect(result.current.activeTab).toBe('settings')
  })

  it('saving the settings sends blanks as null', async () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.setSettingsForm({ label: 'Incident', icon: '', color: '', validationScript: '' }) })
    await act(async () => { await result.current.handleSaveSettings() })
    expect(mutazione('UpdateITILType').fn).toHaveBeenCalledWith({ variables: { id: 'it-inc', input: { label: 'Incident', icon: null, color: null, validationScript: null } } })
  })

  it('an enum field with no vocabulary is refused before anything is sent', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.handleSaveField('it-inc', null, { ...emptyForm(1), name: 'x', fieldType: 'enum' }) })
    expect(m.toastError).toHaveBeenCalled()
    expect(mutazione('CreateITILField').fn).not.toHaveBeenCalled()
  })

  it.each([
    [{ visibilityMode: 'steps', visibilitySteps: [] }],
    [{ visibilityMode: 'from', visibilityFrom: '' }],
    [{ editabilityMode: 'steps', editabilitySteps: [] }],
  ])('a step rule with no step is refused: %j', (over) => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.handleSaveField('it-inc', null, { ...emptyForm(1), name: 'x', ...over }) })
    expect(m.toastError).toHaveBeenCalled()
    expect(mutazione('CreateITILField').fn).not.toHaveBeenCalled()
  })

  it('a new customer field is CREATED, with its step rules', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.handleSaveField('it-inc', null, { ...emptyForm(1), name: 'cc', label: 'CC', visibilityMode: 'steps', visibilitySteps: ['new'], editabilityMode: 'steps', editabilitySteps: ['new'] }) })
    const input = (mutazione('CreateITILField').fn.mock.calls[0]![0] as { variables: { input: Record<string, unknown> } }).variables.input
    expect(input).toMatchObject({ name: 'cc', enumTypeId: null, validationScript: null,
      stepVisibility: { mode: 'steps', steps: ['new'] }, stepEditability: { mode: 'steps', steps: ['new'] } })
  })

  it('"from step" and "always" become their own shapes', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.handleSaveField('it-inc', 'f1', { ...emptyForm(1), name: 'cc', fieldType: 'enum', enumTypeId: 'et', visibilityMode: 'from', visibilityFrom: 'resolved' }) })
    const vars = (mutazione('UpdateITILField').fn.mock.calls[0]![0] as { variables: { fieldId: string; input: Record<string, unknown> } }).variables
    expect(vars.fieldId).toBe('f1')
    expect(vars.input).toMatchObject({ enumTypeId: 'et', stepVisibility: { mode: 'from', step: 'resolved' }, stepEditability: { mode: 'visible' } })

    act(() => { result.current.handleSaveField('it-inc', 'f2', { ...emptyForm(1), name: 'y' }) })
    expect((mutazione('UpdateITILField').fn.mock.calls[1]![0] as { variables: { input: Record<string, unknown> } }).variables.input)
      .toMatchObject({ stepVisibility: { mode: 'always' } })
  })

  it('a SYSTEM field carries no step rules: those are for customer fields', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.handleSaveField('it-inc', 'f1', { ...emptyForm(1), name: 'title' }, true) })
    const input = (mutazione('UpdateITILField').fn.mock.calls[0]![0] as { variables: { input: Record<string, unknown> } }).variables.input
    expect(input).not.toHaveProperty('stepVisibility')
    expect(input).not.toHaveProperty('stepEditability')
  })

  it('deleting asks how many tickets hold a value, says it, and deletes only on confirmation', async () => {
    m.query.mockResolvedValue({ data: { itilFieldValueCount: 12 } })
    const { result } = renderHook(() => useITILTypeDesigner())
    await act(async () => { await result.current.handleDeleteField('it-inc', 'f1') })
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(mutazione('DeleteITILField').fn).toHaveBeenCalledWith({ variables: { typeId: 'it-inc', fieldId: 'f1' } })
  })

  it('a field with no values says so, and saying no deletes nothing', async () => {
    m.query.mockResolvedValue({ data: { itilFieldValueCount: 0 } })
    m.confirm.mockResolvedValue(false)
    const { result } = renderHook(() => useITILTypeDesigner())
    await act(async () => { await result.current.handleDeleteField('it-inc', 'f1') })
    expect(mutazione('DeleteITILField').fn).not.toHaveBeenCalled()
  })

  it('if the count cannot be read, nothing is deleted blind', async () => {
    m.query.mockRejectedValueOnce(new Error('down'))
    const { result } = renderHook(() => useITILTypeDesigner())
    await act(async () => { await result.current.handleDeleteField('it-inc', 'f1') })
    expect(m.showError).toHaveBeenCalled()
    expect(m.confirm).not.toHaveBeenCalled()

    m.query.mockResolvedValueOnce({ data: null })
    await act(async () => { await result.current.handleDeleteField('it-inc', 'f1') })
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it('the mutations close their panel and reload on success, and show the error on failure', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.setAddingField(true); result.current.setEditingFieldId('f1') })
    act(() => {
      for (const n of ['UpdateITILType', 'CreateITILField', 'UpdateITILField', 'DeleteITILField']) mutazione(n).opts.onCompleted?.()
    })
    expect(result.current.addingField).toBe(false)
    expect(result.current.editingFieldId).toBeNull()
    expect(m.refetch).toHaveBeenCalledTimes(4)
    act(() => {
      for (const n of ['UpdateITILType', 'CreateITILField', 'UpdateITILField', 'DeleteITILField']) mutazione(n).opts.onError?.(new Error('x'))
    })
    expect(m.showError).toHaveBeenCalledTimes(4)
  })

  it('changing tab closes whatever was being edited', () => {
    const { result } = renderHook(() => useITILTypeDesigner())
    act(() => { result.current.setAddingField(true); result.current.setEditingFieldId('f1') })
    act(() => { result.current.handleTabChange('fields') })
    expect(result.current).toMatchObject({ activeTab: 'fields', addingField: false, editingFieldId: null })
  })

  it('with no types there is nothing selected and saving does nothing', async () => {
    m.types = []
    const { result } = renderHook(() => useITILTypeDesigner())
    expect(result.current.selectedType).toBeNull()
    await act(async () => { await result.current.handleSaveSettings() })
    expect(mutazione('UpdateITILType').fn).not.toHaveBeenCalled()
  })
})

/**
 * THE ITIL TYPE DESIGNER: where an administrator shapes incidents, problems,
 * changes and requests — their name, icon, colour, validation script, custom
 * fields, excluded CI types, field rules — and previews the form.
 *
 * The panels have their own tests; this one drives the page as an
 * administrator does and pins what the page itself owns: which type is open
 * (the first one, and then the one chosen, always on its settings), that
 * every tab edits THAT type, and what reaches the server when its settings
 * are saved or one of its fields is deleted — where the page first says how
 * many tickets will lose a value (U-28).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ITILField, ITILType } from './useITILTypeDesigner'

/** The types list can be made to be still loading: the fake Apollo answers at once otherwise. */
const loadingTypes = vi.hoisted(() => ({ on: false }))
vi.mock('@apollo/client/react', async () => {
  const base = (await import('@/test/apolloFinto')).moduloApollo()
  return {
    ...base,
    useQuery: (doc: Parameters<typeof base.useQuery>[0], opts?: Parameters<typeof base.useQuery>[1]) => {
      const result = base.useQuery(doc, opts)
      return loadingTypes.on ? { ...result, data: undefined, loading: true } : result
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ITILTypeDesignerPage } = await import('./ITILTypeDesignerPage')

const field = (over: Partial<ITILField>): ITILField => ({
  id: 'f-x', name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false,
  enumTypeId: null, enumTypeName: null, validationScript: null, visibilityScript: null, defaultScript: null, ...over,
})

const INCIDENT: ITILType = {
  id: 'it-inc', name: 'incident', label: 'Incident', icon: '', color: '', active: true, validationScript: null,
  fields: [
    field({ id: 'f-title', name: 'title', label: 'Title', isSystem: true, order: 1 }),
    field({ id: 'f-vr', name: 'vendor_ref', label: 'Vendor ref', order: 3 }),
    field({ id: 'f-cc', name: 'cost_center', label: 'Cost center', order: 2 }),
  ],
}
const PROBLEM: ITILType = {
  id: 'it-prb', name: 'problem', label: 'Problem', icon: 'shield', color: '#7c3aed', active: true, validationScript: 'return true', fields: [],
}
// A colour never set arrives as null from the API.
const CHANGE: ITILType = { ...PROBLEM, id: 'it-chg', name: 'change', label: 'Change', icon: 'cloud', color: null as unknown as string, validationScript: null }

beforeEach(() => {
  loadingTypes.on = false
  apolloFinto.reset()
  for (const f of Object.values(toast)) f.mockReset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [INCIDENT, PROBLEM, CHANGE] }
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [
    { id: 'ct-srv', name: 'server', label: 'Server' },
    { id: 'ct-db', name: 'database', label: 'Database' },
  ] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'incident', ciTypes: ['server'] }] }
  apolloFinto.risposte['GetTicketWorkflowSteps'] = { ticketWorkflowSteps: [
    { workflow: 'Generic', category: null, steps: [{ name: 'new', label: 'New', labels: [] }, { name: 'resolved', label: 'Resolved', labels: [] }] },
  ] }
  apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
  apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [] }
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
  ] } }
})

const show = () => renderWithProviders(<ITILTypeDesignerPage />)
const typeButton = (label: string) => screen.getByRole('button', { name: new RegExp(`${label}\\s*\\d+ fields?$`) })
const tab = (name: string) => screen.getByRole('button', { name })
/** The card header of the open type: icon, label, technical name, state. */
const header = (name: string) => screen.getByText(name, { selector: 'div' }).parentElement!.parentElement!

describe('ITILTypeDesignerPage — the types', () => {
  it('while the types load, the page says so and draws no editor', () => {
    loadingTypes.on = true
    show()
    expect(screen.getByRole('heading', { name: 'Ticket types' })).toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('ITIL Types')).toBeNull()
  })

  it('lists every type with its number of fields, and opens the first one on its settings', () => {
    show()
    expect(screen.getByText('Configure ITIL entity fields')).toBeInTheDocument()
    expect(typeButton('Incident')).toHaveTextContent('3 fields')
    expect(typeButton('Problem')).toHaveTextContent('0 fields')
    // A type with no icon of its own shows the product's icon for it.
    expect(typeButton('Incident').querySelector('svg.lucide-circle-alert')).not.toBeNull()
    expect(within(typeButton('Problem')).getByRole('img', { name: 'shield' })).toBeInTheDocument()

    expect(header('incident')).toHaveTextContent('Incident')
    expect(header('incident')).toHaveTextContent('● Active')
    expect(screen.getByLabelText('Label')).toHaveValue('Incident')
  })

  it('choosing another type opens it on its settings, with its own values, whatever tab was open', async () => {
    const { user } = show()
    await user.click(tab('Fields'))
    await user.click(typeButton('Problem'))
    expect(screen.getByLabelText('Label')).toHaveValue('Problem')
    expect(screen.getByLabelText('Icon')).toHaveValue('shield')
    expect(screen.getByLabelText('Validation script (optional)')).toHaveValue('return true')
    // The header shows the type's own icon in its own colour.
    expect(within(header('problem')).getByRole('img', { name: 'shield' })).toHaveAttribute('stroke', '#7c3aed')
  })

  it('a type with no colour shows its icon in the brand colour', async () => {
    const { user } = show()
    await user.click(typeButton('Change'))
    expect(within(header('change')).getByRole('img', { name: 'cloud' })).toHaveAttribute('stroke', 'var(--color-brand)')
  })

  it('a type the designer has no icon for is still listed, with the generic icon, and the gap is reported', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ ...INCIDENT, id: 'it-kb', name: 'kb_article', label: 'Knowledge article' }] }
    show()
    expect(typeButton('Knowledge article').querySelector('svg.lucide-settings-2')).not.toBeNull()
    expect(logged).toHaveBeenCalledWith('[ITIL_TYPE_ICONS] unknown value: "kb_article"')
  })
})

describe('ITILTypeDesignerPage — settings', () => {
  it('saving sends the label, icon, colour and script of THAT type, empty ones as null', async () => {
    const { user } = show()
    await user.clear(screen.getByLabelText('Label'))
    await user.type(screen.getByLabelText('Label'), 'Disruption')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(apolloFinto.chiamata('UpdateITILType')).toEqual({ id: 'it-inc', input: { label: 'Disruption', icon: null, color: null, validationScript: null } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Changes saved'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused save says why, and the button can be pressed again', async () => {
    apolloFinto.esiti['UpdateITILType'] = { error: new Error('Label already used') }
    const { user } = show()
    await user.click(typeButton('Problem'))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(apolloFinto.chiamata('UpdateITILType')).toEqual({ id: 'it-prb', input: { label: 'Problem', icon: 'shield', color: '#7c3aed', validationScript: 'return true' } })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Label already used'))
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  })
})

describe('ITILTypeDesignerPage — the other tabs edit the open type', () => {
  it('Fields lists the system fields, then the custom ones in their order', async () => {
    const { user } = show()
    await user.click(tab('Fields'))
    expect(screen.getByText(/^SYSTEM FIELD \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('CUSTOM FIELDS (2)')).toBeInTheDocument()
    expect(screen.getAllByText(/^(Cost center|Vendor ref)$/).map((e) => e.childNodes[0]!.textContent)).toEqual(['Cost center', 'Vendor ref'])
  })

  it('a field added in Fields is created on the open type', async () => {
    const { user } = show()
    await user.click(tab('Fields'))
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    await user.type(screen.getByRole('textbox', { name: 'Field name' }), 'serial')
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Serial')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamata('CreateITILField')).toMatchObject({ typeId: 'it-inc', input: { name: 'serial', label: 'Serial', fieldType: 'string' } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Changes saved'))
    expect(screen.queryByRole('textbox', { name: 'Field name' })).toBeNull()
  })

  it('deleting a custom field says first how many tickets hold a value in it, then deletes it', async () => {
    apolloFinto.query.mockResolvedValue({ data: { itilFieldValueCount: 3 } })
    const { user } = show()
    await user.click(tab('Fields'))
    await user.click(screen.getByRole('button', { name: 'Delete cost_center' }))
    const confirm = within(await screen.findByRole('dialog'))
    expect(apolloFinto.query).toHaveBeenCalledWith(expect.objectContaining({ variables: { typeId: 'it-inc', fieldId: 'f-cc' }, fetchPolicy: 'network-only' }))
    expect(confirm.getByText('Delete this field?')).toBeInTheDocument()
    expect(confirm.getByText('3 tickets have a value in this field: they are deleted with the field (the previous values stay in the Audit Log).')).toBeInTheDocument()
    await user.click(confirm.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteITILField')).toEqual({ typeId: 'it-inc', fieldId: 'f-cc' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Changes saved'))
  })

  it('Excluded CIs offers the tenant\'s CI types, with this type\'s exclusions ticked', async () => {
    const { user } = show()
    await user.click(tab('Excluded CIs'))
    expect(apolloFinto.chiamata('GetTicketCIExclusions')).toEqual({ ticketType: 'incident' })
    expect(screen.getByRole('checkbox', { name: 'Server' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Database' })).not.toBeChecked()
  })

  it('without the tenant\'s CI types there is nothing to exclude', async () => {
    apolloFinto.risposte['GetCITypes'] = undefined
    const { user } = show()
    await user.click(tab('Excluded CIs'))
    expect(screen.getByText('Excluded CI types')).toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('Rules offers every field of the type, for every step of its workflows', async () => {
    const { user } = show()
    await user.click(tab('Rules'))
    expect(apolloFinto.chiamata('GetTicketWorkflowSteps')).toEqual({ entityType: 'incident' })
    expect(screen.getByRole('checkbox', { name: 'Title — All steps' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Cost center — Resolved' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Vendor ref — New' })).toBeInTheDocument()
  })

  it('Preview draws the form of the type, and its Cancel goes to Fields', async () => {
    const { user } = show()
    await user.click(tab('Preview'))
    expect(screen.getByText('Form preview — every field visible.')).toBeInTheDocument()
    expect(await screen.findByLabelText('Cost center')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('CUSTOM FIELDS (2)')).toBeInTheDocument()
  })
})

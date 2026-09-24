/**
 * CIDynamicForm — the form every CI is created with, driven by the metamodel.
 *
 * The fields, their visibility, their defaults and their validation all come
 * from the customer's CI type (scripts run in a sandbox). What breaks for a
 * user if this regresses:
 * - a field of the wrong kind (a number stored as text, a cleared date stored
 *   as '') writes garbage on the CI;
 * - a hidden field shown on a guess, or a default that does not follow the
 *   field it depends on, produces CIs that violate the customer's rules;
 * - a broken script silently skipped lets an invalid CI through — the form
 *   must BLOCK instead (fail-fast, no fallback);
 * - a server-side rejection only in a toast leaves the user staring at a form
 *   that looks fine; the reason must appear in the form itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import type { CITypeDef, CIFieldDef } from '@/contexts/MetamodelContext'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const validator = vi.hoisted(() => ({
  validateCI: vi.fn(),
  isFieldVisible: vi.fn(),
  getFieldDefault: vi.fn(),
}))
vi.mock('@/lib/ciValidator', () => validator)
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({
    labelOf: (vocabulary: string, value: string) =>
      ({ os_family: { linux: 'Linux (GNU)' } } as Record<string, Record<string, string>>)[vocabulary]?.[value] ?? null,
  }),
}))

const { CIDynamicForm } = await import('./CIDynamicForm')

const field = (over: Partial<CIFieldDef>): CIFieldDef => ({
  id: over.name ?? 'f', name: 'f', label: 'F', fieldType: 'string', required: false,
  enumValues: [], order: 1, isSystem: false,
  validationScript: null, visibilityScript: null, defaultScript: null, ...over,
} as CIFieldDef)

const FIELDS: CIFieldDef[] = [
  field({ name: 'cpu', label: 'CPU count', fieldType: 'number', order: 2 }),
  field({ name: 'hostname', label: 'Hostname', fieldType: 'string', order: 1, required: true }),
  field({ name: 'installed', label: 'Installed on', fieldType: 'date', order: 3 }),
  field({ name: 'virtual', label: 'Virtual machine', fieldType: 'boolean', order: 4 }),
  field({ name: 'os', label: 'OS family', fieldType: 'enum', enumValues: ['linux', 'windows'], enumTypeName: 'os_family', order: 5 } as Partial<CIFieldDef>),
  field({ name: 'internal_id', label: 'Internal id', order: 0, isSystem: true }),
  field({ name: 'secret', label: 'Only for databases', order: 6 }),
]

const ciType = (fields: CIFieldDef[] = FIELDS, systemRelations: CITypeDef['systemRelations'] = []): CITypeDef => ({
  id: 'ct-1', name: 'server', label: 'Server', icon: '', color: '', active: true,
  scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null,
  fields, relations: [], systemRelations,
})

const BASE_TYPE = {
  baseCIType: {
    fields: [
      { name: 'status', fieldType: 'enum', enumValues: ['active', 'retired'] },
      { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
    ],
  },
}

// Restores the console spies some tests install.
afterEach(() => { vi.restoreAllMocks() })

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetBaseCIType'] = BASE_TYPE
  validator.validateCI.mockReset().mockResolvedValue({ valid: true, errors: {} })
  // `secret` is hidden by its visibility script; everything else shows.
  validator.isFieldVisible.mockReset().mockImplementation(async (name: string) => name !== 'secret')
  validator.getFieldDefault.mockReset().mockResolvedValue(null)
})

type SubmitFn = (values: Record<string, unknown>) => Promise<void>

function mount(opts: { type?: CITypeDef; initial?: Record<string, unknown>; onSubmit?: ReturnType<typeof vi.fn<SubmitFn>>; loading?: boolean } = {}) {
  const onSubmit = opts.onSubmit ?? vi.fn<SubmitFn>().mockResolvedValue(undefined)
  const onCancel = vi.fn()
  const r = renderWithProviders(
    <CIDynamicForm ciType={opts.type ?? ciType()} initialValues={opts.initial} onSubmit={onSubmit} onCancel={onCancel} loading={opts.loading} />,
  )
  return { ...r, onSubmit, onCancel }
}

describe('CIDynamicForm — fields from the metamodel', () => {
  it('renders visible type fields in metamodel order, never system fields nor fields whose script hides them', async () => {
    mount()
    await screen.findByLabelText(/Hostname/)
    const labels = Array.from(document.querySelectorAll('label')).map((l) => l.textContent)
    const typeLabels = labels.filter((l) => /Hostname|CPU|Installed|Virtual|OS family/.test(l ?? ''))
    expect(typeLabels).toEqual(['Hostname*', 'CPU count', 'Installed on', 'Virtual machine', 'OS family'])
    expect(screen.queryByText('Internal id')).not.toBeInTheDocument()
    expect(screen.queryByText('Only for databases')).not.toBeInTheDocument()
  })

  it('each field kind writes a value of its own type, and clearing writes null (not an empty string)', async () => {
    const { user, onSubmit } = mount()
    await user.type(screen.getByLabelText('Name*'), 'srv-01')
    await user.type(await screen.findByLabelText(/Hostname/), 'h1')
    await user.type(screen.getByLabelText('CPU count'), '8')
    fireEvent.change(screen.getByLabelText('Installed on'), { target: { value: '2026-01-02' } })
    await user.click(screen.getByLabelText('Virtual machine'))
    // The enum shows the Dictionary label, and stores the internal value.
    await user.selectOptions(screen.getByLabelText('OS family'), 'Linux (GNU)')
    await user.selectOptions(screen.getByLabelText('Status'), 'active')
    await user.selectOptions(screen.getByLabelText('Environment'), 'production')
    await user.type(screen.getByLabelText('Description'), 'rack 4')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      name: 'srv-01', hostname: 'h1', cpu: 8, installed: '2026-01-02', virtual: true, os: 'linux',
      status: 'active', environment: 'production', description: 'rack 4',
    })
  })

  it('clearing a number, a date, a text and an enum stores null', async () => {
    const { user, onSubmit } = mount({ initial: { name: 'n', hostname: 'h', cpu: 4, installed: '2026-01-01', os: 'windows' } })
    await user.clear(await screen.findByLabelText('CPU count'))
    fireEvent.change(screen.getByLabelText('Installed on'), { target: { value: '' } })
    await user.clear(screen.getByLabelText(/Hostname/))
    await user.selectOptions(screen.getByLabelText('OS family'), '')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ cpu: null, installed: null, hostname: null, os: null })
  })

  it('an enum value without a Dictionary label shows its own value', async () => {
    mount()
    expect(await screen.findByRole('option', { name: 'windows' })).toBeInTheDocument()
  })

  it('the border follows focus, and an invalid field stays red after leaving it', async () => {
    validator.validateCI.mockResolvedValue({ valid: false, errors: { cpu: 'Too many' } })
    const { user } = mount({ initial: { name: 'n' } })
    const cpu = await screen.findByLabelText('CPU count')
    fireEvent.focus(cpu)
    expect(cpu.style.borderColor).toBe('var(--color-brand)')
    fireEvent.blur(cpu)
    expect(cpu.style.borderColor).not.toBe('var(--color-trigger-sla-breach)')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Too many')
    fireEvent.focus(cpu)
    fireEvent.blur(cpu)
    expect(cpu.style.borderColor).toBe('var(--color-trigger-sla-breach)')
  })
})

describe('CIDynamicForm — submit', () => {
  it('without a name nothing is sent and the name field says why', async () => {
    const { user, onSubmit } = mount()
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Name is required')).toBeInTheDocument()
    expect(screen.getByLabelText('Name*')).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(validator.validateCI).not.toHaveBeenCalled()
    // Typing clears the error: the user is not scolded for a problem already fixed.
    await user.type(screen.getByLabelText('Name*'), 'x')
    expect(screen.queryByText('Name is required')).not.toBeInTheDocument()
  })

  it('validation errors from the type scripts appear on their fields and at the top, and block the submit', async () => {
    validator.validateCI.mockResolvedValue({ valid: false, errors: { hostname: 'Hostname must be FQDN' }, globalError: 'CPU and RAM disagree' })
    const { user, onSubmit } = mount({ initial: { name: 'srv' } })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Hostname must be FQDN')).toBeInTheDocument()
    expect(screen.getByText('CPU and RAM disagree')).toBeInTheDocument()
    expect(screen.getByLabelText(/Hostname/)).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText(/Hostname/), 'a')
    expect(screen.queryByText('Hostname must be FQDN')).not.toBeInTheDocument()
  })

  it('a broken validation script blocks the form instead of letting the CI through', async () => {
    validator.validateCI.mockRejectedValue(new Error('wasm trap'))
    const { user, onSubmit } = mount({ initial: { name: 'srv' } })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('wasm trap')).toBeInTheDocument()
    expect(screen.getByText('Scripting sandbox error:')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a non-Error thrown by the validator is still shown', async () => {
    validator.validateCI.mockRejectedValue('sandbox offline')
    const { user } = mount({ initial: { name: 'srv' } })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('sandbox offline')).toBeInTheDocument()
  })

  it('a server rejection is shown inside the form, and the form is usable again', async () => {
    const onSubmit = vi.fn<SubmitFn>().mockRejectedValue(new Error('Name already taken'))
    const { user } = mount({ initial: { name: 'srv' }, onSubmit })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Name already taken')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('a non-Error server rejection is shown too', async () => {
    const onSubmit = vi.fn<SubmitFn>().mockRejectedValue('503')
    const { user } = mount({ initial: { name: 'srv' }, onSubmit })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('503')).toBeInTheDocument()
  })

  it('while saving the button says so and both buttons are disabled (no double create)', async () => {
    let finish!: () => void
    const onSubmit = vi.fn<SubmitFn>(() => new Promise<void>((r) => { finish = r }))
    const { user } = mount({ initial: { name: 'srv' }, onSubmit })
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: 'Saving...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    finish()
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('Cancel hands control back to the caller; an external loading disables both actions', async () => {
    const first = mount()
    await first.user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(first.onCancel).toHaveBeenCalled()
    first.unmount()
    mount({ loading: true })
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})

describe('CIDynamicForm — scripts and metamodel problems', () => {
  it('a default script fills its field (after the debounce), and follows the value it depends on', async () => {
    const withDefault = ciType([field({ name: 'port', label: 'Port', defaultScript: 'x', order: 1 })])
    validator.getFieldDefault.mockImplementation(async (_n: string, values: Record<string, unknown>) =>
      values['description'] === 'postgres' ? '5432' : '3306')
    const { user } = mount({ type: withDefault })
    await waitFor(() => expect(screen.getByLabelText('Port')).toHaveValue('3306'), { timeout: 2000 })
    await user.type(screen.getByLabelText('Description'), 'postgres')
    await waitFor(() => expect(screen.getByLabelText('Port')).toHaveValue('5432'), { timeout: 2000 })
  })

  it('a broken default script blocks the form', async () => {
    const withDefault = ciType([field({ name: 'port', label: 'Port', defaultScript: 'x' })])
    validator.getFieldDefault.mockRejectedValue(new Error('default exploded'))
    mount({ type: withDefault })
    expect(await screen.findByText('default exploded', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('a default script failing with a non-Error is shown as text', async () => {
    const withDefault = ciType([field({ name: 'port', label: 'Port', defaultScript: 'x' })])
    validator.getFieldDefault.mockRejectedValue('bad default')
    mount({ type: withDefault })
    expect(await screen.findByText('bad default', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('a broken visibility script hides nothing on a guess: it blocks the form and says why', async () => {
    validator.isFieldVisible.mockRejectedValue(new Error('visibility crashed'))
    mount()
    expect(await screen.findByText('visibility crashed')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Hostname/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('a visibility script failing with a non-Error is shown as text', async () => {
    validator.isFieldVisible.mockRejectedValue('vis bad')
    mount()
    expect(await screen.findByText('vis bad')).toBeInTheDocument()
  })

  it('when the base type has no status/environment enums, the form says so', async () => {
    apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [] } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mount()
    expect(await screen.findByText('Metamodel:')).toBeInTheDocument()
  })

  it('teams that cannot be loaded are said in the group picker', async () => {
    apolloFinto.erroriQuery['GetTeamChoices'] = new Error('teams down')
    const type = ciType([], [
      { id: 'sr1', name: 'ownerGroup', label: 'Owner Group', relationshipType: 'OWNED_BY', targetEntity: 'Team', required: false, order: 1 },
    ] as CITypeDef['systemRelations'])
    const { user } = mount({ type })
    await user.click(await screen.findByRole('combobox', { name: 'Owner Group' }))
    expect(await screen.findByText(/teams down/)).toBeInTheDocument()
  })

  // D34 on creation (review of 23 Sep 2026): each group offers the teams of its type, as on the CI page.
  it('each group offers the teams of its type: owner teams for the owner, support teams for the support', async () => {
    apolloFinto.risposte['GetTeamChoices'] = { teams: [
      { id: 'team-1', name: 'Network', type: 'support', isChangeManager: false },
      { id: 'team-2', name: 'Apps Owners', type: 'owner', isChangeManager: false },
    ] }
    const type = ciType([], [
      { id: 'sr1', name: 'ownerGroup', label: 'Owner Group', relationshipType: 'OWNED_BY', targetEntity: 'Team', required: false, order: 1 },
      { id: 'sr2', name: 'supportGroup', label: 'Support Group', relationshipType: 'SUPPORTED_BY', targetEntity: 'Team', required: false, order: 2 },
    ] as CITypeDef['systemRelations'])
    const { user } = mount({ type })
    await user.click(await screen.findByRole('combobox', { name: 'Owner Group' }))
    expect(await screen.findByRole('option', { name: 'Apps Owners' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Network' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Support Group' }))
    expect(await screen.findByRole('option', { name: 'Network' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Apps Owners' })).not.toBeInTheDocument()
  })

  it('a required group blocks the save and is named; once chosen it travels as <relation>Id', async () => {
    apolloFinto.risposte['GetTeamChoices'] = { teams: [{ id: 'team-1', name: 'Network', type: 'owner', isChangeManager: false }] }
    const type = ciType([], [
      { id: 'sr2', name: 'supportGroup', label: 'Support Group', relationshipType: 'SUPPORTED_BY', targetEntity: 'Team', required: false, order: 2 },
      { id: 'sr1', name: 'ownerGroup', label: 'Owner Group', relationshipType: 'OWNED_BY', targetEntity: 'Team', required: true, order: 1 },
      // Not a group the create input knows: never offered.
      { id: 'sr3', name: 'managedBy', label: 'Managed by', relationshipType: 'MANAGED_BY', targetEntity: 'Team', required: true, order: 3 },
    ] as CITypeDef['systemRelations'])
    const { user, onSubmit } = mount({ type, initial: { name: 'srv' } })
    expect(screen.queryByLabelText(/Managed by/)).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Owner Group is required')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Owner Group' })).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('combobox', { name: 'Owner Group' }))
    await user.click(await screen.findByRole('option', { name: 'Network' }))
    expect(screen.queryByText('Owner Group is required')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'srv', ownerGroupId: 'team-1' }))
  })

  it('un-choosing a group stores null, not an empty id', async () => {
    apolloFinto.risposte['GetTeamChoices'] = { teams: [{ id: 'team-1', name: 'Network', type: 'support', isChangeManager: false }] }
    const type = ciType([], [
      { id: 'sr2', name: 'supportGroup', label: 'Support Group', relationshipType: 'SUPPORTED_BY', targetEntity: 'Team', required: false, order: 1 },
    ] as CITypeDef['systemRelations'])
    const { user, onSubmit } = mount({ type, initial: { name: 'srv' } })
    const box = await screen.findByRole('combobox', { name: 'Support Group' })
    await user.click(box)
    await user.click(await screen.findByRole('option', { name: 'Network' }))
    await user.click(box)
    await user.click(await screen.findByRole('option', { name: '— select —' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'srv', supportGroupId: null }))
  })

  it('without group relations the teams are not even asked for', async () => {
    mount()
    await screen.findByLabelText(/Hostname/)
    expect(apolloFinto.chiamate['GetTeamChoices']).toBeUndefined()
  })
})

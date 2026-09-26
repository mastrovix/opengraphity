/**
 * BUSINESS RULES: «when a ticket is created/updated/moved, if these conditions
 * hold, do these actions», evaluated in PRIORITY order, optionally stopping
 * at the first match.
 *
 * An administrator relies on this page for three things, each tested here:
 * - the list is the order of evaluation: rules sorted by priority, moved up
 *   and down by sending the new order, switched on and off, deleted only
 *   after confirming;
 * - the editor sends exactly the rule that was built — conditions and actions
 *   as JSON, the logic in the lowercase the API accepts (a draft born with
 *   'AND' made every rule uncreatable), the entity only on creation — and an
 *   entity that does not have the chosen event resets it instead of keeping
 *   a combination that never fires;
 * - a rule stored with corrupt data is NOT opened: an editor opened on
 *   silently emptied conditions would destroy them at the next save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { BusinessRulesPage } from './BusinessRulesPage'

// The fake Apollo answers "loaded"; the queries named here are held in flight.
const inFlight = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  return {
    ...m,
    useQuery: (...args: Parameters<typeof m.useQuery>) => {
      const r = m.useQuery(...args)
      return inFlight.has(nomeOperazione(args[0])) ? { ...r, data: undefined, loading: true } : r
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const field = (name: string, label: string, fieldType: string, enumValues: string[] = []) => ({
  id: `f-${name}`, name, label, fieldType, required: false, enumValues, order: 1, isSystem: true,
  enumTypeId: null, enumTypeName: null, validationScript: null, visibilityScript: null, defaultScript: null,
  visibleToEndUser: true, stepVisibility: null, stepEditability: null,
})
const FIELDS = [field('priority', 'Priority', 'enum', ['p1', 'p2']), field('title', 'Title', 'string')]
const TYPE_LABELS: Record<string, string> = { incident: 'Disruption', change: 'Change', problem: 'Problem', service_request: 'Request' }
const ITIL_TYPES = Object.entries(TYPE_LABELS).map(([name, label]) => ({
  id: `it-${name}`, name, label, icon: 'box', color: '#000000', active: true, validationScript: null, fields: FIELDS,
}))

interface Rule {
  id: string; name: string; description: string | null; entityType: string; eventType: string; conditionLogic: string
  conditions: string; actions: string; priority: number; stopOnMatch: boolean; enabled: boolean
}
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r-1', name: 'Escalate P1', description: 'P1 goes to the network team', entityType: 'incident', eventType: 'on_create',
  conditionLogic: 'and',
  conditions: JSON.stringify([{ field: 'priority', operator: 'equals', value: 'p1' }]),
  actions: JSON.stringify([{ type: 'assign_team', params: { team_id: 't-net' } }]),
  priority: 10, stopOnMatch: true, enabled: true, ...over,
})
const rules = (...rs: Rule[]) => { apolloFinto.risposte['GetBusinessRules'] = { businessRules: rs } }

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: ITIL_TYPES }
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't-net', name: 'Network' }, { id: 't-db', name: 'Databases' }] }
  rules()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

type User = ReturnType<typeof renderWithProviders>['user']

const mount = () => renderWithProviders(<BusinessRulesPage />)
const table = () => screen.getByRole('table', { name: 'Business Rules' })
const rowOf = (name: string) => within(table()).getByText(name).closest('tr')!
/** The rule names in the order of the rows (each row has its switch). */
const rowOrder = () => screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label')!.replace('Toggle ', ''))
const dialog = () => screen.getByRole('dialog')
const inDialog = () => within(dialog())
const sentInput = (op: string) => apolloFinto.chiamata(op)?.['input'] as Record<string, unknown>

async function overwrite(user: User, input: HTMLElement, value: string) {
  await user.type(input, value, { initialSelectionStart: 0, initialSelectionEnd: (input as HTMLInputElement).value.length })
}

async function openNew(user: User) {
  await user.click(screen.getByRole('button', { name: 'New rule' }))
  expect(inDialog().getByRole('heading', { name: 'New rule' })).toBeInTheDocument()
}

async function openEdit(user: User, name = 'Escalate P1') {
  await user.click(within(rowOf(name)).getByRole('button', { name: 'Edit' }))
  expect(inDialog().getByText('Edit the rule')).toBeInTheDocument()
}

// ── The list ─────────────────────────────────────────────────────────────────

describe('the list of rules', () => {
  it('shows the rules in the order they are evaluated, with entity, event, logic, stop and state', () => {
    rules(
      rule({ id: 'r-2', name: 'Tag VPN requests', entityType: 'service_request', eventType: 'on_update', conditionLogic: 'or', priority: 20, stopOnMatch: false, enabled: false }),
      rule(),
    )
    mount()
    expect(screen.getByText('2 rules')).toBeInTheDocument()
    expect(rowOrder()).toEqual(['Escalate P1', 'Tag VPN requests'])
    const first = rowOf('Escalate P1')
    expect(within(first).getByText('10')).toBeInTheDocument()
    // The entity as the customer calls it, the event as a menu word.
    expect(within(first).getByText('Disruption')).toBeInTheDocument()
    expect(within(first).getByText('created')).toBeInTheDocument()
    expect(within(first).getByText('AND')).toBeInTheDocument()
    expect(within(first).getByText('STOP')).toBeInTheDocument()
    expect(within(first).getByRole('switch', { name: 'Toggle Escalate P1' })).toHaveAttribute('aria-checked', 'true')
    const second = rowOf('Tag VPN requests')
    expect(within(second).getByText('Request')).toBeInTheDocument()
    expect(within(second).getByText('updated')).toBeInTheDocument()
    expect(within(second).getByText('OR')).toBeInTheDocument()
    expect(within(second).queryByText('STOP')).toBeNull()
    expect(within(second).getByRole('switch', { name: 'Toggle Tag VPN requests' })).toHaveAttribute('aria-checked', 'false')
  })

  it('with no rule, says so', () => {
    mount()
    expect(screen.getByText('No rule configured')).toBeInTheDocument()
    expect(screen.getByText('0 rules')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Business Rules' })).toBeNull()
  })

  it('while the rules load, the count is a dash and no empty state is claimed', () => {
    inFlight.add('GetBusinessRules')
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('No rule configured')).toBeNull()
    expect(screen.queryByRole('table', { name: 'Business Rules' })).toBeNull()
  })

  it('the switch turns a rule off, or on, and reloads the list', async () => {
    rules(rule(), rule({ id: 'r-2', name: 'Tag VPN requests', priority: 20, enabled: false }))
    const { user } = mount()
    await user.click(screen.getByRole('switch', { name: 'Toggle Escalate P1' }))
    expect(apolloFinto.chiamata('UpdateBusinessRule')).toEqual({ id: 'r-1', input: { enabled: false } })
    await user.click(screen.getByRole('switch', { name: 'Toggle Tag VPN requests' }))
    expect(apolloFinto.chiamata('UpdateBusinessRule')).toEqual({ id: 'r-2', input: { enabled: true } })
    await waitFor(() => expect(apolloFinto.refetch).toHaveBeenCalledTimes(2))
    // Switching is not editing: no dialog opens.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused switch shows the reason', async () => {
    rules(rule())
    apolloFinto.esiti['UpdateBusinessRule'] = { error: new Error('rule is locked') }
    const { user } = mount()
    await user.click(screen.getByRole('switch', { name: 'Toggle Escalate P1' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rule is locked'))
  })

  it('moving a rule sends the whole new order; the first cannot go up, the last cannot go down', async () => {
    rules(
      rule({ id: 'r-3', name: 'Third', priority: 30 }),
      rule(),
      rule({ id: 'r-2', name: 'Second', priority: 20 }),
    )
    const { user } = mount()
    const up = (name: string) => within(rowOf(name)).getByRole('button', { name: 'Move up' })
    const down = (name: string) => within(rowOf(name)).getByRole('button', { name: 'Move down' })
    expect(up('Escalate P1')).toBeDisabled()
    expect(down('Third')).toBeDisabled()
    await user.click(down('Escalate P1'))
    expect(apolloFinto.chiamata('ReorderBusinessRules')).toEqual({ ruleIds: ['r-2', 'r-1', 'r-3'] })
    await user.click(up('Third'))
    expect(apolloFinto.chiamata('ReorderBusinessRules')).toEqual({ ruleIds: ['r-1', 'r-3', 'r-2'] })
    await waitFor(() => expect(apolloFinto.refetch).toHaveBeenCalledTimes(2))
  })

  it('a refused move shows the reason', async () => {
    rules(rule(), rule({ id: 'r-2', name: 'Second', priority: 20 }))
    apolloFinto.esiti['ReorderBusinessRules'] = { error: new Error('stale order') }
    const { user } = mount()
    await user.click(within(rowOf('Second')).getByRole('button', { name: 'Move up' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('stale order'))
  })

  it('a column header asks the server for that order', async () => {
    rules(rule())
    const { user } = mount()
    expect(apolloFinto.chiamata('GetBusinessRules')).toEqual({ sortField: null, sortDirection: 'asc', filters: null })
    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(apolloFinto.chiamata('GetBusinessRules')).toEqual({ sortField: 'name', sortDirection: 'asc', filters: null })
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the table is in server-sort mode, but the page
  // re-sorted every answer by priority, so the rows never followed the column that was clicked.
  it('sorting by name shows the rules in name order', async () => {
    const zeta = rule({ id: 'r-z', name: 'Zeta', priority: 1 })
    const alpha = rule({ id: 'r-a', name: 'Alpha', priority: 2 })
    apolloFinto.risposte['GetBusinessRules'] = (v?: Record<string, unknown>) => ({ businessRules: v?.['sortField'] === 'name' ? [alpha, zeta] : [zeta, alpha] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Name' }))
    expect(rowOrder()).toEqual(['Alpha', 'Zeta'])
  })

  it('an advanced filter is sent to the server', async () => {
    rules(rule())
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    const fieldSelect = screen.getByLabelText('Field of condition 1')
    expect(within(fieldSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select field...', 'Entity type', 'Event type', 'Enabled', 'Logic', 'Name'])
    await user.selectOptions(fieldSelect, 'entityType')
    // The entity types as the customer calls them.
    expect(within(screen.getByLabelText('Value of condition 1')).getByRole('option', { name: 'Problem' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Value of condition 1'), 'problem')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const filters = JSON.parse(String(apolloFinto.chiamata('GetBusinessRules')?.['filters'])) as { rules: unknown[] }
    expect(filters.rules).toEqual([expect.objectContaining({ field: 'entityType', operator: 'equals', value: 'problem' })])
  })

  it('delete asks first; confirming deletes and reloads', async () => {
    rules(rule())
    const { user } = mount()
    await user.click(within(rowOf('Escalate P1')).getByRole('button', { name: 'Delete' }))
    expect(inDialog().getByText('Delete this rule?')).toBeInTheDocument()
    expect(inDialog().getByText('Escalate P1')).toBeInTheDocument()
    await user.click(inDialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteBusinessRule')).toEqual({ id: 'r-1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rule deleted'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('declining the confirmation deletes nothing', async () => {
    rules(rule())
    const { user } = mount()
    await user.click(within(rowOf('Escalate P1')).getByRole('button', { name: 'Delete' }))
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamate['DeleteBusinessRule']).toBeUndefined()
  })

  it('a refused delete shows the reason', async () => {
    rules(rule())
    apolloFinto.esiti['DeleteBusinessRule'] = { error: new Error('rule in use') }
    const { user } = mount()
    await user.click(within(rowOf('Escalate P1')).getByRole('button', { name: 'Delete' }))
    await user.click(inDialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rule in use'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

// ── The editor ───────────────────────────────────────────────────────────────

describe('creating a rule', () => {
  it('starts as an incident rule on creation, AND, one empty condition, one «Set field» action, enabled', async () => {
    const { user } = mount()
    await openNew(user)
    expect(inDialog().getByLabelText('Name *')).toHaveValue('')
    expect(inDialog().getByLabelText('Priority')).toHaveValue(10)
    expect(inDialog().getByLabelText('Entity type')).toHaveValue('incident')
    expect(inDialog().getByLabelText('Event')).toHaveValue('on_create')
    expect(inDialog().getByRole('button', { name: 'AND' })).toHaveAttribute('aria-pressed', 'true')
    expect(inDialog().getByRole('button', { name: 'OR' })).toHaveAttribute('aria-pressed', 'false')
    expect(inDialog().getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    expect(inDialog().getByDisplayValue('Set field')).toBeInTheDocument()
    expect(inDialog().getByRole('checkbox', { name: 'Stop at the first match' })).not.toBeChecked()
    expect(inDialog().getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
    expect(inDialog().getByText(/When a ticket of type Disruption is created/)).toBeInTheDocument()
  })

  it('refuses a rule without a name', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name *'), '   ')
    await user.click(inDialog().getByRole('button', { name: 'New rule' }))
    expect(toast.error).toHaveBeenCalledWith('Name is required')
    expect(apolloFinto.chiamate['CreateBusinessRule']).toBeUndefined()
  })

  it('sends the whole rule, conditions and actions as JSON and the logic in lowercase, then closes and reloads', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name *'), 'Escalate P1 problems')
    await overwrite(user, inDialog().getByLabelText('Priority'), '5')
    await user.type(inDialog().getByLabelText('Description'), 'P1 problems to the network team')
    await user.selectOptions(inDialog().getByLabelText('Entity type'), 'problem')
    await user.selectOptions(inDialog().getByLabelText('Event'), 'on_update')
    await user.click(inDialog().getByRole('button', { name: 'OR' }))
    expect(inDialog().getByRole('button', { name: 'OR' })).toHaveAttribute('aria-pressed', 'true')
    // The action first, so that the only «-- Field --» left is the one of the condition.
    await user.selectOptions(inDialog().getByDisplayValue('Set field'), 'assign_team')
    await user.selectOptions(inDialog().getByDisplayValue('-- Pick a team --'), 't-net')
    await user.selectOptions(inDialog().getByDisplayValue('-- Field --'), 'priority')
    await user.selectOptions(inDialog().getByDisplayValue('-- Value --'), 'p1')
    await user.click(inDialog().getByRole('checkbox', { name: 'Stop at the first match' }))
    await user.click(inDialog().getByRole('checkbox', { name: 'Enabled' }))
    // The preview reads the rule back as a sentence.
    expect(inDialog().getByText('When a ticket of type Problem is updated, IF Priority = "p1", THEN Assign team Network')).toBeInTheDocument()
    await user.click(inDialog().getByRole('button', { name: 'New rule' }))
    const input = sentInput('CreateBusinessRule')
    expect(input).toMatchObject({
      name: 'Escalate P1 problems', description: 'P1 problems to the network team', entityType: 'problem', eventType: 'on_update',
      conditionLogic: 'or', priority: 5, stopOnMatch: true, enabled: false,
    })
    expect(JSON.parse(String(input['conditions']))).toEqual([{ field: 'priority', operator: 'equals', value: 'p1' }])
    expect(JSON.parse(String(input['actions']))).toEqual([{ type: 'assign_team', params: { team_id: 't-net' } }])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rule created'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('conditions and actions are added and removed', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name *'), 'Two of each')
    await user.click(inDialog().getByRole('button', { name: 'Add a condition' }))
    expect(inDialog().getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
    // Writing in the second condition leaves the first as it is; removing the first keeps the second.
    await user.type(inDialog().getAllByPlaceholderText('Value')[1]!, 'vpn')
    expect(inDialog().getAllByPlaceholderText('Value').map((i) => (i as HTMLInputElement).value)).toEqual(['', 'vpn'])
    await user.click(inDialog().getAllByRole('button', { name: 'Remove' })[0]!)
    expect(inDialog().getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    await user.click(inDialog().getByRole('button', { name: 'Add an action' }))
    await user.selectOptions(inDialog().getAllByDisplayValue('Set field')[1]!, 'create_comment')
    await user.type(inDialog().getByLabelText('Comment text...'), 'Escalated by rule')
    await user.click(inDialog().getAllByRole('button', { name: 'Delete' })[0]!)
    await user.click(inDialog().getByRole('button', { name: 'New rule' }))
    const input = sentInput('CreateBusinessRule')
    expect(JSON.parse(String(input['conditions']))).toEqual([{ field: '', operator: 'equals', value: 'vpn' }])
    expect(JSON.parse(String(input['actions']))).toEqual([{ type: 'create_comment', params: { text: 'Escalated by rule' } }])
    // An empty description is sent as nothing, not as ''.
    expect(input['description']).toBeNull()
  })

  it('an entity that does not have the chosen event resets it to creation; one that has it keeps it', async () => {
    const { user } = mount()
    await openNew(user)
    const entity = inDialog().getByLabelText('Entity type')
    const event = inDialog().getByLabelText('Event')
    await user.selectOptions(event, 'on_update')
    // A change moves by steps and has no field update: «updated» would never fire.
    await user.selectOptions(entity, 'change')
    expect(event).toHaveValue('on_create')
    expect(within(event).getAllByRole('option').map((o) => o.textContent)).toEqual(['created', 'status transition'])
    await user.selectOptions(event, 'on_transition')
    await user.selectOptions(entity, 'problem')
    expect(event).toHaveValue('on_transition')
  })

  it('a refused creation shows the reason and keeps the dialog open', async () => {
    apolloFinto.esiti['CreateBusinessRule'] = { error: new Error('Invalid conditionLogic') }
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name *'), 'Broken')
    await user.click(inDialog().getByRole('button', { name: 'New rule' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid conditionLogic'))
    expect(dialog()).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('Cancel closes without saving', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name *'), 'Draft')
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['CreateBusinessRule']).toBeUndefined()
  })
})

describe('editing a rule', () => {
  it('opens the rule as stored, with the entity locked; saving sends it without the entity', async () => {
    rules(rule({ description: null }))
    const { user } = mount()
    await openEdit(user)
    expect(inDialog().getByLabelText('Name *')).toHaveValue('Escalate P1')
    expect(inDialog().getByLabelText('Entity type')).toBeDisabled()
    expect(inDialog().getByLabelText('Description')).toHaveValue('')
    expect(inDialog().getByRole('checkbox', { name: 'Stop at the first match' })).toBeChecked()
    expect(inDialog().getByText('When a ticket of type Disruption is created, IF Priority = "p1", THEN Assign team Network')).toBeInTheDocument()
    await user.clear(inDialog().getByLabelText('Name *'))
    await user.type(inDialog().getByLabelText('Name *'), 'Escalate P1 now')
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    expect(apolloFinto.chiamata('UpdateBusinessRule')).toEqual({ id: 'r-1', input: {
      name: 'Escalate P1 now', description: null, eventType: 'on_create', conditionLogic: 'and',
      conditions: rule().conditions, actions: rule().actions, priority: 10, stopOnMatch: true, enabled: true,
    } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rule updated'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('actions saved in the old flat format open as type + parameters, and are saved that way', async () => {
    rules(rule({ actions: JSON.stringify([{ type: 'set_field', field: 'title', value: 'Checked', note: null }, { value: 3 }]) }))
    const { user } = mount()
    await openEdit(user)
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    expect(JSON.parse(String(sentInput('UpdateBusinessRule')['actions']))).toEqual([
      { type: 'set_field', params: { field: 'title', value: 'Checked' } },
      // No type stored: a «Set field», the default action.
      { type: 'set_field', params: { value: '3' } },
    ])
  })

  it('a rule stored without conditions or actions opens with one empty condition and the default action', async () => {
    rules(rule({ conditions: '', actions: '' }))
    const { user } = mount()
    await openEdit(user)
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    const input = sentInput('UpdateBusinessRule')
    expect(JSON.parse(String(input['conditions']))).toEqual([{ field: '', operator: 'equals', value: '' }])
    expect(JSON.parse(String(input['actions']))).toEqual([{ type: 'set_field', params: {} }])
  })

  it.each([
    { what: 'corrupt conditions', over: { conditions: '{not json' }, reason: /^Cannot open "Escalate P1": .*"conditions".*\. Fix the record in the database before editing\.$/ },
    { what: 'a logic the API does not have', over: { conditionLogic: 'AND' }, reason: /^Cannot open "Escalate P1": unrecognised conditionLogic "AND": expected and, or\. Fix the record/ },
  ])('a rule with $what is not opened, and the toast says which and why', async ({ over, reason }) => {
    rules(rule(over))
    const { user } = mount()
    await user.click(within(rowOf('Escalate P1')).getByRole('button', { name: 'Edit' }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(reason))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the reason put into the English toast was built
  // in Italian — «JSON corrotto in "conditions"» — instead of coming from the translations.
  it('the reason for not opening a corrupt rule is written in the language of the interface', async () => {
    rules(rule({ conditions: '{not json' }))
    const { user } = mount()
    await user.click(within(rowOf('Escalate P1')).getByRole('button', { name: 'Edit' }))
    expect(toast.error).toHaveBeenCalledWith(expect.not.stringMatching(/corrotto/))
  })

  it('a refused update shows the reason and keeps the dialog open', async () => {
    rules(rule())
    apolloFinto.esiti['UpdateBusinessRule'] = { error: new Error('priority taken') }
    const { user } = mount()
    await openEdit(user)
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('priority taken'))
    expect(dialog()).toBeInTheDocument()
  })
})

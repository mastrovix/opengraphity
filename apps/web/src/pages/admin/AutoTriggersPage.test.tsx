/**
 * AUTO TRIGGERS: «when a ticket of this type is created / updated / breaches
 * its SLA / after N minutes, if these conditions hold, do these actions».
 *
 * What an administrator relies on, and what breaks silently if it regresses:
 * - the list says which triggers exist, how often they ran and when last,
 *   and a switch turns one off without opening it;
 * - the editor offers only the events that fire for the chosen ticket type
 *   (AU-1), resets an event the new type does not have, asks the delay only
 *   for a timer and sends it only then, and offers «is changed» only where
 *   there is a change to compare (V-19);
 * - a trigger stored with corrupt JSON is NOT opened: an editor opened on
 *   silently emptied conditions would destroy them at the next save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { AutoTriggersPage } from './AutoTriggersPage'

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

interface Trigger {
  id: string; name: string; entityType: string; eventType: string; timerDelayMinutes: number | null
  conditions: string; actions: string; enabled: boolean; executionCount: number; lastExecutedAt: string | null
}
const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: 'tg-1', name: 'Remind the team', entityType: 'incident', eventType: 'on_timer', timerDelayMinutes: 30,
  conditions: JSON.stringify([{ field: 'priority', operator: 'equals', value: 'p1' }]),
  actions: JSON.stringify([{ type: 'assign_team', params: { team_id: 't-net' } }]),
  enabled: true, executionCount: 12, lastExecutedAt: '2026-09-01T08:30:00Z', ...over,
})
const triggers = (...ts: Trigger[]) => { apolloFinto.risposte['GetAutoTriggers'] = { autoTriggers: ts } }

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: ITIL_TYPES }
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't-net', name: 'Network' }] }
  triggers()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

type User = ReturnType<typeof renderWithProviders>['user']

const mount = () => renderWithProviders(<AutoTriggersPage />)
const rowOf = (name: string) => within(screen.getByRole('table', { name: 'Auto Triggers' })).getByText(name).closest('tr')!
const dialog = () => screen.getByRole('dialog')
const inDialog = () => within(dialog())
const sentInput = (op: string) => apolloFinto.chiamata(op)?.['input'] as Record<string, unknown>
const optionTexts = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)

async function overwrite(user: User, input: HTMLElement, value: string) {
  await user.type(input, value, { initialSelectionStart: 0, initialSelectionEnd: (input as HTMLInputElement).value.length })
}

async function openNew(user: User) {
  await user.click(screen.getByRole('button', { name: 'New trigger' }))
  expect(inDialog().getByText('New trigger', { selector: 'span' })).toBeInTheDocument()
}

async function openEdit(user: User, name = 'Remind the team') {
  await user.click(within(rowOf(name)).getByRole('button', { name: 'Edit' }))
  expect(inDialog().getByText('Edit the trigger')).toBeInTheDocument()
}

// ── The list ─────────────────────────────────────────────────────────────────

describe('the list of triggers', () => {
  it('shows each trigger with its ticket type, event, state, runs and last run', () => {
    triggers(trigger(), trigger({ id: 'tg-2', name: 'Breach alarm', entityType: 'service_request', eventType: 'on_sla_breach', enabled: false, executionCount: 0, lastExecutedAt: null }))
    mount()
    expect(screen.getByText('2 triggers')).toBeInTheDocument()
    const first = rowOf('Remind the team')
    expect(within(first).getByText('Disruption')).toBeInTheDocument()
    expect(within(first).getByText('after a timer')).toBeInTheDocument()
    expect(within(first).getByText('12')).toBeInTheDocument()
    expect(within(first).getByText('01 Sept 2026, 10:30')).toBeInTheDocument()
    expect(within(first).getByRole('switch', { name: 'Toggle Remind the team' })).toHaveAttribute('aria-checked', 'true')
    const second = rowOf('Breach alarm')
    expect(within(second).getByText('Request')).toBeInTheDocument()
    expect(within(second).getByText('SLA breached')).toBeInTheDocument()
    // Never ran: a dash, not an invented date.
    expect(within(second).getByText('—')).toBeInTheDocument()
    expect(within(second).getByRole('switch', { name: 'Toggle Breach alarm' })).toHaveAttribute('aria-checked', 'false')
  })

  it('with no trigger, says so', () => {
    mount()
    expect(screen.getByText('No trigger configured')).toBeInTheDocument()
    expect(screen.getByText('0 triggers')).toBeInTheDocument()
  })

  it('while the triggers load, the count is a dash and no empty state is claimed', () => {
    inFlight.add('GetAutoTriggers')
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('No trigger configured')).toBeNull()
  })

  it('the switch turns a trigger off without opening it, says so and reloads', async () => {
    triggers(trigger())
    const { user } = mount()
    await user.click(screen.getByRole('switch', { name: 'Toggle Remind the team' }))
    expect(apolloFinto.chiamata('UpdateAutoTrigger')).toEqual({ id: 'tg-1', input: { enabled: false } })
    expect(toast.success).toHaveBeenCalledWith('Trigger updated')
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused switch shows the reason', async () => {
    triggers(trigger({ enabled: false }))
    apolloFinto.esiti['UpdateAutoTrigger'] = { error: new Error('trigger is locked') }
    const { user } = mount()
    await user.click(screen.getByRole('switch', { name: 'Toggle Remind the team' }))
    expect(apolloFinto.chiamata('UpdateAutoTrigger')).toEqual({ id: 'tg-1', input: { enabled: true } })
    expect(toast.error).toHaveBeenCalledWith('trigger is locked')
  })

  it('column headers and advanced filters are asked of the server', async () => {
    triggers(trigger())
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Runs' }))
    expect(apolloFinto.chiamata('GetAutoTriggers')).toEqual({ sortField: 'executionCount', sortDirection: 'asc', filters: null })
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByLabelText('Field of condition 1'), 'eventType')
    expect(optionTexts(screen.getByLabelText('Value of condition 1'))).toEqual(['Select', 'Creation', 'Update', 'Timer', 'SLA Breach', 'Field change'])
    await user.selectOptions(screen.getByLabelText('Value of condition 1'), 'on_timer')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const filters = JSON.parse(String(apolloFinto.chiamata('GetAutoTriggers')?.['filters'])) as { rules: unknown[] }
    expect(filters.rules).toEqual([expect.objectContaining({ field: 'eventType', operator: 'equals', value: 'on_timer' })])
  })

  it('delete asks first; confirming deletes, says so and reloads', async () => {
    triggers(trigger())
    const { user } = mount()
    await user.click(within(rowOf('Remind the team')).getByRole('button', { name: 'Delete' }))
    expect(inDialog().getByText('Delete this trigger?')).toBeInTheDocument()
    expect(inDialog().getByText('Remind the team')).toBeInTheDocument()
    await user.click(inDialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteAutoTrigger')).toEqual({ id: 'tg-1' }))
    expect(toast.success).toHaveBeenCalledWith('Trigger deleted')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('declining the confirmation deletes nothing', async () => {
    triggers(trigger())
    const { user } = mount()
    await user.click(within(rowOf('Remind the team')).getByRole('button', { name: 'Delete' }))
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamate['DeleteAutoTrigger']).toBeUndefined()
  })

  it('a refused delete shows the reason', async () => {
    triggers(trigger())
    apolloFinto.esiti['DeleteAutoTrigger'] = { error: new Error('trigger has pending timers') }
    const { user } = mount()
    await user.click(within(rowOf('Remind the team')).getByRole('button', { name: 'Delete' }))
    await user.click(inDialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('trigger has pending timers'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

// ── Creating ─────────────────────────────────────────────────────────────────

describe('creating a trigger', () => {
  it('starts as an enabled incident trigger on creation, with no condition, no action and no delay', async () => {
    const { user } = mount()
    await openNew(user)
    expect(inDialog().getByLabelText('Name')).toHaveValue('')
    expect(inDialog().getByLabelText('Entity type')).toHaveValue('incident')
    expect(inDialog().getByLabelText('Event type')).toHaveValue('on_create')
    expect(optionTexts(inDialog().getByLabelText('Event type'))).toEqual(['created', 'updated', 'after a timer', 'SLA breached', 'field changed'])
    expect(inDialog().queryByLabelText('Timer delay (minutes)')).toBeNull()
    expect(inDialog().queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(inDialog().getByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(inDialog().getByText('When a ticket of type Disruption is created')).toBeInTheDocument()
  })

  it('refuses a trigger without a name', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name'), '  ')
    await user.click(inDialog().getByRole('button', { name: 'New trigger' }))
    expect(toast.error).toHaveBeenCalledWith('Name is required')
    expect(apolloFinto.chiamate['CreateAutoTrigger']).toBeUndefined()
  })

  it('a timer trigger asks the delay and sends it, with conditions and actions as JSON; then closes and reloads', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name'), 'Remind after 15 minutes')
    await user.selectOptions(inDialog().getByLabelText('Event type'), 'on_timer')
    await overwrite(user, inDialog().getByLabelText('Timer delay (minutes)'), '15')
    await user.click(inDialog().getByRole('button', { name: 'Add a condition' }))
    await user.selectOptions(inDialog().getByDisplayValue('-- Field --'), 'priority')
    await user.selectOptions(inDialog().getByDisplayValue('-- Value --'), 'p1')
    await user.click(inDialog().getByRole('button', { name: 'Add an action' }))
    await user.selectOptions(inDialog().getByDisplayValue('Set field'), 'assign_team')
    await user.selectOptions(inDialog().getByDisplayValue('-- Pick a team --'), 't-net')
    await user.click(inDialog().getByRole('switch', { name: 'Enabled' }))
    expect(inDialog().getByText('When a ticket of type Disruption is created, after 15 minutes, IF Priority = "p1", THEN Assign team Network')).toBeInTheDocument()
    await user.click(inDialog().getByRole('button', { name: 'New trigger' }))
    const input = sentInput('CreateAutoTrigger')
    expect(input).toMatchObject({ name: 'Remind after 15 minutes', entityType: 'incident', eventType: 'on_timer', timerDelayMinutes: 15, enabled: false })
    expect(JSON.parse(String(input['conditions']))).toEqual([{ field: 'priority', operator: 'equals', value: 'p1' }])
    expect(JSON.parse(String(input['actions']))).toEqual([{ type: 'assign_team', params: { team_id: 't-net' } }])
    expect(toast.success).toHaveBeenCalledWith('Trigger created')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a delay typed for a timer is not sent once the event is no longer a timer', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name'), 'On update')
    await user.selectOptions(inDialog().getByLabelText('Event type'), 'on_timer')
    await overwrite(user, inDialog().getByLabelText('Timer delay (minutes)'), '45')
    await user.selectOptions(inDialog().getByLabelText('Event type'), 'on_update')
    expect(inDialog().queryByLabelText('Timer delay (minutes)')).toBeNull()
    await user.click(inDialog().getByRole('button', { name: 'New trigger' }))
    expect(sentInput('CreateAutoTrigger')).toMatchObject({ eventType: 'on_update', timerDelayMinutes: null })
  })

  it('«is changed» is offered only for events that compare with the previous value', async () => {
    const { user } = mount()
    await openNew(user)
    await user.click(inDialog().getByRole('button', { name: 'Add a condition' }))
    const operator = () => inDialog().getByDisplayValue('=')
    expect(within(operator()).queryByRole('option', { name: 'is changed' })).toBeNull()
    await user.selectOptions(inDialog().getByLabelText('Event type'), 'on_update')
    expect(within(operator()).getByRole('option', { name: 'is changed' })).toBeInTheDocument()
    await user.selectOptions(inDialog().getByLabelText('Event type'), 'on_field_change')
    expect(within(operator()).getByRole('option', { name: 'is changed' })).toBeInTheDocument()
  })

  it('a ticket type that does not have the chosen event resets it to creation; one that has it keeps it', async () => {
    const { user } = mount()
    await openNew(user)
    const entity = inDialog().getByLabelText('Entity type')
    const event = inDialog().getByLabelText('Event type')
    await user.selectOptions(event, 'on_sla_breach')
    // A change has no SLA to breach.
    await user.selectOptions(entity, 'change')
    expect(event).toHaveValue('on_create')
    expect(optionTexts(event)).toEqual(['created', 'after a timer'])
    await user.selectOptions(entity, 'problem')
    await user.selectOptions(event, 'on_field_change')
    await user.selectOptions(entity, 'service_request')
    expect(event).toHaveValue('on_field_change')
  })

  it('conditions and actions are added, changed one at a time, and removed', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name'), 'Two of each')
    await user.click(inDialog().getByRole('button', { name: 'Add a condition' }))
    await user.click(inDialog().getByRole('button', { name: 'Add a condition' }))
    await user.type(inDialog().getAllByPlaceholderText('Value')[1]!, 'vpn')
    await user.click(inDialog().getAllByRole('button', { name: 'Remove' })[0]!)
    await user.click(inDialog().getByRole('button', { name: 'Add an action' }))
    await user.click(inDialog().getByRole('button', { name: 'Add an action' }))
    await user.selectOptions(inDialog().getAllByDisplayValue('Set field')[1]!, 'create_comment')
    await user.type(inDialog().getByLabelText('Comment text...'), 'Reminder sent')
    await user.click(inDialog().getAllByRole('button', { name: 'Delete' })[0]!)
    await user.click(inDialog().getByRole('button', { name: 'New trigger' }))
    const input = sentInput('CreateAutoTrigger')
    expect(JSON.parse(String(input['conditions']))).toEqual([{ field: '', operator: 'equals', value: 'vpn' }])
    expect(JSON.parse(String(input['actions']))).toEqual([{ type: 'create_comment', params: { text: 'Reminder sent' } }])
  })

  it('a refused creation shows the reason and keeps the dialog open', async () => {
    apolloFinto.esiti['CreateAutoTrigger'] = { error: new Error('timer too short') }
    const { user } = mount()
    await openNew(user)
    await user.type(inDialog().getByLabelText('Name'), 'Too fast')
    await user.click(inDialog().getByRole('button', { name: 'New trigger' }))
    expect(toast.error).toHaveBeenCalledWith('timer too short')
    expect(dialog()).toBeInTheDocument()
  })

  it('Cancel closes without saving', async () => {
    const { user } = mount()
    await openNew(user)
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['CreateAutoTrigger']).toBeUndefined()
  })
})

// ── Editing ──────────────────────────────────────────────────────────────────

describe('editing a trigger', () => {
  it('opens the trigger as stored, with the type locked; saving sends it without the type and closes', async () => {
    triggers(trigger())
    const { user } = mount()
    await openEdit(user)
    expect(inDialog().getByLabelText('Name')).toHaveValue('Remind the team')
    expect(inDialog().getByLabelText('Entity type')).toBeDisabled()
    expect(inDialog().getByLabelText('Timer delay (minutes)')).toHaveValue(30)
    expect(inDialog().getByText('When a ticket of type Disruption is created, after 30 minutes, IF Priority = "p1", THEN Assign team Network')).toBeInTheDocument()
    await user.clear(inDialog().getByLabelText('Name'))
    await user.type(inDialog().getByLabelText('Name'), 'Remind the network team')
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    expect(apolloFinto.chiamata('UpdateAutoTrigger')).toEqual({ id: 'tg-1', input: {
      name: 'Remind the network team', eventType: 'on_timer', timerDelayMinutes: 30,
      conditions: trigger().conditions, actions: trigger().actions, enabled: true,
    } })
    expect(toast.success).toHaveBeenCalledWith('Trigger updated')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a timer trigger stored without a delay opens at 0; one stored without conditions or actions opens with none', async () => {
    triggers(trigger({ timerDelayMinutes: null, conditions: '', actions: '' }))
    const { user } = mount()
    await openEdit(user)
    expect(inDialog().getByLabelText('Timer delay (minutes)')).toHaveValue(0)
    expect(inDialog().queryByRole('button', { name: 'Remove' })).toBeNull()
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    expect(sentInput('UpdateAutoTrigger')).toMatchObject({ timerDelayMinutes: 0, conditions: '[]', actions: '[]' })
  })

  it.each([
    { what: 'conditions', over: { conditions: '[{oops' } },
    { what: 'actions', over: { actions: 'not json' } },
  ])('a trigger with corrupt $what is not opened, and the toast says which and why', async ({ what, over }) => {
    triggers(trigger(over))
    const { user } = mount()
    await user.click(within(rowOf('Remind the team')).getByRole('button', { name: 'Edit' }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(
      new RegExp(`^Cannot open "Remind the team": .*"${what}".*\\. Fix the record in the database before editing\\.$`),
    ))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused update shows the reason and keeps the dialog open', async () => {
    triggers(trigger())
    apolloFinto.esiti['UpdateAutoTrigger'] = { error: new Error('name taken') }
    const { user } = mount()
    await openEdit(user)
    await user.click(inDialog().getByRole('button', { name: 'Save changes' }))
    expect(toast.error).toHaveBeenCalledWith('name taken')
    expect(dialog()).toBeInTheDocument()
  })
})

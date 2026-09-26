/**
 * SLA POLICIES: which tickets get which response and resolution times, on
 * which clock, and what compliance the report measures them against.
 *
 * A wrong policy is silent until a report is read, so these tests pin:
 * - the list, grouped by ticket type, reads each policy back — what it
 *   applies to (with the Dictionary's labels), the times in short units, the
 *   clock (24×7, a named calendar, or a calendar that is gone) and the target;
 * - the scope field is the one the engine compares: the SEVERITY for an
 *   incident, the priority for the others (the drop-down used to read a
 *   field that does not exist, and was empty);
 * - nothing is saved without a name, a choice of how time counts (no
 *   preselected default) and a threshold below the target, and what is sent
 *   is trimmed, with empty choices as nothing;
 * - switching a policy off, and deleting it after confirming, say so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { SLAPoliciesPage } from './SLAPoliciesPage'

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

const enumField = (name: string, enumValues: string[]) => ({
  id: `f-${name}`, name, label: name, fieldType: 'enum', required: false, enumValues, order: 1, isSystem: true,
  enumTypeId: null, enumTypeName: name, validationScript: null, visibilityScript: null, defaultScript: null,
  visibleToEndUser: true, stepVisibility: null, stepEditability: null,
})
const CATEGORY = enumField('category', ['network', 'hardware'])
const ITIL_TYPES = [
  // The incident is scoped by severity: it has no priority field at all.
  { name: 'incident', label: 'Disruption', fields: [enumField('severity', ['critical', 'high', 'low']), CATEGORY] },
  { name: 'problem', label: 'Problem', fields: [enumField('priority', ['p1', 'p2']), CATEGORY] },
  { name: 'service_request', label: 'Request', fields: [enumField('priority', ['p1', 'p2']), CATEGORY] },
  { name: 'change', label: 'Change', fields: [] },
].map((t) => ({ id: `it-${t.name}`, icon: 'box', color: '#000000', active: true, validationScript: null, ...t }))

const LABELS: Record<string, Record<string, string>> = {
  severity: { critical: 'Critical', high: 'High', low: 'Low' },
  priority: { high: 'High', p1: 'P1 - Urgent', p2: 'P2' },
  category: { network: 'Network', hardware: 'Hardware' },
}
const vocabulary: DomainVocabularies = {
  valuesOf: (n) => (LABELS[n] ? Object.keys(LABELS[n]) : null),
  entriesOf: (n) => (LABELS[n] ? Object.entries(LABELS[n]).map(([value, label]) => ({ value, label, labels: [] })) : null),
  labelOf: (n, v) => LABELS[n]?.[v] ?? null,
  colorOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}

interface Policy {
  id: string; name: string; entityType: string; priority: string | null; category: string | null
  teamId: string | null; teamName: string | null; timezone: string | null; responseMinutes: number; resolveMinutes: number
  businessHours: boolean; calendarId: string | null; calendarName: string | null
  complianceTarget: number | null; complianceWarning: number | null; warningMinutes: number; enabled: boolean
}
const policy = (over: Partial<Policy> = {}): Policy => ({
  id: 'sla-1', name: 'P1 problems', entityType: 'problem', priority: 'p1', category: 'network', teamId: 't-net', teamName: 'Network',
  timezone: null, responseMinutes: 15, resolveMinutes: 240, businessHours: false, calendarId: null, calendarName: null,
  complianceTarget: 99.5, complianceWarning: 97, warningMinutes: 30, enabled: true, ...over,
})
const policies = (...ps: Policy[]) => { apolloFinto.risposte['GetSLAPolicies'] = { slaPolicies: ps } }

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: ITIL_TYPES }
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't-net', name: 'Network' }, { id: 't-db', name: 'Databases' }] }
  apolloFinto.risposte['GetServiceCalendars'] = { serviceCalendars: [{ id: 'cal-1', name: 'Office hours' }] }
  policies()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

type User = ReturnType<typeof renderWithProviders>['user']

const mount = () => renderWithProviders(
  <DomainVocabularyContext.Provider value={vocabulary}><SLAPoliciesPage /></DomainVocabularyContext.Provider>,
)
const group = (entity: string) => screen.getByRole('table', { name: `SLA Policies — ${entity}` })
const rowOf = (name: string) => screen.getByText(name).closest('tr')!
const dialog = () => screen.getByRole('dialog')
const inDialog = () => within(dialog())
const field = (label: string | RegExp) => inDialog().getByLabelText(label)
const optionTexts = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)
const preview = () => inDialog().getByText('Preview:').parentElement!

async function overwrite(user: User, input: HTMLElement, value: string) {
  await user.type(input, value, { initialSelectionStart: 0, initialSelectionEnd: (input as HTMLInputElement).value.length })
}

async function openNew(user: User) {
  await user.click(screen.getByRole('button', { name: 'New policy' }))
  expect(inDialog().getByRole('heading', { name: 'New policy' })).toBeInTheDocument()
}

// ── The list ─────────────────────────────────────────────────────────────────

describe('the list of policies', () => {
  it('groups the policies by ticket type, in the order of the types, one table each', () => {
    policies(
      policy({ id: 'a', name: 'VPN requests', entityType: 'service_request' }),
      policy({ id: 'b', name: 'P1 problems' }),
      policy({ id: 'c', name: 'Critical incidents', entityType: 'incident', priority: 'critical' }),
    )
    mount()
    expect(screen.getByText('3 SLA policies')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Disruption', 'Problem', 'Request'])
    expect(within(group('Disruption')).getByText('Critical incidents')).toBeInTheDocument()
    expect(within(group('Problem')).getByText('P1 problems')).toBeInTheDocument()
    expect(within(group('Request')).getByText('VPN requests')).toBeInTheDocument()
  })

  it('each row says what the policy applies to, its times, how time counts and the target', () => {
    policies(
      policy(),
      policy({ id: 'b', name: 'Everything else', priority: null, category: null, teamId: null, teamName: null,
        responseMinutes: 90, resolveMinutes: 1500, businessHours: true, calendarId: 'cal-1', calendarName: 'Office hours', complianceTarget: null }),
      // A calendar that has been deleted: flagged, not hidden.
      policy({ id: 'c', name: 'Orphan clock', priority: 'p9', category: null, teamName: null, responseMinutes: 45, resolveMinutes: 2000, businessHours: true, calendarName: null }),
      policy({ id: 'd', name: 'Two days', priority: null, category: 'hardware', teamName: null, responseMinutes: 1440, resolveMinutes: 2880 }),
    )
    mount()
    const first = rowOf('P1 problems')
    // The labels of the Dictionary, not the stored values.
    expect(within(first).getByText('priority P1 - Urgent, category Network, team Network')).toBeInTheDocument()
    expect(within(first).getByText('15min')).toBeInTheDocument()
    expect(within(first).getByText('4h')).toBeInTheDocument()
    expect(within(first).getByText('24×7')).toBeInTheDocument()
    expect(within(first).getByText('99.5%')).toBeInTheDocument()
    const second = rowOf('Everything else')
    expect(within(second).getByText('All')).toBeInTheDocument()
    expect(within(second).getByText('1h 30min')).toBeInTheDocument()
    expect(within(second).getByText('1d 1h')).toBeInTheDocument()
    expect(within(second).getByText('Office hours')).toBeInTheDocument()
    expect(within(second).getByText('—')).toBeInTheDocument()
    const third = rowOf('Orphan clock')
    // A value no vocabulary knows is shown as stored.
    expect(within(third).getByText('priority p9')).toBeInTheDocument()
    expect(within(third).getByText('45min')).toBeInTheDocument()
    expect(within(third).getByText('1d 9h 20min')).toBeInTheDocument()
    expect(within(third).getByText('No calendar')).toBeInTheDocument()
    const fourth = rowOf('Two days')
    expect(within(fourth).getByText('category Hardware')).toBeInTheDocument()
    expect(within(fourth).getByText('1d')).toBeInTheDocument()
    expect(within(fourth).getByText('2d')).toBeInTheDocument()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: for an incident the policy's scope IS the
  // severity (the form labels the field «Severity»), but the list and the preview called it
  // «priority» — «priority Critical» — as if it were another field.
  it('an incident policy says it applies to a severity, as its form does', () => {
    policies(policy({ name: 'Critical incidents', entityType: 'incident', priority: 'critical', category: null, teamName: null }))
    mount()
    expect(within(rowOf('Critical incidents')).getByText('severity Critical')).toBeInTheDocument()
  })

  it('with no policy, says so and what a policy is for', () => {
    mount()
    expect(screen.getByText('No SLA policy configured')).toBeInTheDocument()
    expect(screen.getByText('Create the first policy to set response and resolution times.')).toBeInTheDocument()
    expect(screen.getByText('0 SLA policies')).toBeInTheDocument()
  })

  it('while the policies load, the count is a dash and no empty state is claimed', () => {
    inFlight.add('GetSLAPolicies')
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('No SLA policy configured')).toBeNull()
  })

  it('the switch disables a policy, or enables it, says which, and reloads', async () => {
    policies(policy(), policy({ id: 'sla-2', name: 'Off policy', enabled: false }))
    const { user } = mount()
    await user.click(screen.getByRole('switch', { name: 'Toggle P1 problems' }))
    expect(apolloFinto.chiamata('UpdateSLAPolicy')).toEqual({ id: 'sla-1', input: { enabled: false } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Policy disabled'))
    await user.click(screen.getByRole('switch', { name: 'Toggle Off policy' }))
    expect(apolloFinto.chiamata('UpdateSLAPolicy')).toEqual({ id: 'sla-2', input: { enabled: true } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Policy enabled'))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(2)
    // The switch is in a clickable row: it must not open the editor as well.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused switch shows the reason', async () => {
    policies(policy())
    apolloFinto.esiti['UpdateSLAPolicy'] = { error: new Error('policy in use') }
    const { user } = mount()
    await user.click(screen.getByRole('switch', { name: 'Toggle P1 problems' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('policy in use'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a column header and an advanced filter are asked of the server; the filter offers each value once', async () => {
    policies(policy())
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Response' }))
    expect(apolloFinto.chiamata('GetSLAPolicies')).toEqual({ sortField: 'responseMinutes', sortDirection: 'asc', filters: null })
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByLabelText('Field of condition 1'), 'priority')
    // Severities and priorities together, «High» (in both vocabularies) once.
    expect(optionTexts(screen.getByLabelText('Value of condition 1'))).toEqual(['Select', 'Critical', 'High', 'Low', 'P1 - Urgent', 'P2'])
    await user.selectOptions(screen.getByLabelText('Field of condition 1'), 'category')
    expect(optionTexts(screen.getByLabelText('Value of condition 1'))).toEqual(['Select', 'Network', 'Hardware'])
    await user.selectOptions(screen.getByLabelText('Value of condition 1'), 'hardware')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const filters = JSON.parse(String(apolloFinto.chiamata('GetSLAPolicies')?.['filters'])) as { rules: unknown[] }
    expect(filters.rules).toEqual([expect.objectContaining({ field: 'category', operator: 'equals', value: 'hardware' })])
  })

  it('without the Dictionary, the scope filters offer no value rather than invented ones', async () => {
    const unread: DomainVocabularies = { ...vocabulary, entriesOf: () => null, labelOf: () => null, valuesOf: () => null }
    const { user } = renderWithProviders(
      <DomainVocabularyContext.Provider value={unread}><SLAPoliciesPage /></DomainVocabularyContext.Provider>,
    )
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByLabelText('Field of condition 1'), 'priority')
    expect(optionTexts(screen.getByLabelText('Value of condition 1'))).toEqual(['Select'])
    await user.selectOptions(screen.getByLabelText('Field of condition 1'), 'category')
    expect(optionTexts(screen.getByLabelText('Value of condition 1'))).toEqual(['Select'])
  })

  it('delete asks first; confirming deletes and says so', async () => {
    policies(policy())
    const { user } = mount()
    await user.click(within(rowOf('P1 problems')).getByRole('button', { name: 'Delete' }))
    expect(inDialog().getByText('Delete this SLA policy?')).toBeInTheDocument()
    await user.click(inDialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteSLAPolicy')).toEqual({ id: 'sla-1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Policy deleted'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('declining the confirmation deletes nothing', async () => {
    policies(policy())
    const { user } = mount()
    await user.click(within(rowOf('P1 problems')).getByRole('button', { name: 'Delete' }))
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamate['DeleteSLAPolicy']).toBeUndefined()
  })

  it('a refused delete shows the reason', async () => {
    policies(policy())
    apolloFinto.esiti['DeleteSLAPolicy'] = { error: new Error('tickets still measured by it') }
    const { user } = mount()
    await user.click(within(rowOf('P1 problems')).getByRole('button', { name: 'Delete' }))
    await user.click(inDialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('tickets still measured by it'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

// ── Creating ─────────────────────────────────────────────────────────────────

describe('creating a policy', () => {
  it('starts on incidents, for everything, with 1h / 8h, and no clock and no compliance chosen', async () => {
    const { user } = mount()
    await openNew(user)
    expect(field('Name *')).toHaveValue('')
    expect(field('Entity type *')).toHaveValue('incident')
    // For an incident the scope is the severity.
    expect(field('Severity')).toHaveValue('')
    expect(optionTexts(field('Severity'))).toEqual(['All', 'Critical', 'High', 'Low'])
    expect(field('Severity')).toHaveAccessibleDescription('Incident severity the policy applies to.')
    expect(optionTexts(field('Category'))).toEqual(['All', 'Network', 'Hardware'])
    expect(optionTexts(field('Team'))).toEqual(['All', 'Network', 'Databases'])
    expect(field('Response time (minutes) *')).toHaveValue(60)
    expect(field('Resolution time (minutes) *')).toHaveValue(480)
    expect(field('Warning before the deadline (minutes)')).toHaveValue(30)
    expect(field('Time counts *')).toHaveValue('')
    expect(field('Compliance target (%) *')).toHaveValue(null)
    expect(field('Attention threshold (%) *')).toHaveValue(null)
    expect(preview()).toHaveTextContent('Preview: Every Disruption — response within 1h, resolution within 8h')
  })

  it('while the teams load, the team field offers only «All»', async () => {
    inFlight.add('GetTeams')
    const { user } = mount()
    await openNew(user)
    expect(optionTexts(field('Team'))).toEqual(['All'])
  })

  it('for the other ticket types the scope is the priority', async () => {
    const { user } = mount()
    await openNew(user)
    await user.selectOptions(field('Entity type *'), 'problem')
    expect(inDialog().queryByLabelText('Severity')).toBeNull()
    expect(optionTexts(field('Priority'))).toEqual(['All', 'P1 - Urgent', 'P2'])
    expect(field('Priority')).toHaveAccessibleDescription('Ticket priority the policy applies to.')
  })

  it('refuses a policy without a name, without a choice of how time counts, or with a threshold not below the target', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(field('Name *'), '   ')
    await user.click(inDialog().getByRole('button', { name: 'Create' }))
    expect(toast.error).toHaveBeenLastCalledWith('Name is required')
    await user.type(field('Name *'), 'Critical incidents')
    await user.click(inDialog().getByRole('button', { name: 'Create' }))
    expect(toast.error).toHaveBeenLastCalledWith('Choose how time counts: 24×7 or a service calendar.')
    await user.selectOptions(field('Time counts *'), '24x7')
    await user.type(field('Compliance target (%) *'), '95')
    await user.type(field('Attention threshold (%) *'), '95')
    await user.click(inDialog().getByRole('button', { name: 'Create' }))
    expect(toast.error).toHaveBeenLastCalledWith('The compliance target must be a percentage up to 100, and the attention threshold a lower one.')
    expect(apolloFinto.chiamate['CreateSLAPolicy']).toBeUndefined()
  })

  it('sends the policy trimmed, with its scope, times, calendar and compliance; then closes', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(field('Name *'), '  P1 problems  ')
    await user.selectOptions(field('Entity type *'), 'problem')
    await user.selectOptions(field('Priority'), 'p1')
    await user.selectOptions(field('Category'), 'network')
    await user.selectOptions(field('Team'), 't-net')
    await overwrite(user, field('Response time (minutes) *'), '30')
    await overwrite(user, field('Resolution time (minutes) *'), '600')
    await overwrite(user, field('Warning before the deadline (minutes)'), '60')
    expect(optionTexts(field('Time counts *'))).toEqual(['— Choose how time counts —', '24×7', 'Calendar: Office hours'])
    await user.selectOptions(field('Time counts *'), 'cal-1')
    await user.type(field('Time zone'), '  Europe/Rome  ')
    await user.type(field('Compliance target (%) *'), '99.5')
    await user.type(field('Attention threshold (%) *'), '97')
    expect(preview()).toHaveTextContent(
      'Preview: Problem with priority P1 - Urgent, category Network, team Network — response within 30min, resolution within 10h (service hours of «Office hours»)',
    )
    await user.click(inDialog().getByRole('button', { name: 'Create' }))
    expect(apolloFinto.chiamata('CreateSLAPolicy')).toEqual({ input: {
      name: 'P1 problems', entityType: 'problem', priority: 'p1', category: 'network', teamId: 't-net',
      responseMinutes: 30, resolveMinutes: 600, calendarId: 'cal-1', timezone: 'Europe/Rome', warningMinutes: 60,
      complianceTarget: 99.5, complianceWarning: 97,
    } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Policy created'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a 24×7 policy for everything sends no scope, no calendar and the organisation time zone', async () => {
    const { user } = mount()
    await openNew(user)
    await user.type(field('Name *'), 'Every incident')
    await user.selectOptions(field('Time counts *'), '24x7')
    await user.type(field('Compliance target (%) *'), '95')
    await user.type(field('Attention threshold (%) *'), '90')
    expect(preview()).toHaveTextContent('Preview: Every Disruption — response within 1h, resolution within 8h (24/7)')
    await user.click(inDialog().getByRole('button', { name: 'Create' }))
    expect(apolloFinto.chiamata('CreateSLAPolicy')).toMatchObject({ input: {
      entityType: 'incident', priority: null, category: null, teamId: null, calendarId: null, timezone: null,
    } })
  })

  it('a refused creation shows the reason and keeps the dialog open', async () => {
    apolloFinto.esiti['CreateSLAPolicy'] = { error: new Error('a policy with the same scope exists') }
    const { user } = mount()
    await openNew(user)
    await user.type(field('Name *'), 'Duplicate')
    await user.selectOptions(field('Time counts *'), '24x7')
    await user.type(field('Compliance target (%) *'), '95')
    await user.type(field('Attention threshold (%) *'), '90')
    await user.click(inDialog().getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('a policy with the same scope exists'))
    expect(dialog()).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('Cancel closes without saving', async () => {
    const { user } = mount()
    await openNew(user)
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['CreateSLAPolicy']).toBeUndefined()
  })
})

// ── Editing ──────────────────────────────────────────────────────────────────

describe('editing a policy', () => {
  it('a click on the row opens it as stored, the type locked; saving sends it without the type', async () => {
    policies(policy({ timezone: 'Europe/Rome', businessHours: true, calendarId: 'cal-1', calendarName: 'Office hours' }))
    const { user } = mount()
    await user.click(within(rowOf('P1 problems')).getByText('15min'))
    expect(inDialog().getByText('Edit the policy')).toBeInTheDocument()
    expect(field('Name *')).toHaveValue('P1 problems')
    expect(field('Entity type *')).toBeDisabled()
    expect(field('Priority')).toHaveValue('p1')
    expect(field('Team')).toHaveValue('t-net')
    expect(field('Time counts *')).toHaveValue('cal-1')
    expect(field('Compliance target (%) *')).toHaveValue(99.5)
    await overwrite(user, field('Response time (minutes) *'), '20')
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateSLAPolicy')).toEqual({ id: 'sla-1', input: {
      name: 'P1 problems', priority: 'p1', category: 'network', teamId: 't-net', responseMinutes: 20, resolveMinutes: 240,
      calendarId: 'cal-1', timezone: 'Europe/Rome', warningMinutes: 30, complianceTarget: 99.5, complianceWarning: 97,
    } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Policy updated'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an old policy on business hours without a calendar, or without compliance, must be completed before saving', async () => {
    policies(policy({ priority: null, category: null, teamId: null, businessHours: true, calendarId: null, complianceTarget: null, complianceWarning: null }))
    const { user } = mount()
    await user.click(within(rowOf('P1 problems')).getByRole('button', { name: 'Edit' }))
    // Not «24×7» in silence: the old default is chosen again, knowingly.
    expect(field('Time counts *')).toHaveValue('')
    expect(field('Priority')).toHaveValue('')
    expect(field('Compliance target (%) *')).toHaveValue(null)
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenLastCalledWith('Choose how time counts: 24×7 or a service calendar.')
    await user.selectOptions(field('Time counts *'), '24x7')
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenLastCalledWith('The compliance target must be a percentage up to 100, and the attention threshold a lower one.')
    expect(apolloFinto.chiamate['UpdateSLAPolicy']).toBeUndefined()
  })

  it('a refused update shows the reason and keeps the dialog open', async () => {
    policies(policy())
    apolloFinto.esiti['UpdateSLAPolicy'] = { error: new Error('calendar not found') }
    const { user } = mount()
    await user.click(within(rowOf('P1 problems')).getByRole('button', { name: 'Edit' }))
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('calendar not found'))
    expect(dialog()).toBeInTheDocument()
  })
})

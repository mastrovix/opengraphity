/**
 * THE PREVIEW OF AN AUTOMATION: the rule read back as one sentence.
 *
 * Under the trigger and business-rule editors the administrator reads what the
 * rule will do — «When a ticket of type Disruption is updated, IF Priority =
 * "Critical" AND …, THEN Assign team Network». It is the check that the rule is
 * the right one before saving it, so the sentence must use the customer's
 * words, not internal ones: the ticket type's label, the fields' labels, the
 * vocabulary label of a value, the name of a team or person instead of an id.
 * Where the rule is still incomplete it says «?» rather than hiding the gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { AutomationPreview } = await import('./AutomationPreview')

type Props = Parameters<typeof AutomationPreview>[0]

const f = (name: string, label: string, fieldType: string, extra: Record<string, unknown> = {}) =>
  ({ name, label, fieldType, enumValues: [], enumTypeName: null, ...extra })

const ITIL_TYPES = [
  { name: 'incident', label: 'Disruption', fields: [
    f('urgency_level', 'Urgency level', 'enum', { enumValues: ['u1', 'u2'], enumTypeName: 'urgency' }),
    f('summary_text', 'Summary text', 'string'),
    f('reviewer', 'Reviewer', 'user'),
  ] },
  { name: 'service_request', label: 'Request', fields: [] },
]

const vocabularies: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name, value) => ({ urgency: { u1: 'Critical' }, env: { prod: 'Production' }, priority: { p1: 'Top' }, severity: { s1: 'Major' } } as Record<string, Record<string, string>>)[name]?.[value] ?? null,
  colorOf: () => null,
  entriesOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: ITIL_TYPES }
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', fields: [f('hostname', 'Host name', 'string')] }] }
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't1', name: 'Network' }] }
  // The people the rule names, by id (review of 23 Sep 2026): never the whole directory.
  apolloFinto.risposte['UsersByIds'] = (v?: Record<string, unknown>) => ({
    usersByIds: [{ id: 'u1', name: 'Ann Bell', email: 'ann@acme.com', active: true }].filter((u) => (v?.['ids'] as string[]).includes(u.id)),
  })
  apolloFinto.risposte['EntityFilterFields'] = { entityFilterFields: [
    { name: 'environments', kind: 'SCALAR', scalarName: 'String', enumValues: ['prod', 'lab'], label: 'Environments', choices: [], formFieldType: 'multi_enum', vocabulary: 'env', rowFilter: false, settableByAutomation: true, multi: true },
  ] }
})

function sentence(props: Partial<Props>) {
  renderWithProviders(
    <DomainVocabularyContext.Provider value={vocabularies}>
      <AutomationPreview entityType="incident" eventType="on_update" conditions={[]} actions={[]} {...props} />
    </DomainVocabularyContext.Provider>,
  )
  expect(screen.getByText('Preview')).toBeInTheDocument()
  return screen.getByText(/^When a ticket/).textContent
}

describe('AutomationPreview — when', () => {
  it('names the ticket type with the customer\'s label and the event as it reads', () => {
    expect(sentence({})).toBe('When a ticket of type Disruption is updated')
  })

  it('a timer adds «after N minutes», singular for one minute', () => {
    expect(sentence({ eventType: 'on_timer', timerMinutes: 1 })).toBe('When a ticket of type Disruption is created, after 1 minute')
  })

  it('a timer of 0 minutes adds nothing', () => {
    expect(sentence({ timerMinutes: 0 })).toBe('When a ticket of type Disruption is updated')
  })

  it('a type the metamodel does not list as a ticket type is shown by its own name', () => {
    expect(sentence({ entityType: 'server', eventType: 'on_create', conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }] }))
      .toBe('When a ticket of type server is created, IF Host name contains "web"')
  })
})

describe('AutomationPreview — conditions', () => {
  it('reads each condition with the field\'s label and the value as the customer names it, joined by AND', () => {
    expect(sentence({ conditions: [
      { field: 'urgency_level', operator: 'equals', value: 'u1' },
      { field: 'assigned_team', operator: 'equals', value: 't1' },
      { field: 'assigned_to', operator: 'not_equals', value: 'u1' },
      { field: 'summary_text', operator: 'is_null', value: '' },
    ] })).toBe('When a ticket of type Disruption is updated, IF Urgency level = "Critical" AND Team = "Network" AND Assigned to ≠ "Ann Bell (ann@acme.com)" AND Summary text is null')
  })

  it('«or» logic joins with OR, whatever its case', () => {
    expect(sentence({ conditionLogic: 'or', conditions: [
      { field: 'summary_text', operator: 'contains', value: 'vpn' },
      { field: 'summary_text', operator: 'is_not_null', value: '' },
    ] })).toBe('When a ticket of type Disruption is updated, IF Summary text contains "vpn" OR Summary text is not null')
  })

  it('what cannot be resolved is shown as it is: an unknown value, an unknown person or team, a field outside the metamodel', () => {
    expect(sentence({ conditions: [
      { field: 'urgency_level', operator: 'equals', value: 'u2' },
      { field: 'reviewer', operator: 'equals', value: 'u-gone' },
      { field: 'assigned_team', operator: 'equals', value: 't-gone' },
      { field: 'legacy_code', operator: 'equals', value: 'X1' },
    ] })).toBe('When a ticket of type Disruption is updated, IF Urgency level = "u2" AND Reviewer = "u-gone" AND Team = "t-gone" AND legacy_code = "X1"')
  })

  it('a condition whose field is not chosen yet reads «?»', () => {
    expect(sentence({ conditions: [{ field: '', operator: 'equals', value: 'x' }] }))
      .toBe('When a ticket of type Disruption is updated, IF ? = "x"')
  })

  it('a multiple choice of a request form reads its choice with the vocabulary label', () => {
    expect(sentence({ entityType: 'service_request', eventType: 'on_create', conditions: [{ field: 'environments', operator: 'contains', value: 'prod' }] }))
      .toBe('When a ticket of type Request is created, IF Environments contains "Production"')
  })
})

describe('AutomationPreview — actions', () => {
  it('reads every kind of action with names instead of ids, and cuts long texts', () => {
    const long = 'The database of the payment service is not answering since 10:00'
    expect(sentence({ actions: [
      { type: 'assign_team', params: { team_id: 't1' } },
      { type: 'assign_user', params: { user_id: 'u1' } },
      { type: 'transition_workflow', params: { to_step: 'in_progress' } },
      { type: 'set_priority', params: { priority: 'high' } },
      { type: 'set_field', params: { field: 'urgency_level', value: 'u1' } },
      { type: 'create_notification', params: { message: long } },
      { type: 'create_comment', params: { text: 'Escalated to the database team after the second failure' } },
      { type: 'set_sla', params: { response_minutes: '30', resolve_minutes: '240' } },
      { type: 'call_webhook', params: { method: 'PUT', url: 'https://hooks.acme.com/very/long/path/to/endpoint' } },
      { type: 'execute_script', params: {} },
    ] })).toBe('When a ticket of type Disruption is updated, THEN '
      + 'Assign team Network, Assign user Ann Bell (ann@acme.com), Workflow transition → in_progress, Set priority → high, '
      + 'Set field Urgency level = "Critical", Create notification: "The database of the payment service is n…", Create comment: "Escalated to the database team after the…", '
      + 'Set SLA response:30min resolution:240min, Call webhook PUT https://hooks.acme.com/very/lo…, Run script')
  })

  it('an action still missing its parameters says «?» where the value goes, instead of nothing', () => {
    expect(sentence({ actions: [
      { type: 'assign_team', params: {} },
      { type: 'assign_user', params: {} },
      { type: 'transition_workflow', params: {} },
      { type: 'set_priority', params: {} },
      { type: 'set_field', params: {} },
      { type: 'create_notification', params: {} },
      { type: 'create_comment', params: {} },
      { type: 'set_sla', params: {} },
      // Saved before it had any parameter: `params` itself is missing.
      { type: 'call_webhook' } as unknown as Props['actions'][number],
    ] })).toBe('When a ticket of type Disruption is updated, THEN '
      + 'Assign team ?, Assign user ?, Workflow transition → ?, Set priority → ?, Set field ? = "", Create notification: "", '
      + 'Create comment: "", Set SLA response:0min resolution:0min, Call webhook POST …')
  })

  it('while teams and people are still loading, their ids are shown as they are', () => {
    apolloFinto.risposte['GetTeams'] = undefined
    apolloFinto.risposte['UsersByIds'] = undefined
    expect(sentence({
      conditions: [{ field: 'assigned_to', operator: 'equals', value: 'u1' }],
      actions: [{ type: 'assign_team', params: { team_id: 't1' } }],
    })).toBe('When a ticket of type Disruption is updated, IF Assigned to = "u1", THEN Assign team t1')
  })

  it('an id that no team or person has any more is shown as the id', () => {
    expect(sentence({ actions: [{ type: 'assign_team', params: { team_id: 't-gone' } }, { type: 'assign_user', params: { user_id: 'u-gone' } }] }))
      .toBe('When a ticket of type Disruption is updated, THEN Assign team t-gone, Assign user u-gone')
  })

  it('conditions and actions together: IF, then THEN', () => {
    expect(sentence({ timerMinutes: 5, conditions: [{ field: 'summary_text', operator: 'is_null', value: '' }], actions: [{ type: 'execute_script', params: {} }] }))
      .toBe('When a ticket of type Disruption is updated, after 5 minutes, IF Summary text is null, THEN Run script')
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: the value a `set_field`
   * action writes (and the priority of `set_priority`) was shown raw —
   * `THEN Set field Urgency level = "u1"` in the same sentence as
   * `IF Urgency level = "Critical"`, the internal value V-19 had removed from
   * the conditions.
   */
  it('a set_field action reads its value with the vocabulary label, as a condition does', () => {
    expect(sentence({ actions: [{ type: 'set_field', params: { field: 'urgency_level', value: 'u1' } }] }))
      .toBe('When a ticket of type Disruption is updated, THEN Set field Urgency level = "Critical"')
  })

  it('a set_priority action reads the priority with its vocabulary label', () => {
    apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption', fields: [
      f('priority', 'Priority', 'enum', { enumValues: ['p1'], enumTypeName: 'priority' }),
    ] }] }
    expect(sentence({ actions: [{ type: 'set_priority', params: { priority: 'p1' } }] }))
      .toBe('When a ticket of type Disruption is updated, THEN Set priority → Top')
  })

  it('on a type without a priority field, set_priority reads a choice of severity, as the editor offers it', () => {
    apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption', fields: [
      f('severity', 'Severity', 'enum', { enumValues: ['s1'], enumTypeName: 'severity' }),
    ] }] }
    expect(sentence({ actions: [{ type: 'set_priority', params: { priority: 's1' } }] }))
      .toBe('When a ticket of type Disruption is updated, THEN Set priority → Major')
  })

  it('an action type outside the vocabulary is shown as such, and reported', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(sentence({ actions: [{ type: 'send_fax', params: {} }] })).toBe('When a ticket of type Disruption is updated, THEN ?send_fax')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('send_fax'))
  })
})

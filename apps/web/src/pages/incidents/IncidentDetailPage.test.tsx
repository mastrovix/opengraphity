/**
 * THE INCIDENT DETAIL: WHERE AN OUTAGE IS WORKED.
 *
 * A service desk agent spends the outage on this page: they move the incident
 * along its workflow, give it to a team and then to a person, declare it a
 * Major Incident, write the root cause, link the CIs and the tickets it is
 * about. Every regression here lands in the middle of an outage, so these
 * tests pin the page's own decisions:
 *
 *  - which workflow moves are refused and why (no team from the first step,
 *    no person after it), what each move sends, and that a refused move never
 *    also says it went through;
 *  - that a move asking for a note cannot be confirmed without one, warns when
 *    correlated alarms are still firing, and keeps the note when it fails;
 *  - the two-step assignment (team, then a member of THAT team), the edit
 *    form (values from the tenant's matrix, derived priority, trimmed text),
 *    the Major Incident confirmation, the knowledge base draft and the PDF;
 *  - what each linked-ticket kind, CI and comment action sends to the API;
 *  - the loading, error and empty states.
 *
 * Children with their own data and tests (OLA, custom fields, CI list,
 * comments, chat, attachments, similar incidents…) are replaced by thin
 * stand-ins that expose the callbacks the page gives them: the page's job is
 * what it does with those callbacks. The header, the timeline, the team
 * picker and the firing-alarms warning are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { renderWithProviders, attendiURL, LocationSpy } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import { ConfirmProvider } from '@/hooks/useConfirm'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { formatDateTime } from '@/lib/datetime'
import type { EventRow } from '@/types/events'
import { IncidentDetailPage } from './IncidentDetailPage'

/*
 * Mutations as Apollo Client 4 runs them (useMutation.js, 4.3.1): a failed one
 * calls its `onError`, THEN rejects — `apolloInFlight` resolves instead. As in
 * Apollo, a promise nobody awaits stays quiet.
 */
vi.mock('@apollo/client/react', async () => {
  const base = (await import('@/test/apolloInFlight')).apolloModuleWithInFlight()
  type Mutate = (options?: unknown) => Promise<{ data?: unknown; errors?: unknown[] } | undefined>
  return {
    ...base,
    useMutation: (...args: Parameters<typeof base.useMutation>) => {
      const [mutate, result] = base.useMutation(...args) as unknown as [Mutate, Record<string, unknown>]
      const likeApollo4: Mutate = (options) => {
        const promise = mutate(options).then((r) => {
          if (r?.errors?.length) throw r.errors[0]
          return r
        })
        promise.catch(() => {})
        return promise
      }
      return [likeApollo4, result] as const
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
const pdf = vi.hoisted(() => ({ download: vi.fn<(path: string, filename: string) => Promise<void>>() }))
vi.mock('@/lib/downloadPdf', () => ({ downloadPdf: (path: string, filename: string) => pdf.download(path, filename) }))
// Polling while the SLA settles has its own test; the fake Apollo has no polling.
vi.mock('@/hooks/useSlaSettling', () => ({ useSlaSettling: () => undefined }))

vi.mock('@/components/ticket/ola/TicketOLACard', () => ({ TicketOLACard: () => null }))
vi.mock('@/components/ticket/TicketTasksSection', () => ({ TicketTasksSection: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/components/InternalChatPanel', () => ({ InternalChatPanel: () => null }))
vi.mock('@/components/SimilarIncidentsPanel', () => ({ SimilarIncidentsPanel: () => null }))
vi.mock('@/components/WatcherBar', () => ({ WatcherBar: () => null }))
vi.mock('@/pages/events/CorrelatedEventsSection', () => ({ MonitoringAlarmsSection: () => null }))
vi.mock('@/pages/incidents/ImpactedServicesSection', () => ({ ImpactedServicesSection: () => null }))
vi.mock('@/components/ticket/customFields/CustomFieldsCard', () => ({
  CustomFieldsCard: ({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) => (
    <button type="button" onClick={onSaved}>{canEdit ? 'custom fields editable' : 'custom fields read-only'}</button>
  ),
}))
vi.mock('@/components/ticket/AffectedCIList', () => ({
  AffectedCIList: ({ affectedCIs, ciResults, excludedTypes, onSearchChange, onAddCI, onRemoveCI }: {
    affectedCIs: Array<{ id: string; name: string }>; ciResults: Array<{ id: string; name: string }>; excludedTypes: readonly string[]
    onSearchChange: (s: string) => void; onAddCI: (id: string) => void; onRemoveCI: (id: string) => void
  }) => (
    <div data-testid="ci-list" data-excluded={excludedTypes.join(',')}>
      <button type="button" onClick={() => onSearchChange('w')}>type w</button>
      <button type="button" onClick={() => onSearchChange('web')}>type web</button>
      {ciResults.map((c) => <button type="button" key={c.id} onClick={() => onAddCI(c.id)}>{`add ${c.name}`}</button>)}
      {affectedCIs.map((c) => <button type="button" key={c.id} onClick={() => onRemoveCI(c.id)}>{`remove ${c.name}`}</button>)}
    </div>
  ),
}))
vi.mock('@/components/UnifiedLinkedTickets', () => ({
  UnifiedLinkedTickets: ({ title, excludeId, types }: {
    title: string; excludeId: string
    types: Array<{ kind: string; label: string; routeBase: string; items: Array<{ number: string }>; onLink: (id: string) => void; onUnlink: (id: string) => void }>
  }) => (
    <section aria-label={title} data-exclude={excludeId}>
      {types.map((ty) => (
        <div key={ty.kind}>
          <span>{`${ty.label} at ${ty.routeBase}: ${ty.items.map((i) => i.number).join(', ') || 'none'}`}</span>
          <button type="button" onClick={() => ty.onLink(`other-${ty.kind}`)}>{`link ${ty.kind}`}</button>
          <button type="button" onClick={() => ty.onUnlink(`old-${ty.kind}`)}>{`unlink ${ty.kind}`}</button>
        </div>
      ))}
    </section>
  ),
}))
vi.mock('@/components/ticket/CommentsSection', () => ({
  CommentsSection: ({ comments, onAdd, onChanged }: {
    comments: unknown[]; onAdd: (text: string, isInternal: boolean) => unknown; onChanged?: () => void
  }) => (
    <div>
      <span>{`${comments.length} comments`}</span>
      <button type="button" onClick={() => { void onAdd('Relay restarted', false) }}>add public comment</button>
      <button type="button" onClick={() => onChanged?.()}>comment edited</button>
    </div>
  ),
}))

// ── The tenant ────────────────────────────────────────────────────────────────

const STEPS = [
  { name: 'new',         label: 'New',         category: 'active',   isInitial: true },
  { name: 'assigned',    label: 'Assigned',    category: 'active' },
  { name: 'in_progress', label: 'In progress', category: 'active' },
  { name: 'pending',     label: 'On hold',     category: 'waiting' },
  { name: 'resolved',    label: 'Resolved',    category: 'resolved' },
  { name: 'closed',      label: 'Closed',      category: 'closed', isTerminal: true },
].map((s, order) => ({
  id: `st-${s.name}`, labels: [], type: 'state', purpose: null, isInitial: false, isTerminal: false, isOpen: true, order, ...s,
}))

const LABELS: Record<string, Record<string, string>> = {
  impact:      { low: 'Low impact', medium: 'Medium impact', high: 'High impact' },
  urgency:     { low: 'Can wait', medium: 'Soon', high: 'Now' },
  priority:    { low: 'Low priority', medium: 'Medium priority', high: 'High priority', critical: 'Critical priority' },
  environment: { production: 'Production' },
  ci_status:   { in_service: 'In service' },
}
const VOCABULARIES: DomainVocabularies = {
  valuesOf: (name) => (LABELS[name] ? Object.keys(LABELS[name]) : null),
  labelOf: (name, value) => LABELS[name]?.[value] ?? null,
  colorOf: () => null, entriesOf: () => null, vocabularyLabelOf: () => null, loading: false, error: null,
}

const MATRIX = {
  kind: 'priority', inputs: ['impact', 'urgency'], output: 'priority',
  inputValues: [['low', 'medium', 'high'], ['low', 'medium', 'high']],
  outputValues: ['low', 'medium', 'high', 'critical'],
  cells: [
    { key: 'low|low', inputs: ['low', 'low'], value: 'low' },
    { key: 'medium|medium', inputs: ['medium', 'medium'], value: 'medium' },
    { key: 'high|medium', inputs: ['high', 'medium'], value: 'high' },
    { key: 'high|high', inputs: ['high', 'high'], value: 'critical' },
  ],
}

const USERS = [
  { id: 'u-olga', name: 'Olga Operator', email: 'olga@example.com', teams: [{ id: 't-mail', name: 'SUP_Mail' }] },
  { id: 'u-marco', name: 'Marco Mailman', email: 'marco@example.com', teams: [{ id: 't-mail', name: 'SUP_Mail' }] },
  { id: 'u-nina', name: 'Nina Network', email: 'nina@example.com', teams: [{ id: 't-net', name: 'SUP_Network' }] },
]

const me = (permissions: string[]) => ({
  id: 'u-me', name: 'Me', email: 'me@example.com', role: 'operator', roleName: null, permissions,
  slackId: null, emailNotifications: true, language: null, teams: [],
})

// ── The incident ──────────────────────────────────────────────────────────────

const HOLD = { toStep: 'pending', label: 'Put on hold', labels: [], requiresInput: false, inputField: null, condition: null }
const START = { toStep: 'in_progress', label: 'Start work', labels: [], requiresInput: false, inputField: null, condition: null }
const NOTE = { toStep: 'assigned', label: 'Send back', labels: [], requiresInput: true, inputField: 'notes', condition: null }
const RESOLVE = {
  toStep: 'resolved', label: 'Resolve', labels: [{ language: 'en', label: 'Resolve now' }, { language: 'it', label: 'Risolvi' }],
  requiresInput: true, inputField: 'rootCause', condition: null,
}

const alarm = (id: string, status: string, title: string): EventRow => ({ id, status, title, ci: null } as unknown as EventRow)

function incident(over: Record<string, unknown> = {}) {
  return {
    id: 'inc-1', number: 'INC00000042', title: 'Mail relay down', description: 'Outbound mail is queued',
    severity: 'high', impact: 'high', urgency: 'medium', priority: 'high', major: false,
    status: 'in_progress', rootCause: null,
    createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T09:00:00Z', resolvedAt: null,
    assignee: { id: 'u-olga', name: 'Olga Operator', email: 'olga@example.com' },
    assignedTeam: { id: 't-mail', name: 'SUP_Mail' },
    affectedCIs: [{ id: 'ci-relay', name: 'mail-relay-01', type: 'server', status: 'in_service', environment: 'production' }],
    linkedIncidents: [{ id: 'inc-7', number: 'INC00000007', title: 'Earlier outage', status: 'closed' }],
    linkedProblems: [], linkedChanges: [],
    impactedApplications: [],
    workflowInstance: { id: 'wi-1', currentStep: 'in_progress', status: 'running' },
    availableTransitions: [HOLD, NOTE, RESOLVE],
    workflowHistory: [
      { id: 'h1', stepName: 'new', enteredAt: '2026-09-20T08:00:00Z', exitedAt: '2026-09-20T08:10:00Z', durationMs: 600_000, triggeredBy: 'u-olga', triggerType: 'manual', notes: null },
      { id: 'h2', stepName: 'in_progress', enteredAt: '2026-09-20T08:10:00Z', exitedAt: null, durationMs: null, triggeredBy: 'u-olga', triggerType: 'manual', notes: 'Looking at the queue' },
    ],
    comments: [{ id: 'c1' }, { id: 'c2' }],
    slaStatus: null,
    correlatedEvents: [], correlatedEventCount: 0, correlatedEventsPurged: 0,
    impactedServices: [],
    customFields: [],
    ...over,
  }
}

const moved = (currentStep: string) => ({ data: { executeWorkflowTransition: { success: true, error: null, instance: { currentStep } } } })
const refused = (over: Record<string, unknown>) => ({ data: { executeWorkflowTransition: { success: false, error: null, instance: null, ...over } } })

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  toast.success.mockReset()
  toast.error.mockReset()
  pdf.download.mockReset().mockResolvedValue(undefined)
  apolloFinto.esiti['ExecuteWorkflowTransition'] = moved('in_progress')
  apolloFinto.risposte['GetIncident'] = { incident: incident() }
  apolloFinto.risposte['GetUsers'] = { users: USERS }
  apolloFinto.risposte['GetMe'] = { me: me(['ticket.work']) }
  apolloFinto.risposte['GetPriorityMatrix'] = { priorityMatrix: MATRIX }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: STEPS, transitions: [] } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [] }
  apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { postIncident: true, kbArticles: true } } }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [
    { name: 'incident', label: 'Disruption' }, { name: 'problem', label: 'Known issue' }, { name: 'change', label: 'Change' },
  ] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'incident', ciTypes: ['network'] }] }
  apolloFinto.risposte['GetTeamChoices'] = { teams: [
    { id: 't-mail', name: 'SUP_Mail', type: 'support', isChangeManager: false },
    { id: 't-net', name: 'SUP_Network', type: 'support', isChangeManager: false },
    { id: 't-own', name: 'OWN_Billing', type: 'owner', isChangeManager: false },
  ] }
})

function mount() {
  return renderWithProviders(
    <DomainVocabularyContext.Provider value={VOCABULARIES}><IncidentDetailPage /></DomainVocabularyContext.Provider>,
    { route: '/incidents/inc-1', path: '/incidents/:id' },
  )
}

function show(over: Record<string, unknown>) {
  apolloFinto.risposte['GetIncident'] = { incident: incident(over) }
  return mount()
}

/** Runs `body` while collecting the promise rejections nobody handled. */
async function collectingUnhandledRejections(body: (seen: unknown[]) => Promise<void>): Promise<void> {
  const seen: unknown[] = []
  const listener = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await body(seen)
  } finally {
    process.off('unhandledRejection', listener)
  }
}

const dialog = (name: string | RegExp) => screen.getByRole('dialog', { name })
/** The value shown under a label of the details card (a label is a `div` with an id, its value the row below it). */
const field = (label: string) => screen.getByText(label, { selector: 'div[id]' }).parentElement!.nextElementSibling as HTMLElement

// ── Loading, error, not found ────────────────────────────────────────────────

describe('IncidentDetailPage: when there is no incident to show yet', () => {
  it('the first load shows placeholders, not a "not found"', () => {
    inFlight.add('GetIncident')
    const { container } = mount()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(screen.queryByText('Incident not found.')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('a failed load shows the error with a retry', async () => {
    apolloFinto.erroriQuery['GetIncident'] = new Error('incident service down')
    const { user } = mount()
    expect(screen.getByText('incident service down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('an incident that does not exist says so and leads back to the list', async () => {
    apolloFinto.risposte['GetIncident'] = { incident: null }
    const { user } = mount()
    expect(apolloFinto.chiamata('GetIncident')).toEqual({ id: 'inc-1' })
    expect(screen.getByText(/Incident not found\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to list' }))
    await attendiURL('/incidents')
  })
})

// ── What the page says ────────────────────────────────────────────────────────

describe('IncidentDetailPage: the details', () => {
  it('shows number, title, description and the tenant\'s labels, not the raw values', () => {
    mount()
    expect(screen.getByRole('heading', { level: 1, name: 'INC00000042' })).toBeInTheDocument()
    expect(screen.getByText('Mail relay down')).toBeInTheDocument()
    expect(screen.getByText('Outbound mail is queued')).toBeInTheDocument()
    // The priority code comes from the tenant's scale (4 values, high is P2), the label from the vocabulary.
    expect(within(field('Priority')).getByText('P2')).toBeInTheDocument()
    expect(within(field('Priority')).getByText('High priority')).toBeInTheDocument()
    // Impact and urgency read with their OWN vocabularies.
    expect(field('Impact / Urgency')).toHaveTextContent('High impact / Soon')
    expect(field('SLA')).toHaveTextContent('No SLA')
    // The step LABEL, as the timeline says it.
    expect(field('Workflow step')).toHaveTextContent('In progress')
    expect(field('Assigned to')).toHaveTextContent('Olga Operatorolga@example.com')
    expect(field('Opened')).toHaveTextContent(formatDateTime('2026-09-20T08:00:00Z'))
    expect(screen.queryByText('Root cause')).not.toBeInTheDocument()
    expect(screen.queryByText('Resolved', { selector: 'div[id]' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('what is missing is said, not left blank', () => {
    show({
      description: null, impact: null, urgency: null, assignee: null, workflowInstance: null, priority: 'unknown',
      // Lists the API did not send are empty lists, not a crash.
      linkedIncidents: undefined, linkedProblems: undefined, linkedChanges: undefined, customFields: undefined,
    })
    expect(screen.getByText('No description.')).toBeInTheDocument()
    expect(screen.queryByText('Impact / Urgency')).not.toBeInTheDocument()
    expect(field('Assigned to')).toHaveTextContent('Not assigned')
    // It said «N/D», in Italian, on every page (fixed on 23 Sep 2026).
    expect(field('Workflow step')).toHaveTextContent('No workflow')
    // A priority outside the tenant's scale has no code.
    expect(within(field('Priority')).getByText('P?')).toBeInTheDocument()
    expect(screen.getByText('Disruption at /incidents: none')).toBeInTheDocument()
    expect(screen.getByText('Known issue at /problems: none')).toBeInTheDocument()
    expect(screen.getByText('Change at /changes: none')).toBeInTheDocument()
  })

  // Found in the tour of 23 Sep 2026, fixed: the page added its own fallback
  // behind `labelFor`, which never ran (`labelFor` always answers). The name of
  // a step the workflow does not declare is `labelFor`'s alone.
  it('a step the workflow does not declare is still named', () => {
    show({ status: 'waiting_vendor', workflowInstance: { id: 'wi-1', currentStep: 'waiting_vendor', status: 'running' } })
    expect(field('Workflow step')).toHaveTextContent(/^waiting.vendor$/i)
  })

  it('a value the Dictionary has no label for is shown as it is', async () => {
    apolloFinto.risposte['GetPriorityMatrix'] = { priorityMatrix: {
      ...MATRIX,
      inputValues: [['low', 'extreme'], ['low', 'whenever']], outputValues: ['low', 'p0'],
      cells: [{ key: 'low|low', inputs: ['low', 'low'], value: 'low' }, { key: 'extreme|whenever', inputs: ['extreme', 'whenever'], value: 'p0' }],
    } }
    const { user } = show({ impact: 'extreme', urgency: 'whenever', priority: 'p0' })
    expect(field('Impact / Urgency')).toHaveTextContent('extreme / whenever')
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const d = dialog('Edit the incident')
    expect(within(within(d).getByLabelText('Impact')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Low impact', 'extreme'])
    expect(within(within(d).getByLabelText('Urgency')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Can wait', 'whenever'])
    expect(within(d).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('P1 — p0')
  })

  it('a resolved incident shows when, and why', () => {
    show({ status: 'resolved', resolvedAt: '2026-09-20T11:30:00Z', rootCause: 'Disk full on the relay' })
    expect(field('Root cause')).toHaveTextContent('Disk full on the relay')
    expect(field('Resolved')).toHaveTextContent(formatDateTime('2026-09-20T11:30:00Z'))
  })

  it('a Major Incident is announced at the top', () => {
    show({ major: true })
    expect(screen.getByRole('alert')).toHaveTextContent('MAJOR INCIDENT')
  })

  it('an SLA shows its state instead of "No SLA"', () => {
    show({ slaStatus: { startedAt: '2026-09-20T08:00:00Z', responseDeadline: '2026-09-20T09:00:00Z', resolveDeadline: '2026-09-20T12:00:00Z', responseMet: true, resolveMet: false, breached: true, pausedAt: null, warningMinutes: 30 } })
    expect(field('SLA')).toHaveTextContent('SLA breached')
  })

  it('the workflow history reads newest first, and can be folded', async () => {
    const { user } = mount()
    const history = screen.getByRole('button', { name: /Workflow history/ })
    const panel = document.getElementById(history.getAttribute('aria-controls') ?? '')!
    expect(within(panel).getAllByText(/^(New|In progress)$/).map((el) => el.textContent)).toEqual(['In progress', 'New'])
    expect(within(panel).getByText('Looking at the queue')).toBeInTheDocument()
    await user.click(history)
    expect(history).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Looking at the queue')).not.toBeInTheDocument()
    await user.click(history)
    expect(screen.getByText('Looking at the queue')).toBeInTheDocument()
  })
})

// ── Workflow moves ────────────────────────────────────────────────────────────

describe('IncidentDetailPage: moving the incident along its workflow', () => {
  it('a move without a note runs at once and says where the incident went', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = moved('pending')
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Transition completed → On hold'))
    expect(apolloFinto.chiamata('ExecuteWorkflowTransition')).toEqual({ instanceId: 'wi-1', toStep: 'pending' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('the buttons show the transition label in the reader\'s language', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Resolve now' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Risolvi' })).not.toBeInTheDocument()
  })

  it('a move refused by the engine says why, translated, and never "completed"', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = refused({ error: 'raw engine text', errorKey: 'errors.workflow.concurrentTransition', errorParams: [] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Someone else moved this ticket in the meantime: reload the page and try again.'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('a refusal without a reason falls back to a generic one', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = refused({})
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Transition failed'))
  })

  it('a move that fails on the server shows the error', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { error: new Error('engine unreachable') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('engine unreachable'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('from the first step, a working step needs a team: the move is refused and says where to choose it', async () => {
    const { user } = show({ status: 'new', assignedTeam: null, assignee: null, availableTransitions: [START] })
    await user.click(screen.getByRole('button', { name: 'Start work' }))
    expect(toast.error).toHaveBeenCalledWith('Select a team in the Details card first')
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
  })

  it('from the first step, a team is enough', async () => {
    const { user } = show({ status: 'new', assignee: null, availableTransitions: [START] })
    await user.click(screen.getByRole('button', { name: 'Start work' }))
    expect(apolloFinto.chiamata('ExecuteWorkflowTransition')).toEqual({ instanceId: 'wi-1', toStep: 'in_progress' })
  })

  it('after the first step, a working step needs a person of the team', async () => {
    const { user } = show({ status: 'assigned', assignee: null, availableTransitions: [START, HOLD] })
    await user.click(screen.getByRole('button', { name: 'Start work' }))
    expect(toast.error).toHaveBeenCalledWith('Select a user in the Details card first')
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
    // The rule is about WORKING steps: putting it on hold needs nobody.
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    expect(apolloFinto.chiamata('ExecuteWorkflowTransition')).toEqual({ instanceId: 'wi-1', toStep: 'pending' })
  })

  it('without the workflow rules no move is attempted: the gates could not be checked', async () => {
    apolloFinto.erroriQuery['GetWorkflowDefinition'] = new Error('definitions unavailable')
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    expect(toast.error).toHaveBeenCalledWith('Workflow rules not loaded: definitions unavailable')
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
  })

  it('an incident without a workflow instance sends nothing', async () => {
    const { user } = show({ workflowInstance: null })
    await user.click(screen.getByRole('button', { name: 'Put on hold' }))
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
  })

  it('a change can be requested from an open incident', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Request a change' }))
    await attendiURL('/changes/new', { incidentId: 'inc-1' })
  })

  it('"Back" returns to where the user came from, filters included', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/incidents?status=open', '/incidents/inc-1']} initialIndex={1}>
        <ConfirmProvider>
          <DomainVocabularyContext.Provider value={VOCABULARIES}>
            <Routes>
              <Route path="/incidents/:id" element={<IncidentDetailPage />} />
              <Route path="*" element={<LocationSpy />} />
            </Routes>
          </DomainVocabularyContext.Provider>
        </ConfirmProvider>
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await attendiURL('/incidents', { status: 'open' })
  })
})

describe('IncidentDetailPage: a move that asks for a note', () => {
  it('resolving asks for the root cause, refuses a short one, and sends it trimmed', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = moved('resolved')
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    const d = dialog('Root Cause Analysis')
    expect(within(d).getByText('Describe the root cause before resolving (at least 10 characters).')).toBeInTheDocument()
    const note = within(d).getByPlaceholderText(/memory leak/)
    const confirm = within(d).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    // Spaces do not count.
    await user.type(note, '   Disk     ')
    expect(confirm).toBeDisabled()
    await user.type(note, 'full on relay  ')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Transition executed'))
    expect(apolloFinto.chiamata('ExecuteWorkflowTransition')).toEqual({ instanceId: 'wi-1', toStep: 'resolved', notes: 'Disk     full on relay' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('any other note names the destination step', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Send back' }))
    const d = dialog('Transition → Assigned')
    expect(within(d).getByText('Add a note for this transition (at least 10 characters).')).toBeInTheDocument()
    expect(within(d).getByPlaceholderText('Notes on the transition...')).toBeInTheDocument()
  })

  it('a refused move keeps the dialog and the note, and says why', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = refused({})
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    await user.type(within(dialog('Root Cause Analysis')).getByRole('textbox'), 'Disk full on the relay')
    await user.click(within(dialog('Root Cause Analysis')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Transition error'))
    expect(within(dialog('Root Cause Analysis')).getByRole('textbox')).toHaveValue('Disk full on the relay')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a refusal with its own reason shows that reason', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = refused({ error: 'A linked problem is still open' })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    await user.type(within(dialog('Root Cause Analysis')).getByRole('textbox'), 'Disk full on the relay')
    await user.click(within(dialog('Root Cause Analysis')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A linked problem is still open'))
  })

  it('a move that fails on the server keeps the note', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { error: new Error('engine unreachable') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    await user.type(within(dialog('Root Cause Analysis')).getByRole('textbox'), 'Disk full on the relay')
    await user.click(within(dialog('Root Cause Analysis')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('engine unreachable'))
    expect(within(dialog('Root Cause Analysis')).getByRole('textbox')).toHaveValue('Disk full on the relay')
  })

  it('cancelling sends nothing, and the next time the note starts empty', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    await user.type(within(dialog('Root Cause Analysis')).getByRole('textbox'), 'half written')
    await user.click(within(dialog('Root Cause Analysis')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    expect(within(dialog('Root Cause Analysis')).getByRole('textbox')).toHaveValue('')
    // The close button of the header does the same.
    await user.click(within(dialog('Root Cause Analysis')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
  })

  it('resolving while a correlated alarm still fires warns, without forbidding', async () => {
    const { user } = show({ correlatedEvents: [alarm('ev-1', 'firing', 'Queue length high'), alarm('ev-2', 'resolved', 'Old alarm')] })
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    const d = dialog('Root Cause Analysis')
    expect(within(d).getByRole('alert')).toHaveTextContent('«Queue length high» is still firing')
    await user.type(within(d).getByRole('textbox'), 'Disk full on the relay')
    expect(within(d).getByRole('button', { name: 'Confirm' })).toBeEnabled()
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    // A move that does not resolve says nothing about alarms.
    await user.click(screen.getByRole('button', { name: 'Send back' }))
    expect(within(dialog('Transition → Assigned')).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('without a workflow instance the note cannot be sent, and the page says why', async () => {
    const { user } = show({ workflowInstance: null })
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    await user.type(within(dialog('Root Cause Analysis')).getByRole('textbox'), 'Disk full on the relay')
    await user.click(within(dialog('Root Cause Analysis')).getByRole('button', { name: 'Confirm' }))
    expect(toast.error).toHaveBeenCalledWith('WorkflowInstance not found')
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
  })

  it('while a move runs, no second move can start', () => {
    inFlight.add('ExecuteWorkflowTransition')
    mount()
    expect(screen.getByRole('button', { name: 'Put on hold' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resolve now' })).toBeDisabled()
    // The request of a change is not a workflow move: it stays available.
    expect(screen.getByRole('button', { name: 'Request a change' })).toBeEnabled()
  })

  it('while the noted move runs, its dialog says so and cannot be confirmed twice', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Send back' }))
    await user.type(within(dialog('Transition → Assigned')).getByRole('textbox'), 'Back to the queue')
    inFlight.add('ExecuteWorkflowTransition')
    await user.type(within(dialog('Transition → Assigned')).getByRole('textbox'), '!')
    expect(within(dialog('Transition → Assigned')).getByRole('button', { name: 'Running…' })).toBeDisabled()
  })
})

describe('IncidentDetailPage: the AI draft of the note', () => {
  const openResolve = async (user: ReturnType<typeof mount>['user']) => {
    await user.click(screen.getByRole('button', { name: 'Resolve now' }))
    return dialog('Root Cause Analysis')
  }

  it('fills the note with the draft written from the activity', async () => {
    apolloFinto.risposte['ResolutionDraft'] = { resolutionDraft: { draft: 'The relay disk filled up with logs.' } }
    const { user } = mount()
    const d = await openResolve(user)
    await user.click(within(d).getByRole('button', { name: /AI draft from the activity/ }))
    await waitFor(() => expect(within(d).getByRole('textbox')).toHaveValue('The relay disk filled up with logs.'))
    expect(apolloFinto.chiamata('ResolutionDraft')).toEqual({ incidentId: 'inc-1' })
  })

  it('an empty answer is said, and the note is left alone', async () => {
    const { user } = mount()
    const d = await openResolve(user)
    await user.type(within(d).getByRole('textbox'), 'mine')
    await user.click(within(d).getByRole('button', { name: /AI draft from the activity/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('AI draft failed: no response'))
    expect(within(d).getByRole('textbox')).toHaveValue('mine')
  })

  it('turned off by the organization: the button stays, disabled, and says why', async () => {
    apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { postIncident: false, kbArticles: true } } }
    const { user } = mount()
    const d = await openResolve(user)
    const draft = within(d).getByRole('button', { name: /AI draft from the activity/ })
    expect(draft).toBeDisabled()
    expect(draft).toHaveAttribute('title', '«Post-incident notes and problem candidates» is turned off for your organization: an administrator can turn it on.')
  })

  it('while the settings are unknown it waits, without guessing a reason', async () => {
    delete apolloFinto.risposte['GetAISettings']
    const { user } = mount()
    const d = await openResolve(user)
    const draft = within(d).getByRole('button', { name: /AI draft from the activity/ })
    expect(draft).toBeDisabled()
    expect(draft).not.toHaveAttribute('title')
  })

  it('while drafting it says so', async () => {
    inFlight.add('ResolutionDraft')
    const { user } = mount()
    const d = await openResolve(user)
    expect(within(d).getByRole('button', { name: /Drafting from the activity…/ })).toBeDisabled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: Apollo 4 rejects a lazy
  // query that fails, and the page only looked for `error` in a resolved
  // result — a failed draft never said why, and the rejection went unhandled.
  it('a failed draft says why', async () => {
    apolloFinto.erroriQuery['ResolutionDraft'] = new Error('model unavailable')
    const { user } = mount()
    const d = await openResolve(user)
    await user.click(within(d).getByRole('button', { name: /AI draft from the activity/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('AI draft failed: model unavailable'), { timeout: 500 })
  })
})

// ── Who works on it ───────────────────────────────────────────────────────────

describe('IncidentDetailPage: the team, then a person of the team', () => {
  it('a closed incident offers no assignment', () => {
    show({ status: 'closed', availableTransitions: [] })
    expect(screen.queryByRole('button', { name: 'Reassign' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign team' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Team' })).not.toBeInTheDocument()
  })

  it('without a team: the support teams are offered, and the chosen one is sent', async () => {
    apolloFinto.esiti['AssignIncidentToTeam'] = { data: { assignIncidentToTeam: { id: 'inc-1' } } }
    const { user } = show({ assignedTeam: null, assignee: null })
    const assign = screen.getByRole('button', { name: 'Assign team' })
    expect(assign).toBeDisabled()
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    expect(screen.queryByRole('option', { name: 'OWN_Billing' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'SUP_Network' }))
    await user.click(assign)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Team assigned'))
    expect(apolloFinto.chiamata('AssignIncidentToTeam')).toEqual({ id: 'inc-1', teamId: 't-net' })
    // Who stays assigned is the server's rule: the page reads the incident again.
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(apolloFinto.chiamate['AssignIncidentToUser']).toBeUndefined()
  })

  it('with a team: only its members are offered, and the choice is sent', async () => {
    apolloFinto.esiti['AssignIncidentToUser'] = { data: { assignIncidentToUser: { id: 'inc-1' } } }
    const { user } = show({ assignee: null })
    expect(screen.getByText('SUP_Mail', { selector: 'span' })).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Assigned to' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select user…', 'Olga Operator', 'Marco Mailman'])
    expect(screen.getByText('Choose a member of the team to assign the incident.')).toBeInTheDocument()
    const assign = screen.getByRole('button', { name: 'Assign' })
    expect(assign).toBeDisabled()
    await user.selectOptions(select, 'u-marco')
    expect(screen.queryByText('Choose a member of the team to assign the incident.')).not.toBeInTheDocument()
    await user.click(assign)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Incident assigned to Marco Mailman'))
    expect(apolloFinto.chiamata('AssignIncidentToUser')).toEqual({ id: 'inc-1', userId: 'u-marco' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a team with nobody in it says so', () => {
    show({ assignee: null, assignedTeam: { id: 't-empty', name: 'SUP_Empty' } })
    expect(screen.getByText('The team has no members: add them in Teams.')).toBeInTheDocument()
  })

  it('with a team and a person: a summary, and "Reassign" to change the team', async () => {
    apolloFinto.esiti['AssignIncidentToTeam'] = { data: { assignIncidentToTeam: { id: 'inc-1' } } }
    const { user } = mount()
    expect(screen.queryByRole('combobox', { name: 'Team' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('')
    // Cancel goes back to the summary.
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
    expect(screen.queryByRole('combobox', { name: 'Team' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    await user.click(screen.getByRole('option', { name: 'SUP_Network' }))
    await user.click(screen.getByRole('button', { name: 'Assign team' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Team assigned'))
    expect(apolloFinto.chiamata('AssignIncidentToTeam')).toEqual({ id: 'inc-1', teamId: 't-net' })
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeInTheDocument()
  })

  it('a refused assignment shows the error and claims nothing', async () => {
    apolloFinto.esiti['AssignIncidentToTeam'] = { error: new Error('team not found') }
    apolloFinto.esiti['AssignIncidentToUser'] = { error: new Error('not a member') }
    const { user, unmount } = show({ assignedTeam: null, assignee: null })
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    await user.click(screen.getByRole('option', { name: 'SUP_Network' }))
    await user.click(screen.getByRole('button', { name: 'Assign team' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('team not found'))
    unmount()
    const again = show({ assignee: null })
    await again.user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'u-olga')
    await again.user.click(screen.getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not a member'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('while an assignment is on its way the buttons wait', async () => {
    inFlight.add('AssignIncidentToTeam')
    const { unmount, user } = show({ assignedTeam: null, assignee: null })
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    await user.click(screen.getByRole('option', { name: 'SUP_Network' }))
    expect(screen.getByRole('button', { name: 'Assigning…' })).toBeDisabled()
    unmount()
    inFlight.add('AssignIncidentToUser')
    show({ assignee: null })
    expect(screen.getByRole('button', { name: 'Assigning…' })).toBeDisabled()
  })
})

// ── Editing ───────────────────────────────────────────────────────────────────

describe('IncidentDetailPage: editing the fields', () => {
  it('opens with the current values and the tenant\'s scale, and sends them trimmed', async () => {
    apolloFinto.esiti['UpdateIncident'] = { data: { updateIncident: { id: 'inc-1' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const d = dialog('Edit the incident')
    const title = within(d).getByLabelText('Title *')
    expect(title).toHaveValue('Mail relay down')
    expect(within(d).getByLabelText('Description')).toHaveValue('Outbound mail is queued')
    const impact = within(d).getByLabelText('Impact')
    expect(impact).toHaveValue('high')
    expect(within(impact).getAllByRole('option').map((o) => o.textContent)).toEqual(['Low impact', 'Medium impact', 'High impact'])
    expect(within(d).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('P2 — High priority')
    await user.selectOptions(impact, 'medium')
    await user.selectOptions(within(d).getByLabelText('Urgency'), 'medium')
    expect(within(d).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('P3 — Medium priority')
    await user.selectOptions(impact, 'high')
    // A pair the matrix does not cover says so, instead of a priority the server would refuse.
    await user.selectOptions(within(d).getByLabelText('Urgency'), 'low')
    expect(within(d).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('not covered by the matrix')
    await user.selectOptions(within(d).getByLabelText('Urgency'), 'high')
    expect(within(d).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('P1 — Critical priority')
    await user.clear(title)
    await user.type(title, '  Mail relay down (EU)  ')
    await user.clear(within(d).getByLabelText('Description'))
    await user.type(within(d).getByLabelText('Description'), '   ')
    await user.click(within(d).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Incident updated'))
    expect(apolloFinto.chiamata('UpdateIncident')).toEqual({
      id: 'inc-1', input: { title: 'Mail relay down (EU)', description: null, impact: 'high', urgency: 'high' },
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('an incident without impact or urgency starts from the tenant\'s first value, not a guess', async () => {
    const { user } = show({ impact: null, urgency: null, description: null })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const d = dialog('Edit the incident')
    expect(within(d).getByLabelText('Impact')).toHaveValue('low')
    expect(within(d).getByLabelText('Urgency')).toHaveValue('low')
    expect(within(d).getByLabelText('Description')).toHaveValue('')
    expect(within(d).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('P4 — Low priority')
  })

  it('a blank title cannot be saved, and Cancel closes without sending', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const d = dialog('Edit the incident')
    await user.clear(within(d).getByLabelText('Title *'))
    await user.type(within(d).getByLabelText('Title *'), '   ')
    expect(within(d).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['UpdateIncident']).toBeUndefined()
  })

  it('a failed save keeps the dialog open with what was typed', async () => {
    apolloFinto.esiti['UpdateIncident'] = { error: new Error('impact out of vocabulary') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(within(dialog('Edit the incident')).getByLabelText('Title *'), '!')
    await user.click(within(dialog('Edit the incident')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('impact out of vocabulary'))
    expect(within(dialog('Edit the incident')).getByLabelText('Title *')).toHaveValue('Mail relay down!')
    await user.click(within(dialog('Edit the incident')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('while saving the button says so and waits', async () => {
    inFlight.add('UpdateIncident')
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(within(dialog('Edit the incident')).getByRole('button', { name: 'Saving...' })).toBeDisabled()
  })
})

describe('IncidentDetailPage: when the tenant\'s data cannot be read', () => {
  it('without the priority matrix nothing is invented: no scale, no code, and a save keeps the incident\'s own values', async () => {
    apolloFinto.erroriQuery['GetPriorityMatrix'] = new Error('matrices down')
    apolloFinto.esiti['UpdateIncident'] = { data: { updateIncident: { id: 'inc-1' } } }
    const { user } = mount()
    expect(within(field('Priority')).getByText('P?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const d = dialog('Edit the incident')
    expect(within(within(d).getByLabelText('Impact')).queryAllByRole('option')).toHaveLength(0)
    expect(within(within(d).getByLabelText('Urgency')).queryAllByRole('option')).toHaveLength(0)
    await user.click(within(d).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateIncident')).toMatchObject({ input: { impact: 'high', urgency: 'medium' } }))
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the error of the matrix
  // was ignored, and an unreadable matrix was «not covered by the matrix —
  // complete it in Settings», sending the administrator to fix a matrix that
  // may be fine.
  it('an unreadable matrix is said as such, not blamed on its content', async () => {
    apolloFinto.erroriQuery['GetPriorityMatrix'] = new Error('matrices down')
    const { user } = show({ impact: null, urgency: null })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(within(dialog('Edit the incident')).queryByText(/complete it in Settings/)).not.toBeInTheDocument()
    expect(within(dialog('Edit the incident')).getByText('Resulting priority:').querySelector('strong'))
      .toHaveTextContent('unknown — the priority matrix could not be read (matrices down)')
  })

  it('a matrix still being read is not blamed either', async () => {
    inFlight.add('GetPriorityMatrix')
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(within(dialog('Edit the incident')).getByText('Resulting priority:').querySelector('strong')).toHaveTextContent('Loading...')
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the error of the people
  // was ignored, and «The team has no members: add them in Teams.» told the
  // agent to go and fix a team that may be complete.
  it('people that cannot be read are said, not shown as an empty team', () => {
    apolloFinto.erroriQuery['GetUsers'] = new Error('users down')
    show({ assignee: null })
    expect(screen.queryByText('The team has no members: add them in Teams.')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('People not loaded: users down')
  })

  it('people still being read are not shown as an empty team either', () => {
    inFlight.add('GetUsers')
    show({ assignee: null })
    expect(screen.queryByText('The team has no members: add them in Teams.')).not.toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled()
  })
})

// ── Major Incident ────────────────────────────────────────────────────────────

describe('IncidentDetailPage: declaring a Major Incident', () => {
  it('asks first, because it notifies the Change Manager; "Cancel" sends nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Declare Major Incident' }))
    const d = dialog('Declare a Major Incident?')
    expect(d).toHaveTextContent('INC00000042 becomes a Major Incident: the Change Manager and the escalation rules are notified straight away.')
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    expect(apolloFinto.chiamate['SetIncidentMajor']).toBeUndefined()
  })

  it('confirmed, it is sent and said', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Declare Major Incident' }))
    await user.click(within(dialog('Declare a Major Incident?')).getByRole('button', { name: 'Declare Major Incident' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Major Incident status updated'))
    expect(apolloFinto.chiamata('SetIncidentMajor')).toEqual({ id: 'inc-1', major: true })
  })

  it('a Major Incident can be revoked, with its own question', async () => {
    const { user } = show({ major: true })
    await user.click(screen.getByRole('button', { name: 'Revoke Major' }))
    const d = dialog('Revoke the Major Incident?')
    expect(d).toHaveTextContent('INC00000042 goes back to being an ordinary incident.')
    await user.click(within(d).getByRole('button', { name: 'Revoke Major' }))
    await waitFor(() => expect(apolloFinto.chiamata('SetIncidentMajor')).toEqual({ id: 'inc-1', major: false }))
  })

  it('a refusal shows the error', async () => {
    apolloFinto.esiti['SetIncidentMajor'] = { error: new Error('not allowed') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Declare Major Incident' }))
    await user.click(within(dialog('Declare a Major Incident?')).getByRole('button', { name: 'Declare Major Incident' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not allowed'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  // Found in the tour of 23 Sep 2026, fixed: the handler awaited the mutation
  // with nothing to catch it, and Apollo 4 rejects a refusal after `onError`
  // has said why — every refused declaration or revocation was also an
  // «Uncaught (in promise)».
  it('a refused declaration or revocation leaves no unhandled rejection behind', async () => {
    apolloFinto.esiti['SetIncidentMajor'] = { error: new Error('not allowed') }
    await collectingUnhandledRejections(async (seen) => {
      const { user, unmount } = mount()
      await user.click(screen.getByRole('button', { name: 'Declare Major Incident' }))
      await user.click(within(dialog('Declare a Major Incident?')).getByRole('button', { name: 'Declare Major Incident' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
      unmount()
      const again = show({ major: true })
      await again.user.click(screen.getByRole('button', { name: 'Revoke Major' }))
      await again.user.click(within(dialog('Revoke the Major Incident?')).getByRole('button', { name: 'Revoke Major' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
      // Node reports an unhandled rejection at the end of the turn it happened in: one more turn is enough.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
    })
  })

  it('while the change is on its way the button waits', () => {
    inFlight.add('SetIncidentMajor')
    mount()
    expect(screen.getByRole('button', { name: 'Declare Major Incident' })).toBeDisabled()
  })
})

// ── Knowledge base draft and PDF ──────────────────────────────────────────────

describe('IncidentDetailPage: knowledge base draft', () => {
  it('is not offered while the incident is being worked', () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Knowledge Base draft' })).not.toBeInTheDocument()
  })

  it('on a resolved incident it creates a draft, says so, and leads to the drafts', async () => {
    apolloFinto.esiti['CreateKbDraftFromIncident'] = { data: { createKbDraftFromIncident: { id: 'kb-1', slug: 'mail-relay', title: 'Mail relay runbook' } } }
    const { user } = show({ status: 'resolved', availableTransitions: [] })
    await user.click(screen.getByRole('button', { name: 'Knowledge Base draft' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(apolloFinto.chiamata('CreateKbDraftFromIncident')).toEqual({ incidentId: 'inc-1' })
    const [message, options] = toast.success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(message).toBe('KB draft created: "Mail relay runbook" — find it in Knowledge Base Admin')
    expect(options.action.label).toBe('Open drafts')
    act(() => options.action.onClick())
    await attendiURL('/admin/knowledge-base')
  })

  it('a terminal step is enough too, whatever its name', () => {
    show({ status: 'closed', availableTransitions: [] })
    expect(screen.getByRole('button', { name: 'Knowledge Base draft' })).toBeEnabled()
  })

  it('a failed draft says why', async () => {
    apolloFinto.esiti['CreateKbDraftFromIncident'] = { error: new Error('quota exceeded') }
    const { user } = show({ status: 'resolved', availableTransitions: [] })
    await user.click(screen.getByRole('button', { name: 'Knowledge Base draft' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('KB draft failed: quota exceeded'))
  })

  it('turned off: disabled, and an administrator reads where to turn it on', () => {
    apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { postIncident: true, kbArticles: false } } }
    apolloFinto.risposte['GetMe'] = { me: me(['ticket.work', 'config.organization']) }
    show({ status: 'resolved', availableTransitions: [] })
    const draft = screen.getByRole('button', { name: 'Knowledge Base draft' })
    expect(draft).toBeDisabled()
    expect(draft).toHaveAttribute('title', '«Knowledge base drafts» is turned off: turn it on in Organization → AI.')
  })

  it('while the draft is being written the button waits', () => {
    inFlight.add('CreateKbDraftFromIncident')
    show({ status: 'resolved', availableTransitions: [] })
    expect(screen.getByRole('button', { name: 'Knowledge Base draft' })).toBeDisabled()
  })
})

describe('IncidentDetailPage: PDF export', () => {
  it('downloads the incident\'s PDF named after its number, and waits meanwhile', async () => {
    let finish: () => void = () => {}
    pdf.download.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const { user } = mount()
    const button = screen.getByRole('button', { name: 'Export PDF' })
    await user.click(button)
    expect(pdf.download).toHaveBeenCalledWith('/api/incidents/inc-1/pdf', 'INC00000042.pdf')
    expect(button).toBeDisabled()
    act(() => finish())
    await waitFor(() => expect(button).toBeEnabled())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('an incident without a number is named after its id', async () => {
    const { user } = show({ number: '' })
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    expect(pdf.download).toHaveBeenCalledWith('/api/incidents/inc-1/pdf', 'inc-1.pdf')
  })

  it('a failed download says so and gives the button back', async () => {
    pdf.download.mockRejectedValue(new Error('500 Internal Server Error'))
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('PDF export failed'))
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled()
  })
})

// ── Linked tickets, CIs, comments, custom fields ──────────────────────────────

describe('IncidentDetailPage: linked tickets', () => {
  it('each kind is named as the tenant calls it, excludes this incident, and sends its own link', async () => {
    const { user } = mount()
    const section = screen.getByRole('region', { name: 'Linked tickets' })
    expect(section).toHaveAttribute('data-exclude', 'inc-1')
    expect(within(section).getByText('Disruption at /incidents: INC00000007')).toBeInTheDocument()
    expect(within(section).getByText('Known issue at /problems: none')).toBeInTheDocument()
    expect(within(section).getByText('Change at /changes: none')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'link INCIDENT' }))
    await user.click(within(section).getByRole('button', { name: 'unlink INCIDENT' }))
    await user.click(within(section).getByRole('button', { name: 'link PROBLEM' }))
    await user.click(within(section).getByRole('button', { name: 'unlink PROBLEM' }))
    await user.click(within(section).getByRole('button', { name: 'link CHANGE' }))
    await user.click(within(section).getByRole('button', { name: 'unlink CHANGE' }))
    expect(apolloFinto.chiamata('LinkRelatedTicket')).toEqual({ entityType: 'incident', entityId: 'inc-1', otherId: 'other-INCIDENT' })
    expect(apolloFinto.chiamata('UnlinkRelatedTicket')).toEqual({ entityType: 'incident', entityId: 'inc-1', otherId: 'old-INCIDENT' })
    expect(apolloFinto.chiamata('LinkIncidentToProblem')).toEqual({ problemId: 'other-PROBLEM', incidentId: 'inc-1' })
    expect(apolloFinto.chiamata('UnlinkIncidentFromProblem')).toEqual({ problemId: 'old-PROBLEM', incidentId: 'inc-1' })
    expect(apolloFinto.chiamata('LinkResolvedTicket')).toEqual({ changeId: 'other-CHANGE', entityType: 'incident', entityId: 'inc-1' })
    expect(apolloFinto.chiamata('UnlinkResolvedTicket')).toEqual({ changeId: 'old-CHANGE', entityType: 'incident', entityId: 'inc-1' })
    // Each one reads the incident again.
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(6)
  })

  it('a refused link is shown', async () => {
    apolloFinto.esiti['LinkIncidentToProblem'] = { error: new Error('already linked') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'link PROBLEM' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('already linked'))
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('without the tenant\'s names, the kinds keep their technical name', () => {
    delete apolloFinto.risposte['GetITILTypes']
    mount()
    expect(screen.getByText('incident at /incidents: INC00000007')).toBeInTheDocument()
  })
})

describe('IncidentDetailPage: CIs, comments and custom fields', () => {
  it('CI search waits for two letters, never offers the excluded types, and links and unlinks', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'ci-web', name: 'web-01' }] } }
    const { user } = mount()
    expect(screen.getByTestId('ci-list')).toHaveAttribute('data-excluded', 'network')
    await user.click(screen.getByRole('button', { name: 'type w' }))
    expect(apolloFinto.chiamate['GetAllCIs']).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'type web' }))
    expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ search: 'web', limit: 20, excludeCiTypes: ['network'] })
    await user.click(screen.getByRole('button', { name: 'add web-01' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI added'))
    expect(apolloFinto.chiamata('AddAffectedCI')).toEqual({ incidentId: 'inc-1', ciId: 'ci-web' })
    // The search is emptied after a link.
    expect(screen.queryByRole('button', { name: 'add web-01' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'remove mail-relay-01' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI removed'))
    expect(apolloFinto.chiamata('RemoveAffectedCI')).toEqual({ incidentId: 'inc-1', ciId: 'ci-relay' })
  })

  it('while the excluded types are unknown no CI is searched: they could be offered by mistake', async () => {
    delete apolloFinto.risposte['GetTicketCIExclusions']
    const { user } = mount()
    expect(screen.getByTestId('ci-list')).toHaveAttribute('data-excluded', '')
    await user.click(screen.getByRole('button', { name: 'type web' }))
    expect(apolloFinto.chiamate['GetAllCIs']).toBeUndefined()
  })

  it('a refused CI link or removal is shown', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'ci-web', name: 'web-01' }] } }
    apolloFinto.esiti['AddAffectedCI'] = { error: new Error('type excluded') }
    apolloFinto.esiti['RemoveAffectedCI'] = { error: new Error('not linked') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'type web' }))
    await user.click(screen.getByRole('button', { name: 'add web-01' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('type excluded'))
    await user.click(screen.getByRole('button', { name: 'remove mail-relay-01' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not linked'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a comment is sent with its visibility, then the incident is read again; an edit rereads too', async () => {
    const { user } = mount()
    expect(screen.getByText('2 comments')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'add public comment' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Comment added'))
    expect(apolloFinto.chiamata('AddIncidentComment')).toEqual({ id: 'inc-1', text: 'Relay restarted', isInternal: false })
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'comment edited' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(2)
  })

  it('a refused comment is shown', async () => {
    apolloFinto.esiti['AddIncidentComment'] = { error: new Error('comment too long') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'add public comment' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('comment too long'))
  })

  it('custom fields are editable with the permission the API checks, and a save rereads the incident', async () => {
    const { user, unmount } = mount()
    await user.click(screen.getByRole('button', { name: 'custom fields editable' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    unmount()
    apolloFinto.risposte['GetMe'] = { me: me([]) }
    mount()
    expect(screen.getByRole('button', { name: 'custom fields read-only' })).toBeInTheDocument()
  })
})

// ── Impacted applications ─────────────────────────────────────────────────────

describe('IncidentDetailPage: impacted applications', () => {
  const APPS = [
    {
      distance: 2, via: 'mail-relay-01',
      ci: { id: 'app-bill', name: 'Billing', type: 'application', status: 'in_service', environment: 'production' },
      path: [
        { id: 'ci-relay', name: 'mail-relay-01', type: 'server' },
        { id: 'ci-mq', name: 'queue-01', type: null },
        { id: 'app-bill', name: 'Billing', type: 'application' },
      ],
    },
    {
      distance: 0, via: null,
      ci: { id: 'app-mail', name: 'Webmail', type: 'application', status: '', environment: '' },
      path: [{ id: 'app-mail', name: 'Webmail', type: 'application' }],
    },
    {
      distance: 1, via: null,
      ci: { id: 'app-crm', name: 'CRM', type: 'application', status: 'retired', environment: 'staging' },
      path: [{ id: 'ci-relay', name: 'mail-relay-01', type: 'server' }, { id: 'app-crm', name: 'CRM', type: 'application' }],
    },
  ]

  it('none: the folded card says there is nothing depending on the hit CIs', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: /Impacted applications/ }))
    expect(screen.getByText('No application depends on the CIs hit by this incident.')).toBeInTheDocument()
  })

  it('each application says how it is hit, with the tenant\'s labels', async () => {
    const { user } = show({ impactedApplications: APPS })
    await user.click(screen.getByRole('button', { name: /Impacted applications/ }))
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/ci/application/app-bill')
    expect(screen.getByText('Depends on mail-relay-01 · 2 hops')).toBeInTheDocument()
    expect(screen.getByText('Hit directly')).toBeInTheDocument()
    expect(screen.getByText('Depends on — · 1 hop')).toBeInTheDocument()
    // Labels from the vocabularies; a value without a label is shown as it is, an empty one not at all.
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('In service')).toBeInTheDocument()
    expect(screen.getByText('staging')).toBeInTheDocument()
    expect(screen.getByText('retired')).toBeInTheDocument()
  })

  it('the path shows how the impact travels, from the hit CI to the application', async () => {
    const { user } = show({ impactedApplications: APPS })
    await user.click(screen.getByRole('button', { name: /Impacted applications/ }))
    await user.click(screen.getAllByRole('button', { name: /Path/ })[0]!)
    const d = dialog('Impact path → Billing')
    expect(d).toHaveTextContent('along the CMDB dependencies (2 hops)')
    const nodes = within(d).getAllByRole('link')
    expect(nodes.map((n) => n.textContent)).toEqual(['mail-relay-01Hit CI', 'queue-01CI', 'BillingApplication'])
    // A node without a type goes through the route that finds it in the graph.
    expect(nodes.map((n) => n.getAttribute('href'))).toEqual(['/ci/server/ci-relay', '/cis/ci-mq', '/ci/application/app-bill'])
    expect(within(d).getAllByText('→')).toHaveLength(2)
    await user.click(within(d).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // An application hit directly says so.
    await user.click(screen.getAllByRole('button', { name: /Path/ })[1]!)
    expect(dialog('Impact path → Webmail')).toHaveTextContent('along the CMDB dependencies (hit directly)')
  })
})

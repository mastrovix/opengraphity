/**
 * THE DETAIL OF A CHANGE.
 *
 * The page where a change is worked from request to closure: it is moved
 * along its workflow, approved or rejected team by team, its CIs are added,
 * removed and weighed against what they impact, and it is linked to the
 * problems and incidents it resolves. The cards with their own data and tests
 * (task table, plan, conflicts, alarms, audit, OLA, comments, attachments…)
 * are stubbed here; what is pinned is what the PAGE decides:
 *  - which actions appear for which step and permission: transitions only for
 *    who acts for any team and never during approval, approve/reject only on
 *    the rows the user may decide, add/remove CIs only at the initial step,
 *    delete only with its permission;
 *  - what each action sends, and what it says afterwards — a transition that
 *    failed must not also announce "Moved to …", one whose step actions partly
 *    failed must say which; moving to the release step before the planned
 *    window asks first; approving on behalf of another team asks first;
 *  - a rejection needs a reason and says which assessments reopen;
 *  - loading, a failed read, a change that does not exist, an empty impact
 *    list and a failed impact computation each say what they are.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'
import type { AffectedCI, ChangeApproval, DeployStep } from '@/types/change'

const hoisted = vi.hoisted(() => ({
  /** Operations whose first read is still in flight. */
  loading: new Set<string>(),
  /** Mutations still running. */
  busy: new Set<string>(),
  downloadPdf: vi.fn(),
}))

vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  type Doc = Parameters<typeof nomeOperazione>[0]
  return {
    ...fake,
    useQuery: (doc: Doc, opts?: Parameters<typeof fake.useQuery>[1]) => {
      const r = fake.useQuery(doc, opts)
      return hoisted.loading.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
    /*
     * Apollo 4 calls onError AND rejects the promise of a failed mutation
     * (node_modules/@apollo/client/react/hooks/useMutation.js); the shared fake
     * resolves after onError. The flows whose outcome depends on it: the page
     * awaits the transition before saying "Moved to …", and the approval and
     * the rejection must not let that rejection escape their handlers. The
     * `p.catch` below is Apollo's own `preventUnhandledRejection`: only a
     * handler that awaits the promise and lets the rejection go leaves one
     * behind.
     */
    useMutation: (doc: Doc, opts?: Parameters<typeof fake.useMutation>[1]) => {
      type Mutate = (o?: unknown) => Promise<{ data?: unknown; errors?: unknown[] } | undefined>
      const [mutate, fakeResult] = fake.useMutation(doc, opts) as unknown as [Mutate, Record<string, unknown>]
      const result = { ...fakeResult, loading: hoisted.busy.has(nomeOperazione(doc)) }
      if (!['ExecuteChangeTransition', 'ApproveChangeApproval', 'RejectChangeApproval'].includes(nomeOperazione(doc))) return [mutate, result]
      const apollo4: Mutate = (o) => {
        const p = mutate(o).then((r) => {
          if (r?.errors?.length) throw r.errors[0]
          return r
        })
        p.catch(() => {})
        return p
      }
      return [apollo4, result]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
vi.mock('@/lib/downloadPdf', () => ({ downloadPdf: hoisted.downloadPdf }))

// Cards with their own data and tests: here they only show what the page gives them.
vi.mock('@/components/ticket/ola/TicketOLACard', () => ({ TicketOLACard: () => null }))
vi.mock('@/components/WatcherBar', () => ({ WatcherBar: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/components/ticket/TicketTasksSection', () => ({ TicketTasksSection: () => null }))
vi.mock('@/components/ticket/EntityCommentsSection', () => ({ EntityCommentsSection: () => null }))
vi.mock('@/components/ticket/customFields/CustomFieldsCard', () => ({
  CustomFieldsCard: ({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) => (
    <button type="button" onClick={onSaved}>{canEdit ? 'custom fields editable' : 'custom fields read-only'}</button>
  ),
}))
vi.mock('./components/CITasksTable', () => ({
  CITasksTable: ({ affected, actsForAnyTeam, userTeamIds, defaultOpen }: { affected: AffectedCI[]; actsForAnyTeam: boolean; userTeamIds: Set<string>; defaultOpen?: boolean }) => (
    <p>{`task table: ${affected.map((a) => a.ci.name).join(', ')} | ${actsForAnyTeam ? 'any team' : 'own teams'} | teams ${[...userTeamIds].join(',')} | ${defaultOpen ? 'open' : 'closed'}`}</p>
  ),
}))
vi.mock('./components/ReleasePlanCard', () => ({
  ReleasePlanCard: ({ affected }: { affected: readonly AffectedCI[] }) => <p>{`consolidated plan of ${affected.length} CIs`}</p>,
}))
vi.mock('./components/AuditTimeline', () => ({
  AuditTimeline: ({ audit }: { audit: unknown[] }) => <p>{`audit entries: ${audit.length}`}</p>,
}))
vi.mock('./components/DeployConflictsSection', () => ({
  DeployConflictsSection: ({ conflitti, illeggibili }: { conflitti: readonly unknown[]; illeggibili?: readonly string[] }) => (
    <p>{`deploy conflicts: ${conflitti.length}, unreadable plans: ${(illeggibili ?? []).join(',')}`}</p>
  ),
}))
vi.mock('@/pages/events/CorrelatedEventsSection', () => ({
  SuppressedAlarmsSection: ({ events, total, changeId }: { events: unknown[]; total?: number; changeId?: string }) => (
    <p>{`suppressed alarms of ${changeId}: ${events.length} of ${total}`}</p>
  ),
}))
vi.mock('@/components/UnifiedLinkedTickets', () => ({
  UnifiedLinkedTickets: ({ title, types }: { title: string; types: Array<{ kind: string; label: string; items: Array<{ number: string }>; onLink: (id: string) => void; onUnlink: (id: string) => void }> }) => (
    <section aria-label={title}>
      {types.map((ty) => (
        <div key={ty.kind}>
          <span>{`${ty.label}: ${ty.items.map((i) => i.number).join(', ')}`}</span>
          <button type="button" onClick={() => ty.onLink(`${ty.kind.toLowerCase()}-new`)}>{`link ${ty.label}`}</button>
          <button type="button" onClick={() => ty.onUnlink(`${ty.kind.toLowerCase()}-old`)}>{`unlink ${ty.label}`}</button>
        </div>
      ))}
    </section>
  ),
}))

const { ChangeDetailPage } = await import('./ChangeDetailPage')

/** A local instant in September 2026 (the tests run in Europe/Rome). */
const at = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString()

const wfStep = (name: string, label: string, order: number, over: Record<string, unknown> = {}) => ({
  id: `s-${name}`, name, label, labels: [], type: 'standard', isInitial: false, isTerminal: false, isOpen: true,
  category: 'active', purpose: null, order, ...over,
})

const STEPS = [
  wfStep('assessment', 'Assessment', 1, { isInitial: true, purpose: 'assessment' }),
  wfStep('approval', 'Approval', 2, { purpose: 'approval', category: 'waiting' }),
  wfStep('scheduled', 'Scheduled', 3),
  wfStep('implementation', 'Implementation', 4, { purpose: 'implementation' }),
  wfStep('closed', 'Closed', 5, { isTerminal: true, isOpen: false, category: 'closed' }),
  wfStep('cancelled', 'Cancelled', 6, { isTerminal: true, isOpen: false, category: 'failed' }),
]

const tr = (toStep: string, label: string, requiresInput = false, inputField: string | null = null) =>
  ({ toStep, label, labels: [], requiresInput, inputField, condition: null })

const change = (over: Record<string, unknown> = {}) => ({
  id: 'chg-1', code: 'CHG00000042', title: 'Upgrade the orders database', why: 'End of support', what: 'PostgreSQL 16',
  aggregateRiskScore: 42, priority: 'high', approvalRoute: null, approvalStatus: null, approvalAt: null,
  createdAt: '2026-09-14T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z',
  requester: { id: 'u-r', name: 'Rita Requester' }, changeOwner: { id: 'u-o', name: 'Oscar Owner' }, approvalBy: null,
  workflowInstance: { id: 'wi-1', currentStep: 'assessment', status: 'running' },
  availableTransitions: [tr('approval', 'Send to approval'), tr('cancelled', 'Cancel the change', true, 'Cancellation reason')],
  resolvesIncidents: [{ id: 'inc-1', number: 'INC00000007', title: 'Checkout down', status: 'resolved' }],
  resolvesProblems: [{ id: 'prb-1', number: 'PRB00000003', title: 'DB leak', status: 'known_error' }],
  approvals: [],
  deployConflicts: { items: [{ changeId: 'x' }], unreadablePlans: ['TASK9'] },
  suppressedEvents: [{ id: 'ev-1' }], suppressedEventCount: 4,
  customFields: [],
  ...over,
})

const task = (id: string, code: string, status: string) =>
  ({ id, code, responderRole: 'owner', status, score: 3, completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [] })

const planStep = (title: string, val: [string, string] | null, rel: [string, string]): DeployStep => ({
  title,
  validationWindow: val ? { start: val[0], end: val[1] } : (null as unknown as DeployStep['validationWindow']),
  releaseWindow: { start: rel[0], end: rel[1] },
})

const affectedCI = (id: string, name: string, over: Partial<AffectedCI> & { type?: string | null; environment?: string | null } = {}): AffectedCI => ({
  ciPhase: 'assessment', riskScore: 3,
  ci: { id, name, type: over.type === undefined ? 'database' : over.type, environment: over.environment === undefined ? 'production' : over.environment, ownerGroup: null, supportGroup: null },
  assessmentOwner: over.assessmentOwner ?? null,
  assessmentSupport: over.assessmentSupport ?? null,
  deployPlan: over.deployPlan ?? null,
  validation: over.validation ?? null, deployment: null, review: null,
})

const DB = affectedCI('ci-db', 'orders-db', {
  assessmentOwner: task('a1', 'TASK00000001', 'completed'),
  assessmentSupport: task('a2', 'TASK00000002', 'completed'),
  deployPlan: { id: 'dp1', code: 'TASK00000003', status: 'in-progress', completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
    steps: [planStep('Deploy 16', [at(22, 20), at(22, 21)], [at(22, 22), at(22, 23)])] },
})
const APP = affectedCI('ci-app', 'orders-app', { type: 'application', environment: null, assessmentOwner: task('a4', 'TASK00000004', 'pending') })

const approval = (over: Partial<ChangeApproval>): ChangeApproval => ({
  kind: 'owner_group', teamId: 't-dba', teamName: 'DBA', status: 'pending', approvedByName: null, approvedAt: null,
  canApprove: true, onBehalf: false, ownChange: false, ...over,
})

let permissions: string[]

beforeEach(() => {
  apolloFinto.reset()
  hoisted.loading.clear()
  hoisted.busy.clear()
  hoisted.downloadPdf.mockReset().mockResolvedValue(undefined)
  toast.success.mockReset()
  toast.error.mockReset()
  toast.warning.mockReset()
  permissions = ['approval.override', 'change.delete', 'change.write', 'ticket.work']
  apolloFinto.risposte['GetMe'] = () => ({ me: { id: 'u-me', name: 'Me', email: 'me@x', role: 'custom', roleName: null, permissions, teams: [{ id: 't-dba', name: 'DBA' }] } })
  apolloFinto.risposte['GetChange'] = { change: change() }
  // The same CI twice (two rows of the API for one CI): the page shows it once.
  apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [DB, APP, DB] }
  apolloFinto.risposte['GetChangeAuditTrail'] = { changeAuditTrail: [{ timestamp: 't', action: 'created', detail: null, actor: null }] }
  apolloFinto.risposte['GetChangeImpactedCIs'] = { changeImpactedCIs: [] }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: STEPS } }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ id: 'p', name: 'problem', label: 'Problem', fields: [] }, { id: 'i', name: 'incident', label: 'Disruption', fields: [] }] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'change', ciTypes: [] }] }
})

afterEach(() => { vi.useRealTimers() })

/** The change as it is at `step`, with the given differences. */
const onStep = (step: string, over: Record<string, unknown> = {}) => {
  apolloFinto.risposte['GetChange'] = { change: change({ workflowInstance: { id: 'wi-1', currentStep: step, status: 'running' }, ...over }) }
}

const mount = () => renderWithProviders(withVocabularyLabels(<ChangeDetailPage />, {
  environment: { production: 'Production' }, priority: { high: 'High' },
}), { route: '/changes/chg-1', path: '/changes/:id' })

/**
 * The promise rejections nobody handled while `act` ran. Node reports one at
 * the end of the turn it happened in, so the listener stays a turn longer.
 */
async function unhandledRejectionsDuring(act: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const listener = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await act()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', listener)
  }
  return seen
}

const section = (name: RegExp) => screen.getByRole('button', { name })
const open = async (user: ReturnType<typeof mount>['user'], name: RegExp) => {
  if (section(name).getAttribute('aria-expanded') !== 'true') await user.click(section(name))
}

describe('ChangeDetailPage — when there is no change to show', () => {
  it('while the change loads it says so', () => {
    hoisted.loading.add('GetChange')
    mount()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('a change that cannot be read shows the error and a retry that reads it again', async () => {
    apolloFinto.erroriQuery['GetChange'] = new Error('change unavailable')
    const { user } = mount()
    expect(screen.getByText('change unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a change that does not exist says so', () => {
    apolloFinto.risposte['GetChange'] = { change: null }
    mount()
    expect(screen.getByText('Change not found')).toBeInTheDocument()
  })
})

describe('ChangeDetailPage — header', () => {
  it('reads the change, its CIs, its audit trail and its impact at depth 1, and shows the code', () => {
    mount()
    expect(apolloFinto.chiamata('GetChange')).toEqual({ id: 'chg-1' })
    expect(apolloFinto.chiamata('GetChangeAffectedCIs')).toEqual({ changeId: 'chg-1' })
    expect(apolloFinto.chiamata('GetChangeAuditTrail')).toEqual({ changeId: 'chg-1' })
    expect(apolloFinto.chiamata('GetChangeImpactedCIs')).toEqual({ changeId: 'chg-1', depth: 1 })
    expect(screen.getByRole('heading', { level: 1, name: 'CHG00000042' })).toBeInTheDocument()
  })

  it('the way back leads to the list of changes', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: '← Changes' }))
    await attendiURL('/changes')
  })

  it('the PDF is downloaded as CODE.pdf, and the button waits for it', async () => {
    let finish: () => void = () => {}
    hoisted.downloadPdf.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    expect(hoisted.downloadPdf).toHaveBeenCalledWith('/api/changes/chg-1/pdf', 'CHG00000042.pdf')
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a change without a code is downloaded under its id; a failed download says so', async () => {
    onStep('assessment', { code: '' })
    hoisted.downloadPdf.mockRejectedValue(new Error('500'))
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    expect(hoisted.downloadPdf).toHaveBeenCalledWith('/api/changes/chg-1/pdf', 'chg-1.pdf')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('PDF export failed'))
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled()
  })

  it('without the permission there is no Delete', () => {
    permissions = ['approval.override']
    mount()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('Delete asks first; Cancel keeps the change; confirming deletes it and goes back to the list', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    let dialog = screen.getByRole('dialog', { name: 'Delete the change' })
    expect(dialog).toHaveTextContent('Delete CHG00000042? The change will disappear from the lists')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('DeleteChange')).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    dialog = screen.getByRole('dialog', { name: 'Delete the change' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(apolloFinto.chiamata('DeleteChange')).toEqual({ id: 'chg-1' })
    expect(toast.success).toHaveBeenCalledWith('Change deleted')
    await attendiURL('/changes')
  })

  it('while the deletion runs, Delete cannot be pressed again', () => {
    hoisted.busy.add('DeleteChange')
    mount()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('a refused delete is reported, and the change stays on screen', async () => {
    apolloFinto.esiti['DeleteChange'] = { error: new Error('change is being deployed') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('change is being deployed'))
    // The header close button also closes it.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await attendiURL('/changes/chg-1')
  })
})

describe('ChangeDetailPage — moving the change along its workflow', () => {
  it('the phase bar follows the workflow of the tenant', () => {
    mount()
    expect(screen.getByTitle('Assessment — current')).toBeInTheDocument()
    expect(screen.getByTitle('Approval — pending')).toBeInTheDocument()
  })

  it('a transition without input moves the change, says where it went, and reads everything again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Send to approval' }))
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toEqual({ changeId: 'chg-1', toStep: 'approval', notes: null })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved to Approval'))
    // The change, its CIs and its audit trail, one after the other.
    await waitFor(() => expect(apolloFinto.refetch).toHaveBeenCalledTimes(3))
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('a transition to a step the workflow does not describe names the step as it is', async () => {
    onStep('assessment', { availableTransitions: [tr('legacy_review', 'Old review')] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Old review' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved to legacy_review'))
  })

  it('a transition whose step actions partly failed says which ones', async () => {
    apolloFinto.esiti['ExecuteChangeTransition'] = { data: { executeChangeTransition: { actionErrors: ['SLA timer', 'event'] } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Send to approval' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Transition executed, but 2 actions failed: SLA timer · event', { duration: 10000 }))
  })

  it('a refused transition is reported, and does NOT announce that the change moved', async () => {
    apolloFinto.esiti['ExecuteChangeTransition'] = { error: new Error('guard: CAB not reached') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Send to approval' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('guard: CAB not reached'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a transition that needs input asks for it, cannot be confirmed blank, and sends it trimmed', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Cancel the change' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancel the change' })
    const note = within(dialog).getByLabelText('Cancellation reason')
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    await user.type(note, '   ')
    expect(confirm).toBeDisabled()
    await user.type(note, 'Budget cut ')
    await user.click(confirm)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toEqual({ changeId: 'chg-1', toStep: 'cancelled', notes: 'Budget cut' })
  })

  it('without a named field the note is called "Notes"; cancelling sends nothing', async () => {
    onStep('assessment', { availableTransitions: [tr('approval', 'Send with a note', true, null)] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Send with a note' }))
    const dialog = screen.getByRole('dialog', { name: 'Send with a note' })
    expect(within(dialog).getByLabelText('Notes')).toHaveValue('')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toBeUndefined()
  })

  it('moving to the release step before the planned window asks first; declining keeps the change where it is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 20, 10))
    onStep('scheduled', { availableTransitions: [tr('implementation', 'Start the release')] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Start the release' }))
    const dialog = await screen.findByRole('dialog', { name: 'Before the planned window' })
    expect(dialog).toHaveTextContent('The planned release window starts on 22 Sept 2026, 22:00. Move the change to «Implementation» now?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Start the release' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, move it now' }))
    await waitFor(() => expect(apolloFinto.chiamata('ExecuteChangeTransition')).toEqual({ changeId: 'chg-1', toStep: 'implementation', notes: null }))
  })

  it('once the window has started, the release step is reached without asking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 22, 22, 30))
    onStep('scheduled', { availableTransitions: [tr('implementation', 'Start the release')] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Start the release' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toMatchObject({ toStep: 'implementation' })
  })

  it('with no planned window at all, the release step is reached without asking', async () => {
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [APP] }
    onStep('scheduled', { availableTransitions: [tr('implementation', 'Start the release')] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Start the release' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toMatchObject({ toStep: 'implementation' })
  })

  it('who does not act for any team gets no transition buttons', () => {
    permissions = ['change.delete']
    mount()
    expect(screen.queryByRole('button', { name: 'Send to approval' })).not.toBeInTheDocument()
    expect(screen.getByText(/task table: .* \| own teams \|/)).toBeInTheDocument()
  })

  it('while it is not known who is looking, nothing that needs a permission or a team is offered', () => {
    apolloFinto.risposte['GetMe'] = undefined
    mount()
    expect(screen.queryByRole('button', { name: 'Send to approval' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'custom fields read-only' })).toBeInTheDocument()
    // No team of mine: the task table cannot let me work any task.
    expect(screen.getByText('task table: orders-db, orders-app | own teams | teams | open')).toBeInTheDocument()
  })

  it('the progress of the initial step counts the tasks every CI has: three, the plan alone for a pre-approved change', () => {
    const plan = (id: string, status: string) => ({ ...DB.deployPlan!, id, status })
    const app = { ...APP, assessmentSupport: task('a5', 'TASK00000005', 'pending'), deployPlan: plan('dp2', 'pending') }
    // orders-db: both assessments done, plan in progress; orders-app: nothing done.
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [DB, app] }
    const { unmount } = mount()
    expect(screen.getByText('2/6 per-CI tasks completed')).toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [{ ...DB, deployPlan: plan('dp1', 'completed') }, app] }
    const second = mount()
    expect(screen.getByText('3/6 per-CI tasks completed')).toBeInTheDocument()
    second.unmount()
    // The owner, 25 Sep 2026: a standard change asks each CI only for its plan.
    const planOnly = (ci: typeof DB, status: string) => ({ ...ci, assessmentOwner: null, assessmentSupport: null, deployPlan: plan(`dp-${ci.ci.id}`, status) })
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [planOnly(DB, 'completed'), planOnly(APP, 'pending')] }
    mount()
    expect(screen.getByText('1/2 per-CI tasks completed')).toBeInTheDocument()
  })

  it('a change with no workflow instance, in a workflow not loaded yet, draws no phase and offers no action', async () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = undefined
    onStep('assessment', { workflowInstance: null, availableTransitions: null, customFields: null })
    const { user } = mount()
    expect(screen.queryByTitle(/ — (current|pending|completed)$/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send to approval' })).not.toBeInTheDocument()
    await open(user, /^CIs involved/)
    // Without a known initial step, neither the add nor the remove of a CI is offered.
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    expect(within(screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })

  it('a step the workflow does not describe is named as it is', () => {
    onStep('legacy_review', { availableTransitions: [] })
    mount()
    expect(screen.getByText('legacy_review in progress')).toBeInTheDocument()
  })

  it('the note dialog of a transition also closes with Escape, sending nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Cancel the change' }))
    expect(screen.getByRole('dialog', { name: 'Cancel the change' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ExecuteChangeTransition')).toBeUndefined()
  })
})

describe('ChangeDetailPage — approvals', () => {
  const APPROVALS = [
    approval({ kind: 'change_manager', teamId: 't-cm', teamName: 'CAB', status: 'approved', approvedByName: 'Ada', approvedAt: '2026-09-20T10:00:00Z', canApprove: false }),
    approval({}),
  ]

  it('before the approval step there is no approval box', () => {
    mount()
    expect(screen.queryByRole('button', { name: /^Approval/ })).not.toBeInTheDocument()
  })

  it('at the approval step it is open: one row per requirement, with team, state and who approved', () => {
    onStep('approval', { approvals: [...APPROVALS, approval({ teamId: 't-x', teamName: null, status: 'approved', approvedByName: 'Bo', canApprove: false })] })
    mount()
    expect(section(/^Approval/)).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('2/3 approved')).toBeInTheDocument()
    const row = (team: string) => screen.getByText(team).parentElement as HTMLElement
    expect(row('CAB')).toHaveTextContent(/^Change ManagerCABApprovedAda · 20 Sept 2026$/)
    expect(row('DBA')).toHaveTextContent(/^Owner GroupDBAPending— Approve Reject$/)
    // No team name reads as a dash; an approver without a date is just the name.
    expect(screen.getByText('Bo').parentElement).toHaveTextContent(/^Owner Group—ApprovedBo$/)
    // The transitions are for the approvals to decide, not for a button.
    expect(screen.queryByRole('button', { name: 'Send to approval' })).not.toBeInTheDocument()
    // During the approval the task table is folded away.
    expect(screen.getByText(/task table: .* \| closed$/)).toBeInTheDocument()
  })

  it('past the approval step the outcome stays visible, folded', async () => {
    onStep('scheduled', { approvals: APPROVALS })
    const { user } = mount()
    expect(section(/^Approval/)).toHaveAttribute('aria-expanded', 'false')
    await user.click(section(/^Approval/))
    expect(screen.getByText('1/2 approved')).toBeInTheDocument()
  })

  it('with no requirement at all it says what to check, whether the list is empty or missing', () => {
    onStep('approval', { approvals: [] })
    const { unmount } = mount()
    expect(screen.getByText(/No approval requirements\. Check that a/)).toHaveTextContent('Change Manager team is designated')
    expect(screen.getByText('0/0 approved')).toBeInTheDocument()
    unmount()
    onStep('approval', { approvals: null })
    mount()
    expect(screen.getByText(/No approval requirements\. Check that a/)).toBeInTheDocument()
  })

  it('approving for your own team is recorded at once, and everything is read again', async () => {
    onStep('approval', { approvals: APPROVALS })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ApproveChangeApproval')).toEqual({ changeId: 'chg-1', teamId: 't-dba', note: null })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Approval recorded'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('while an approval is being recorded, Approve cannot be pressed again', () => {
    hoisted.busy.add('ApproveChangeApproval')
    onStep('approval', { approvals: APPROVALS })
    mount()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('approving on behalf of another team asks first, naming the team; declining approves nothing', async () => {
    onStep('approval', { approvals: [approval({ onBehalf: true, teamName: 'Network' })] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    let dialog = await screen.findByRole('dialog', { name: 'Approve on behalf of another team?' })
    expect(dialog).toHaveTextContent('You are not a member of Network')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('ApproveChangeApproval')).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    dialog = await screen.findByRole('dialog', { name: 'Approve on behalf of another team?' })
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(apolloFinto.chiamata('ApproveChangeApproval')).toEqual({ changeId: 'chg-1', teamId: 't-dba', note: null }))
  })

  it('on their own change the requester gets no buttons, and is told who decides (24 Sep 2026)', () => {
    onStep('approval', { approvals: [approval({ canApprove: false, ownChange: true })] })
    mount()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(screen.getByText('You asked for it: another member decides')).toBeInTheDocument()
  })

  it('a team without a name, approved on behalf, is named with a dash', async () => {
    onStep('approval', { approvals: [approval({ onBehalf: true, teamName: null })] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('You are not a member of —')
  })

  it('a refused approval is reported', async () => {
    apolloFinto.esiti['ApproveChangeApproval'] = { error: new Error('not in the team') }
    onStep('approval', { approvals: APPROVALS })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not in the team'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a rejection needs a reason; by default it reopens every assessment, and the dialog closes after it', async () => {
    onStep('approval', { approvals: APPROVALS })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject approval — DBA' })
    expect(dialog).toHaveTextContent('Rejecting brings the change back to assessment')
    expect(within(dialog).getByRole('radio', { name: 'Reopen all assessments' })).toBeChecked()
    const reject = within(dialog).getByRole('button', { name: 'Reject' })
    expect(reject).toBeDisabled()
    await user.type(within(dialog).getByLabelText(/Reason for rejection/), '  Too risky ')
    await user.click(reject)
    expect(apolloFinto.chiamata('RejectChangeApproval')).toEqual({
      changeId: 'chg-1', teamId: 't-dba', note: 'Too risky', reopenAll: true, reopenTaskIds: null,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(toast.success).toHaveBeenCalledWith('Approval rejected')
  })

  it('reopening only some assessments: the tasks are listed per CI, and at least one must be picked', async () => {
    onStep('approval', { approvals: APPROVALS })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject approval — DBA' })
    await user.type(within(dialog).getByLabelText(/Reason for rejection/), 'Plan incomplete')
    await user.click(within(dialog).getByRole('radio', { name: 'Reopen only some' }))
    const reject = within(dialog).getByRole('button', { name: 'Reject' })
    expect(reject).toBeDisabled()
    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes.map((b) => b.parentElement!.textContent)).toEqual([
      'FunctionalTASK00000001completed', 'TechnicalTASK00000002completed', 'PlanningTASK00000003in-progress',
      'FunctionalTASK00000004pending',
    ])
    expect(within(dialog).getByText('orders-db')).toBeInTheDocument()
    await user.click(boxes[1]!)
    await user.click(boxes[2]!)
    await user.click(boxes[2]!)
    expect(reject).toBeEnabled()
    await user.click(reject)
    expect(apolloFinto.chiamata('RejectChangeApproval')).toEqual({
      changeId: 'chg-1', teamId: 't-dba', note: 'Plan incomplete', reopenAll: false, reopenTaskIds: ['a2'],
    })
  })

  it('with no task to reopen it says so; Cancel closes without rejecting', async () => {
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [affectedCI('ci-new', 'new-01')] }
    onStep('approval', { approvals: APPROVALS })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject approval — DBA' })
    await user.click(within(dialog).getByRole('radio', { name: 'Reopen only some' }))
    expect(within(dialog).getByText('No task available.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'Reopen all assessments' }))
    expect(within(dialog).queryByText('No task available.')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('RejectChangeApproval')).toBeUndefined()
  })

  it('the reject dialog also closes from its header, rejecting nothing', async () => {
    onStep('approval', { approvals: APPROVALS })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.type(screen.getByLabelText(/Reason for rejection/), 'Draft')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('RejectChangeApproval')).toBeUndefined()
    // Opened again, it starts from a blank reason.
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.getByLabelText(/Reason for rejection/)).toHaveValue('')
  })

  it('a refused rejection is reported, and no success is claimed', async () => {
    apolloFinto.esiti['RejectChangeApproval'] = { error: new Error('approval already closed') }
    onStep('approval', { approvals: [approval({ teamName: null })] })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject approval —' })
    await user.type(within(dialog).getByLabelText(/Reason for rejection/), 'No')
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('approval already closed'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  // Tour of 23 Sep 2026: the approve and reject handlers awaited the mutation
  // without a catch, and Apollo 4 rejects a refused mutation even after its
  // onError has said why — every refused decision also left an unhandled
  // promise rejection behind.
  it('a refused approval leaves no unhandled promise rejection behind', async () => {
    apolloFinto.esiti['ApproveChangeApproval'] = { error: new Error('not in the team') }
    onStep('approval', { approvals: APPROVALS })
    const unhandled = await unhandledRejectionsDuring(async () => {
      const { user } = mount()
      await user.click(screen.getByRole('button', { name: 'Approve' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not in the team'))
    })
    expect(unhandled).toEqual([])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a refused rejection keeps its dialog with the reason written, and leaves no unhandled promise rejection behind', async () => {
    apolloFinto.esiti['RejectChangeApproval'] = { error: new Error('approval already closed') }
    onStep('approval', { approvals: APPROVALS })
    const unhandled = await unhandledRejectionsDuring(async () => {
      const { user } = mount()
      await user.click(screen.getByRole('button', { name: 'Reject' }))
      const dialog = screen.getByRole('dialog', { name: 'Reject approval — DBA' })
      await user.type(within(dialog).getByLabelText(/Reason for rejection/), 'Too risky')
      await user.click(within(dialog).getByRole('button', { name: 'Reject' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('approval already closed'))
    })
    expect(unhandled).toEqual([])
    // F-15: what was written stays there, to try again without typing it anew.
    expect(within(screen.getByRole('dialog', { name: 'Reject approval — DBA' })).getByLabelText(/Reason for rejection/)).toHaveValue('Too risky')
  })
})

describe('ChangeDetailPage — linked tickets and the other cards', () => {
  it('shows the problems and incidents it resolves, under the customer names of the types', () => {
    mount()
    const linked = screen.getByRole('region', { name: 'Linked tickets' })
    expect(within(linked).getByText('Problem: PRB00000003')).toBeInTheDocument()
    expect(within(linked).getByText('Disruption: INC00000007')).toBeInTheDocument()
  })

  it('linking and unlinking a problem or an incident goes to the server and reads everything again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'link Problem' }))
    expect(apolloFinto.chiamata('LinkResolvedTicket')).toEqual({ changeId: 'chg-1', entityType: 'problem', entityId: 'problem-new' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ticket linked'))
    await user.click(screen.getByRole('button', { name: 'link Disruption' }))
    expect(apolloFinto.chiamata('LinkResolvedTicket')).toEqual({ changeId: 'chg-1', entityType: 'incident', entityId: 'incident-new' })
    await user.click(screen.getByRole('button', { name: 'unlink Problem' }))
    expect(apolloFinto.chiamata('UnlinkResolvedTicket')).toEqual({ changeId: 'chg-1', entityType: 'problem', entityId: 'problem-old' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ticket unlinked'))
    await user.click(screen.getByRole('button', { name: 'unlink Disruption' }))
    expect(apolloFinto.chiamata('UnlinkResolvedTicket')).toEqual({ changeId: 'chg-1', entityType: 'incident', entityId: 'incident-old' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused link or unlink is reported', async () => {
    apolloFinto.esiti['LinkResolvedTicket'] = { error: new Error('already linked') }
    apolloFinto.esiti['UnlinkResolvedTicket'] = { error: new Error('link created by the change itself') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'link Problem' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('already linked'))
    await user.click(screen.getByRole('button', { name: 'unlink Problem' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('link created by the change itself'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a change without linked tickets, conflicts or alarms gives the cards empty lists, not nothing', () => {
    onStep('assessment', { resolvesProblems: null, resolvesIncidents: null, deployConflicts: null, suppressedEvents: null, suppressedEventCount: 0, approvals: null })
    mount()
    expect(screen.getByText('Problem:')).toBeInTheDocument()
    expect(screen.getByText('deploy conflicts: 0, unreadable plans:')).toBeInTheDocument()
    expect(screen.getByText('suppressed alarms of chg-1: 0 of 0')).toBeInTheDocument()
  })

  it('the cards get the change data: conflicts, alarms, one row per CI, the audit trail', () => {
    mount()
    expect(screen.getByText('deploy conflicts: 1, unreadable plans: TASK9')).toBeInTheDocument()
    expect(screen.getByText('suppressed alarms of chg-1: 1 of 4')).toBeInTheDocument()
    // The CI listed twice by the API is shown once, everywhere.
    expect(screen.getByText('task table: orders-db, orders-app | any team | teams t-dba | open')).toBeInTheDocument()
    expect(screen.getByText('consolidated plan of 2 CIs')).toBeInTheDocument()
    expect(screen.getByText('audit entries: 1')).toBeInTheDocument()
  })

  it('with no affected CIs the cards get empty lists', () => {
    apolloFinto.risposte['GetChangeAffectedCIs'] = undefined
    apolloFinto.risposte['GetChangeAuditTrail'] = undefined
    mount()
    expect(screen.getByText('consolidated plan of 0 CIs')).toBeInTheDocument()
    expect(screen.getByText('audit entries: 0')).toBeInTheDocument()
  })

  it('the customer fields are editable with ticket.work, and a save reads everything again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'custom fields editable' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('without ticket.work the customer fields are read-only', () => {
    permissions = ['approval.override']
    mount()
    expect(screen.getByRole('button', { name: 'custom fields read-only' })).toBeInTheDocument()
  })
})

describe('ChangeDetailPage — next steps', () => {
  it('lists, per planned CI, the first validation and release, while the change is open and not validated', async () => {
    const { user } = mount()
    await open(user, /^Next steps/)
    const row = screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement
    expect(row).toHaveTextContent('Validation: 22 Sept 2026, 20:00')
    expect(row).toHaveTextContent('Deploy: 22 Sept 2026, 22:00')
    // A CI with no plan has no next step.
    expect(screen.queryByText('orders-app', { selector: 'span' })).not.toBeInTheDocument()
  })

  it('a first step with only a release window shows only the release', async () => {
    const releaseOnly = affectedCI('ci-db', 'orders-db', { deployPlan: { ...DB.deployPlan!, steps: [planStep('Deploy', null, [at(22, 22), at(22, 23)])] } })
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [releaseOnly] }
    const { user } = mount()
    await open(user, /^Next steps/)
    const row = screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement
    expect(row).not.toHaveTextContent('Validation')
    expect(row).toHaveTextContent('Deploy: 22 Sept 2026, 22:00')
  })

  it('there are no next steps once the change is finished, or once every planned CI is validated', () => {
    onStep('closed', { availableTransitions: [] })
    const { unmount } = mount()
    expect(screen.queryByRole('button', { name: /^Next steps/ })).not.toBeInTheDocument()
    unmount()
    onStep('assessment')
    apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: [{ ...DB, validation: { id: 'v', code: 'T', status: 'completed', result: 'pass', testedAt: null, testedBy: null } }] }
    mount()
    expect(screen.queryByRole('button', { name: /^Next steps/ })).not.toBeInTheDocument()
  })
})

describe('ChangeDetailPage — the CIs involved', () => {
  it('the affected CIs are listed once each, with the labels of type and environment', async () => {
    const { user } = mount()
    await open(user, /^CIs involved/)
    expect(screen.getByRole('button', { name: /CI Affected/ })).toHaveTextContent('CI Affected2')
    const db = screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement
    expect(db).toHaveTextContent('orders-dbDatabaseProduction')
    const app = screen.getByText('orders-app', { selector: 'span' }).parentElement as HTMLElement
    expect(app).toHaveTextContent(/^orders-appApplication$/)
  })

  it('at the initial step a CI can be added, from the search modal', async () => {
    const { user } = mount()
    await open(user, /^CIs involved/)
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const dialog = screen.getByRole('dialog', { name: 'Add a CI to the change' })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('at the initial step a CI can be removed after a confirmation; Cancel keeps it', async () => {
    const { user } = mount()
    await open(user, /^CIs involved/)
    const remove = within(screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement).getByRole('button')
    await user.hover(remove)
    expect(remove.style.color).toBe('var(--color-danger)')
    await user.unhover(remove)
    expect(remove.style.color).toBe('var(--color-slate-light)')
    await user.click(remove)
    let dialog = screen.getByRole('dialog', { name: 'Remove the CI' })
    expect(dialog).toHaveTextContent('Remove orders-db from the change? Every task attached to it will be deleted.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(remove)
    dialog = screen.getByRole('dialog', { name: 'Remove the CI' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(apolloFinto.chiamata('RemoveCIFromChange')).toEqual({ changeId: 'chg-1', ciId: 'ci-db' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI removed'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(3)
  })

  it('the removal confirmation also closes with Escape, removing nothing', async () => {
    const { user } = mount()
    await open(user, /^CIs involved/)
    await user.click(within(screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement).getByRole('button'))
    expect(screen.getByRole('dialog', { name: 'Remove the CI' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('RemoveCIFromChange')).toBeUndefined()
  })

  it('a refused removal is reported and the confirmation stays open', async () => {
    apolloFinto.esiti['RemoveCIFromChange'] = { error: new Error('CI already deployed') }
    const { user } = mount()
    await open(user, /^CIs involved/)
    await user.click(within(screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement).getByRole('button'))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('CI already deployed'))
    expect(screen.getByRole('dialog', { name: 'Remove the CI' })).toBeInTheDocument()
  })

  it('past the initial step the CIs can no longer be added or removed', async () => {
    onStep('scheduled')
    const { user } = mount()
    await open(user, /^CIs involved/)
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    expect(within(screen.getByText('orders-db', { selector: 'span' }).parentElement as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })

  describe('the impacted CIs', () => {
    const IMPACTED = [
      { ci: { id: 'ci-web', name: 'web-01', type: 'application', environment: 'production' }, distance: 1, affectedBy: { id: 'ci-db', name: 'orders-db', type: 'database' }, impactPath: ['orders-db', 'web-01'] },
      { ci: { id: 'ci-lb', name: 'lb-01', type: null, environment: null }, distance: 2, affectedBy: { id: 'ci-db', name: 'orders-db', type: 'database' }, impactPath: ['orders-db', 'web-01', 'lb-01'] },
      { ci: { id: 'ci-dns', name: 'dns-01', type: 'server', environment: null }, distance: 3, affectedBy: { id: 'ci-db', name: 'orders-db', type: 'database' }, impactPath: ['dns-01'] },
    ]

    it('lists what the change impacts, how far and through which CI; the path opens and closes', async () => {
      apolloFinto.risposte['GetChangeImpactedCIs'] = { changeImpactedCIs: IMPACTED }
      const { user } = mount()
      await open(user, /^CIs involved/)
      await user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      expect(screen.getByRole('button', { name: /CI Impacted/ })).toHaveTextContent('CI Impacted3')
      const row = (name: string) => screen.getAllByText(name, { selector: 'span' }).at(-1)!.parentElement as HTMLElement
      expect(row('web-01')).toHaveTextContent('web-01ApplicationProduction1 hoporders-db')
      expect(row('lb-01')).toHaveTextContent('lb-012 hopsorders-db')
      expect(row('dns-01')).toHaveTextContent('dns-01Server3 hopsorders-db')
      // A path of a single CI has nothing to unfold.
      expect(within(row('dns-01')).queryByRole('button', { name: 'dns-01' })).not.toBeInTheDocument()
      const toggle = screen.getByRole('button', { name: 'lb-01' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await user.click(toggle)
      expect(screen.getByText('orders-db → web-01 → lb-01')).toBeInTheDocument()
      await user.click(toggle)
      expect(screen.queryByText('orders-db → web-01 → lb-01')).not.toBeInTheDocument()
    })

    it('a different depth asks the server again', async () => {
      const { user } = mount()
      await open(user, /^CIs involved/)
      await user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      await user.selectOptions(screen.getByRole('combobox', { name: 'Depth' }), '3')
      expect(apolloFinto.chiamata('GetChangeImpactedCIs')).toEqual({ changeId: 'chg-1', depth: 3 })
      expect(screen.getByText('No CI impacted at depth 3.')).toBeInTheDocument()
    })

    it('at the initial step an impacted CI can be moved to the affected ones', async () => {
      apolloFinto.risposte['GetChangeImpactedCIs'] = { changeImpactedCIs: IMPACTED }
      const { user } = mount()
      await open(user, /^CIs involved/)
      await user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      await user.click(screen.getAllByTitle('Move to affected CIs')[0]!)
      expect(apolloFinto.chiamata('AddCIToChange')).toEqual({ changeId: 'chg-1', ciId: 'ci-web' })
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI added to affected'))
      expect(apolloFinto.refetch).toHaveBeenCalledTimes(3)
    })

    it('a refused move is reported; past the initial step no CI can be moved', async () => {
      apolloFinto.esiti['AddCIToChange'] = { error: new Error('no owner group') }
      apolloFinto.risposte['GetChangeImpactedCIs'] = { changeImpactedCIs: IMPACTED }
      const { user, unmount } = mount()
      await open(user, /^CIs involved/)
      await user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      await user.click(screen.getAllByTitle('Move to affected CIs')[0]!)
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('no owner group'))
      unmount()
      onStep('scheduled')
      const second = mount()
      await open(second.user, /^CIs involved/)
      await second.user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      expect(screen.queryByTitle('Move to affected CIs')).not.toBeInTheDocument()
    })

    it('no impacted CI says so; a failed computation says why and can be retried', async () => {
      const { user, unmount } = mount()
      await open(user, /^CIs involved/)
      await user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      expect(screen.getByText('No impacted CI')).toBeInTheDocument()
      expect(screen.getByText('No CI impacted at depth 1.')).toBeInTheDocument()
      unmount()
      apolloFinto.erroriQuery['GetChangeImpactedCIs'] = new Error('graph timeout')
      const second = mount()
      await open(second.user, /^CIs involved/)
      await second.user.click(screen.getByRole('button', { name: /CI Impacted/ }))
      expect(screen.getByText(/Error computing the affected CIs: graph timeout/)).toBeInTheDocument()
      expect(screen.queryByText('No impacted CI')).not.toBeInTheDocument()
      await second.user.click(screen.getByRole('button', { name: 'Try again' }))
      expect(apolloFinto.refetch).toHaveBeenCalled()
      // Back to the affected tab.
      await second.user.click(screen.getByRole('button', { name: /CI Affected/ }))
      expect(screen.getByText('orders-db', { selector: 'span' })).toBeInTheDocument()
    })
  })
})

// Review of 23 Sep 2026: the transitions and the change's CIs ask change.write, as the API does.
describe('ChangeDetailPage — who only reads changes', () => {
  it('sees the change, and no transition', () => {
    permissions = []
    mount()
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send to approval' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel the change' })).toBeNull()
  })
})

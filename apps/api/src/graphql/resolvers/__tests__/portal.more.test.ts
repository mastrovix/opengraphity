/**
 * THE END-USER PORTAL — the paths the other portal suites do not reach.
 *
 * The portal is the only door a customer's end user has into the product, and
 * everything it returns is filtered for someone who is NOT staff. The
 * behaviours pinned here, and what a user would see if they regressed:
 * - ownership: a ticket someone else opened (or one in another tenant) is
 *   FORBIDDEN for reading, commenting and reopening — never "not your ticket,
 *   but here it is";
 * - a closed ticket does not take new comments (staff would never see them);
 * - the detail shows only public replies, attachments with a download link, the
 *   step history with localized labels, only the custom fields the admin
 *   offers to end users, and — for a catalog request — the form answers the
 *   user themselves gave;
 * - the severity shown is the admin's portal wording when there is one, the
 *   Dictionary label otherwise, and the Dictionary colour;
 * - bad input (page 0, an unknown ticket type) is a clear validation error,
 *   not a Cypher failure; corrupt data (a node with none of the portal labels,
 *   a ticket vanishing mid-request) fails loud;
 * - a failed watcher notification never fails the user's comment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

type Row = Record<string, unknown>
/** Routes each Cypher to the rows the current test wants, by a substring of the query. */
const h = vi.hoisted(() => ({
  routes: [] as Array<[string, Array<Record<string, unknown>>]>,
  runs: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
}))
const rec = (r: Row) => ({ get: (k: string) => (k in r ? r[k] : null) })
const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
    run: async (cypher: string, params: Record<string, unknown>) => {
      h.runs.push({ cypher, params })
      const hit = h.routes.find(([needle]) => cypher.includes(needle))
      return { records: (hit?.[1] ?? []).map(rec) }
    },
  })),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0) }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)) }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
const sev = vi.hoisted(() => ({
  portalSeverityOptions: vi.fn(), portalSeverityChoices: vi.fn(), setPortalSeverityOptions: vi.fn(),
}))
vi.mock('../../../lib/portalSeverityOptions.js', () => ({ PORTAL_SEVERITY_VOCABULARY: 'severity', ...sev }))
const loadVocabularyEntries = vi.fn()
vi.mock('../../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries: (...a: unknown[]) => loadVocabularyEntries(...a) }))
const wf = vi.hoisted(() => ({ transition: vi.fn(), getAvailableTransitions: vi.fn(), createInstance: vi.fn() }))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: wf }))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
const helpers = vi.hoisted(() => ({ getWorkflowSteps: vi.fn(), getStepNamesByClass: vi.fn(), isEntityClosed: vi.fn() }))
vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/workflowHelpers.js')>()),
  ...helpers,
}))
const steps = vi.hoisted(() => ({ creationStepContext: vi.fn(), ticketStepContext: vi.fn() }))
vi.mock('../../../lib/customFieldSteps.js', () => steps)
const cf = vi.hoisted(() => ({ customFieldDefs: vi.fn(), customFieldValues: vi.fn() }))
vi.mock('../../../lib/ticketCustomFields.js', () => cf)
const serviceRequestFormAnswers = vi.fn()
vi.mock('../catalogForm.js', () => ({ serviceRequestFormAnswers: (...a: unknown[]) => serviceRequestFormAnswers(...a) }))
const writeTicketComment = vi.fn()
vi.mock('../../../lib/ticketComments.js', () => ({ writeTicketComment: (...a: unknown[]) => writeTicketComment(...a) }))
const notifyWatchers = vi.fn()
vi.mock('../collaboration.js', () => ({ notifyWatchers: (...a: unknown[]) => notifyWatchers(...a) }))
const logError = vi.fn()
vi.mock('../../../lib/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => logError(...a) } }))
const createIncident = vi.fn()
vi.mock('../../../services/incidentService.js', () => ({ createIncident: (...a: unknown[]) => createIncident(...a) }))
vi.mock('../../../lib/systemText.js', () => ({ systemText: vi.fn(async () => 'Reopened from the portal') }))

const { portalResolvers } = await import('../portal.js')
const Q = portalResolvers.Query
const M = portalResolvers.Mutation

const ctx: GraphQLContext = { tenantId: 't1', userId: 'user-1', userEmail: 'me@x', role: 'end_user', permissions: perms('end_user') }

const incident = (over: Row = {}): Row => ({
  id: 'inc-1', number: 'INC1', title: 'Printer', status: 'new', severity: 'high', category: 'hardware',
  created_by: 'user-1', created_at: 'a', updated_at: 'b', ...over,
})
const request = (over: Row = {}): Row => ({
  id: 'sr-1', number: 'SR1', title: 'Laptop', status: 'new', priority: 'medium',
  created_by: 'user-1', created_at: 'a', updated_at: 'b', ...over,
})

const STEPS = [
  { name: 'new', label: 'New', labels: [], isInitial: true, isTerminal: false, isOpen: true, category: 'active', stepOrder: 1 },
  { name: 'in_progress', label: 'In progress', labels: [], isInitial: false, isTerminal: false, isOpen: true, category: 'active', stepOrder: 2 },
  { name: 'waiting', label: 'Waiting', labels: [], isInitial: false, isTerminal: false, isOpen: true, category: 'waiting', stepOrder: 3 },
  { name: 'resolved', label: 'Resolved', labels: [], isInitial: false, isTerminal: false, isOpen: false, category: 'resolved', stepOrder: 4 },
  { name: 'closed', label: 'Closed', labels: [], isInitial: false, isTerminal: true, isOpen: false, category: 'closed', stepOrder: 5 },
]

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO ERROR' } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions?.['code'] ?? 'GRAPHQL') : `Error: ${(e as Error).message}`
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  h.routes = []
  h.runs = []
  sev.portalSeverityOptions.mockResolvedValue([{ value: 'high', labels: { en: 'Urgent', it: 'Urgente' } }])
  sev.portalSeverityChoices.mockResolvedValue([{ value: 'high', label: 'Urgent', color: null }])
  loadVocabularyEntries.mockResolvedValue({ values: ['low', 'medium', 'high'], labels: { medium: { en: 'Normal' } }, colors: { high: 'red' } })
  helpers.getWorkflowSteps.mockResolvedValue(STEPS)
  helpers.getStepNamesByClass.mockResolvedValue({ open: ['new'], in_progress: ['in_progress'], resolved: ['resolved'], closed: ['closed'] })
  helpers.isEntityClosed.mockResolvedValue(false)
  steps.creationStepContext.mockResolvedValue({ step: 'new' })
  steps.ticketStepContext.mockResolvedValue({ step: 'new' })
  cf.customFieldDefs.mockResolvedValue([])
  cf.customFieldValues.mockReturnValue([{ name: 'shown', visible: true }, { name: 'hidden', visible: false }])
  serviceRequestFormAnswers.mockResolvedValue([{ question: 'RAM?', answer: '16GB' }])
  writeTicketComment.mockResolvedValue({ comment: { id: 'c1', created_at: 'T', updated_at: 'T' }, author: null })
  notifyWatchers.mockResolvedValue(undefined)
})

describe('myTickets', () => {
  it.each([0, -1, 1.5])('page %s is a validation error, not a negative SKIP', async (page) => {
    expect(await code(() => Q.myTickets(null, { page }, ctx))).toBe('BAD_USER_INPUT')
    expect(h.runs).toHaveLength(0)
  })

  it('severity: the admin portal wording first, the Dictionary label otherwise, the Dictionary colour always', async () => {
    h.routes = [['SKIP toInteger', [
      { props: incident(), labels: ['Incident'], assignedTeam: null },
      { props: request(), labels: ['ServiceRequest'], assignedTeam: 'Desk' },
    ]], ['count(e) AS total', [{ total: 2 }]]]
    const out = await Q.myTickets(null, {}, ctx)
    expect(out.total).toBe(2)
    expect(out.items[0]).toMatchObject({ type: 'incident', priority: 'high', priorityLabel: 'Urgent', priorityColor: 'red', statusLabel: 'New' })
    // The request reads its priority from `priority`, and "medium" is not among the portal choices.
    expect(out.items[1]).toMatchObject({ type: 'service_request', priority: 'medium', priorityLabel: 'Normal', priorityColor: null, assignedTeam: 'Desk' })
  })

  it('with no portal wording declared, every label comes from the Dictionary', async () => {
    sev.portalSeverityOptions.mockResolvedValue(null)
    h.routes = [['SKIP toInteger', [{ props: incident(), labels: ['Incident'] }]]]
    const out = await Q.myTickets(null, { language: 'it' }, ctx)
    // No Italian label for "high" in the Dictionary: a readable fallback, never the raw empty string.
    expect(out.items[0]!.priorityLabel).not.toBe('')
    expect(out.total).toBe(0)
  })

  it('a node with none of the portal labels fails loud instead of being listed as an incident', async () => {
    h.routes = [['SKIP toInteger', [{ props: incident(), labels: ['Change'] }]]]
    expect(await code(() => Q.myTickets(null, {}, ctx))).toMatch(/has none of the labels Incident, ServiceRequest/)
  })
})

describe('myTicket — the detail', () => {
  const detailRoutes = (props: Row, labels: string[]) => [
    ['RETURN properties(e) AS props, labels(e) AS labels, t.name', [{ props, labels, assignedTeam: 'Desk' }]],
    ['HAS_COMMENT', [
      { id: 'c1', body: 'Hi', authorId: 'staff', authorName: 'Ann', authorEmail: '', createdAt: 'T1', updatedAt: 'T1' },
      { id: 'c2', body: '', authorId: 'user-1', authorName: 'Me', authorEmail: 'me@x', createdAt: 'T2', updatedAt: 'T3',
        editedAt: 'T3', editedByName: 'Me', deletedAt: 'T3', deletedByName: 'Me' },
    ]],
    ['a:Attachment', [
      { id: 'a1', filename: 'log.txt', mimeType: 'text/plain', sizeBytes: 12, uploadedBy: 'user-1', uploadedAt: 'T' },
      { id: 'a2', filename: 'x.png', mimeType: 'image/png', sizeBytes: null, uploadedBy: 'user-1', uploadedAt: 'T', description: 'screen' },
    ]],
    ['STEP_HISTORY', [
      { fromStep: null, toStep: 'new', triggeredAt: 't0', triggeredBy: null },
      { fromStep: 'new', toStep: 'ghost-step', triggeredAt: 't1', triggeredBy: 'staff' },
    ]],
  ] as Array<[string, Row[]]>

  it('an incident: public replies only, attachments with a download link, localized history, only visible custom fields', async () => {
    h.routes = detailRoutes(incident(), ['Incident'])
    const t = await Q.myTicket(null, { id: 'inc-1' }, ctx)
    const ticketRead = h.runs[0]!
    expect(ticketRead.params).toEqual({ id: 'inc-1', tenantId: 't1' })
    const commentRead = h.runs.find((r) => r.cypher.includes('HAS_COMMENT'))!
    expect(commentRead.cypher).toContain('c.is_internal = false')
    expect(commentRead.params).toEqual({ id: 'inc-1', tenantId: 't1', userId: 'user-1' })

    expect(t.comments).toEqual([
      { id: 'c1', body: 'Hi', isInternal: false, authorId: 'staff', authorName: 'Ann', authorEmail: '', createdAt: 'T1', updatedAt: 'T1',
        editedAt: null, editedByName: null, deletedAt: null, deletedByName: null },
      { id: 'c2', body: '', isInternal: false, authorId: 'user-1', authorName: 'Me', authorEmail: 'me@x', createdAt: 'T2', updatedAt: 'T3',
        editedAt: 'T3', editedByName: 'Me', deletedAt: 'T3', deletedByName: 'Me' },
    ])
    const attachmentRead = h.runs.find((r) => r.cypher.includes('a:Attachment'))!
    expect(attachmentRead.params).toEqual({ id: 'inc-1', tenantId: 't1', entityType: 'incident' })
    expect(t.attachments[0]).toMatchObject({ sizeBytes: 12, description: null, downloadUrl: '/api/attachments/a1' })
    expect(t.attachments[1]).toMatchObject({ sizeBytes: 0, description: 'screen' })

    expect(t.history).toEqual([
      { fromStep: null, toStep: 'new', fromLabel: null, toLabel: 'New', label: null, triggeredAt: 't0', triggeredBy: '' },
      // A step the workflow no longer has keeps no invented label.
      { fromStep: 'new', toStep: 'ghost-step', fromLabel: 'New', toLabel: null, label: null, triggeredAt: 't1', triggeredBy: 'staff' },
    ])
    expect(t.customFields).toEqual([{ name: 'shown', visible: true }])
    expect(cf.customFieldValues.mock.calls[0]?.[2]).toMatchObject({ onlyVisibleToEndUser: true })
    expect(t.formAnswers).toEqual([])
    expect(serviceRequestFormAnswers).not.toHaveBeenCalled()
    expect(t).toMatchObject({ assignedTeam: 'Desk', statusCategory: 'active' })
  })

  it('a catalog request shows the form answers, read as an end user with the revision it was filled with', async () => {
    h.routes = detailRoutes(request({ catalog_item_id: 'cat-1', form_revision: '3' }), ['ServiceRequest'])
    const t = await Q.myTicket(null, { id: 'sr-1' }, ctx)
    expect(t.formAnswers).toEqual([{ question: 'RAM?', answer: '16GB' }])
    const [ticketArg, , , opts] = serviceRequestFormAnswers.mock.calls[0] as [Row, unknown, unknown, Row]
    expect(ticketArg).toEqual({ id: 'sr-1', catalogItemId: 'cat-1', formRevision: 3 })
    expect(opts).toEqual({ endUser: true })
  })

  it('a request without catalog item or revision passes nulls, not "undefined"', async () => {
    h.routes = detailRoutes(request(), ['ServiceRequest'])
    await Q.myTicket(null, { id: 'sr-1' }, ctx)
    expect(serviceRequestFormAnswers.mock.calls[0]?.[0]).toEqual({ id: 'sr-1', catalogItemId: null, formRevision: null })
  })

  it('a ticket that does not exist in the tenant is FORBIDDEN', async () => {
    expect(await code(() => Q.myTicket(null, { id: 'nope' }, ctx))).toBe('FORBIDDEN')
  })

  it('someone else\'s ticket is FORBIDDEN and nothing else is read', async () => {
    h.routes = detailRoutes(incident({ created_by: 'someone-else' }), ['Incident'])
    expect(await code(() => Q.myTicket(null, { id: 'inc-1' }, ctx))).toBe('FORBIDDEN')
    expect(h.runs).toHaveLength(1)
  })
})

describe('portalCustomFields', () => {
  it('only incidents and service requests are opened from the portal', async () => {
    expect(await code(() => Q.portalCustomFields(null, { entityType: 'change' }, ctx))).toBe('BAD_USER_INPUT')
  })

  it('returns only the fields visible at creation, for the chosen category', async () => {
    const out = await Q.portalCustomFields(null, { entityType: 'service_request', category: 'hardware' }, ctx)
    expect(out).toEqual([{ name: 'shown', visible: true }])
    expect(steps.creationStepContext.mock.calls[0]?.slice(1)).toEqual(['t1', 'service_request', 'hardware'])
    expect(cf.customFieldValues.mock.calls[0]?.[1]).toEqual({})
  })

  it('without a category the creation context gets null', async () => {
    await Q.portalCustomFields(null, { entityType: 'incident' }, ctx)
    expect(steps.creationStepContext.mock.calls[0]?.[3]).toBeNull()
  })
})

describe('severity settings', () => {
  it('choices use the requested language when it is a product language, the tenant one otherwise', async () => {
    await Q.portalSeverityChoices(null, { language: 'it' }, ctx)
    await Q.portalSeverityChoices(null, { language: 'fr' }, ctx)
    expect(sev.portalSeverityChoices.mock.calls.map((c) => c[1])).toEqual(['it', 'en'])
  })

  it('options: null when the admin never declared them, otherwise one label entry per language', async () => {
    sev.portalSeverityOptions.mockResolvedValueOnce(null)
    await expect(Q.portalSeverityOptions(null, null, ctx)).resolves.toBeNull()
    await expect(Q.portalSeverityOptions(null, null, ctx)).resolves.toEqual([
      { value: 'high', labels: [{ language: 'en', label: 'Urgent' }, { language: 'it', label: 'Urgente' }] },
    ])
  })

  it('saving the options audits what was actually saved, on the tenant', async () => {
    const saved = [{ value: 'low', labels: { en: 'Minor' } }]
    sev.setPortalSeverityOptions.mockResolvedValue(saved)
    const out = await M.setPortalSeverityOptions(null, { options: [{ value: 'low', labels: [] }] as never }, ctx)
    expect(sev.setPortalSeverityOptions.mock.calls[0]?.[0]).toBe('t1')
    expect(out).toEqual([{ value: 'low', labels: [{ language: 'en', label: 'Minor' }] }])
    expect(audit).toHaveBeenCalledWith(ctx, 'tenant.portal_severity_options.updated', 'Tenant', 't1', { options: saved })
  })
})

describe('ticketCategories', () => {
  it('an empty category dictionary is an explicit error: no ticket could be opened', async () => {
    loadVocabularyEntries.mockResolvedValue({ values: [], labels: {}, colors: {} })
    expect(await code(() => Q.ticketCategories(null, {}, ctx))).toBe('BAD_USER_INPUT')
  })
})

describe('createTicket', () => {
  it('an incident that vanishes right after creation fails loud', async () => {
    createIncident.mockResolvedValue({ id: 'inc-9' })
    expect(await code(() => M.createTicket(null, { title: 'T', priority: 'high', category: 'hardware' }, ctx))).toMatch(/vanished right after creation/)
    const read = h.runs.find((r) => r.cypher.includes('RETURN properties(i) AS props'))!
    expect(read.params).toEqual({ id: 'inc-9', tenantId: 't1' })
  })
})

describe('addTicketComment', () => {
  const owned = (over: Row = {}) => [['RETURN e.created_by AS createdBy, labels(e)', [{ createdBy: 'user-1', labels: ['Incident'], ...over }]]] as Array<[string, Row[]]>

  it('a ticket that is not in the tenant is FORBIDDEN', async () => {
    expect(await code(() => M.addTicketComment(null, { ticketId: 'x', body: 'hi' }, ctx))).toBe('FORBIDDEN')
    expect(h.runs[0]!.params).toEqual({ ticketId: 'x', tenantId: 't1' })
  })

  it('someone else\'s ticket is FORBIDDEN and nothing is written', async () => {
    h.routes = owned({ createdBy: 'other' })
    expect(await code(() => M.addTicketComment(null, { ticketId: 'inc-1', body: 'hi' }, ctx))).toBe('FORBIDDEN')
    expect(writeTicketComment).not.toHaveBeenCalled()
  })

  it('a closed ticket takes no new comments', async () => {
    h.routes = owned()
    helpers.isEntityClosed.mockResolvedValue(true)
    expect(await code(() => M.addTicketComment(null, { ticketId: 'inc-1', body: 'hi' }, ctx))).toBe('BAD_USER_INPUT')
    expect(writeTicketComment).not.toHaveBeenCalled()
  })

  it('a ticket that disappears between the check and the write is FORBIDDEN', async () => {
    h.routes = owned()
    writeTicketComment.mockResolvedValue(null)
    expect(await code(() => M.addTicketComment(null, { ticketId: 'inc-1', body: 'hi' }, ctx))).toBe('FORBIDDEN')
  })

  it('on a request: a PUBLIC comment on the request, audited under its label, and the staff watching are told', async () => {
    h.routes = owned({ labels: ['ServiceRequest'] })
    writeTicketComment.mockResolvedValue({ comment: { id: 'c9', created_at: 'T', updated_at: 'T' }, author: { name: 'Me Myself', email: 'me@corp' } })
    const out = await M.addTicketComment(null, { ticketId: 'sr-1', body: 'any news?' }, ctx)
    expect(writeTicketComment.mock.calls[0]?.[1]).toMatchObject({ entityType: 'service_request', entityId: 'sr-1', tenantId: 't1', isInternal: false, authorId: 'user-1' })
    expect(out).toMatchObject({ id: 'c9', isInternal: false, authorName: 'Me Myself', authorEmail: 'me@corp' })
    expect(audit).toHaveBeenCalledWith(ctx, 'portal.comment.added', 'ServiceRequest', 'sr-1')
    expect(notifyWatchers).toHaveBeenCalledWith('t1', 'service_request', 'sr-1', { kind: 'text', text: 'any news?' }, 'user-1')
  })

  it('without a User node the author falls back to the caller e-mail', async () => {
    h.routes = owned()
    const out = await M.addTicketComment(null, { ticketId: 'inc-1', body: 'hi' }, ctx)
    expect(out).toMatchObject({ authorName: 'me@x', authorEmail: 'me@x' })
  })

  it('a failed watcher notification is logged and does not fail the comment', async () => {
    h.routes = owned()
    notifyWatchers.mockRejectedValue(new Error('redis down'))
    await expect(M.addTicketComment(null, { ticketId: 'inc-1', body: 'hi' }, ctx)).resolves.toMatchObject({ id: 'c1' })
    await flush()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[1]).toContain('watchers NOT notified')
  })
})

describe('reopenTicket — guards and target choice', () => {
  const check = (over: Row = {}) => ['OPTIONAL MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)', [{ createdBy: 'user-1', status: 'resolved', instanceId: 'wi-1', labels: ['Incident'], ...over }]] as [string, Row[]]
  const after: [string, Row[]] = ['RETURN properties(e) AS props', [{ props: incident({ status: 'new' }) }]]

  it('a ticket that is not in the tenant is FORBIDDEN', async () => {
    expect(await code(() => M.reopenTicket(null, { ticketId: 'x' }, ctx))).toBe('FORBIDDEN')
    expect(h.runs[0]!.params).toEqual({ ticketId: 'x', tenantId: 't1' })
  })

  it('someone else\'s ticket is FORBIDDEN and no transition is attempted', async () => {
    h.routes = [check({ createdBy: 'other' })]
    expect(await code(() => M.reopenTicket(null, { ticketId: 'inc-1' }, ctx))).toBe('FORBIDDEN')
    expect(wf.transition).not.toHaveBeenCalled()
  })

  it('a ticket without a workflow instance cannot be reopened', async () => {
    h.routes = [check({ instanceId: null })]
    expect(await code(() => M.reopenTicket(null, { ticketId: 'inc-1' }, ctx))).toBe('BAD_USER_INPUT')
  })

  it('when the only way back is the initial step, it goes there', async () => {
    h.routes = [check(), after]
    wf.getAvailableTransitions.mockResolvedValue([{ toStep: 'new' }, { toStep: 'closed' }, { toStep: 'no-such-step' }])
    wf.transition.mockResolvedValue({ success: true })
    const out = await M.reopenTicket(null, { ticketId: 'inc-1' }, ctx)
    expect(wf.transition.mock.calls[0]?.[1]).toMatchObject({ instanceId: 'wi-1', toStepName: 'new', tenantId: 't1', notes: 'Reopened from the portal' })
    expect(out).toMatchObject({ id: 'inc-1', status: 'new', priorityLabel: 'Urgent' })
    expect(audit).toHaveBeenCalledWith(ctx, 'portal.ticket.reopened', 'Incident', 'inc-1', { fromStep: 'resolved', toStep: 'new' })
  })

  it('with no active step reachable, any open step will do', async () => {
    h.routes = [check(), after]
    wf.getAvailableTransitions.mockResolvedValue([{ toStep: 'waiting' }])
    wf.transition.mockResolvedValue({ success: true })
    await M.reopenTicket(null, { ticketId: 'inc-1' }, ctx)
    expect(wf.transition.mock.calls[0]?.[1]).toMatchObject({ toStepName: 'waiting' })
  })

  it('a rejected transition without a reason still says why in plain words', async () => {
    h.routes = [check()]
    wf.getAvailableTransitions.mockResolvedValue([{ toStep: 'in_progress' }])
    wf.transition.mockResolvedValue({ success: false })
    let err: GraphQLError | undefined
    try { await M.reopenTicket(null, { ticketId: 'inc-1' }, ctx) } catch (e) { err = e as GraphQLError }
    expect(err?.message).toBe('Reopen failed: transition rejected by the workflow')
  })

  it('a ticket that vanishes after the transition fails loud', async () => {
    h.routes = [check({ labels: ['ServiceRequest'] })]
    wf.getAvailableTransitions.mockResolvedValue([{ toStep: 'in_progress' }])
    wf.transition.mockResolvedValue({ success: true })
    expect(await code(() => M.reopenTicket(null, { ticketId: 'sr-1' }, ctx))).toMatch(/ServiceRequest sr-1 vanished after reopen transition/)
  })
})

/**
 * The TRACE of entering a step: the internal note on the ticket and the Audit
 * Log entry (total review, B-4/B-5).
 *
 * Before, only the manual incident transition wrote them: a bulk resolve, a
 * change closing an incident, a portal reopen or an escalation moved the
 * ticket and the timeline said nothing. Now every path passes through
 * `publishStepEnteredForEntity`. Contracts pinned here:
 *  - the note is internal, authored by the actor, dated at the transition, and
 *    uses the step label in the customer's language (falling back to the name);
 *  - the operator's notes are included, trimmed; blank notes are not;
 *  - the audit carries the actor's e-mail, or the actor id for automatic paths;
 *  - neither a failed note nor a failed audit fails the transition (it already
 *    happened), but each is logged loudly, and every session is closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
const sessions: Array<{ mode: unknown; close: ReturnType<typeof vi.fn> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn((_db: unknown, mode: unknown) => {
    const s = { mode, close: vi.fn(async () => undefined) }
    sessions.push(s)
    return s
  }),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const publishEvent = vi.fn()
vi.mock('../publishEvent.js', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }))
const loadStepFacts = vi.fn()
const auditStepEntered = vi.fn()
vi.mock('../stepEvent.js', () => ({
  loadStepFacts: (...a: unknown[]) => loadStepFacts(...a),
  auditStepEntered: (...a: unknown[]) => auditStepEntered(...a),
}))
const writeTicketComment = vi.fn()
vi.mock('../ticketComments.js', () => ({ writeTicketComment: (...a: unknown[]) => writeTicketComment(...a) }))
const systemText = vi.fn(async (_t: string, key: string, params: Record<string, string>) => `${key}:${JSON.stringify(params)}`)
vi.mock('../systemText.js', () => ({ systemText: (...a: [string, string, Record<string, string>]) => systemText(...a) }))
const error = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error }) } }))

const { publishStepEnteredForEntity } = await import('../stepEnteredPublisher.js')

const PAYLOAD = { id: 'inc-1', number: 'INC00000012', title: 'DB down', severity: 'high', priority: 'high', status: 'x', ciName: '—', assignedTo: '—' }
const info = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1', actorId: 'user-1', entityType: 'incident', entityId: 'inc-1',
  stepName: 'waiting_vendor', enteredAt: '2026-09-16T10:00:00.000Z', ...over,
}) as Parameters<typeof publishStepEnteredForEntity>[0]

/** runQueryOne answers by query: ticket payload, step label, actor e-mail. */
function graph(opts: { label?: string | null; email?: string | null } = {}) {
  runQueryOne.mockImplementation(async (_s: unknown, cypher: string) => {
    if (cypher.includes('MATCH (e:')) return PAYLOAD
    if (cypher.includes('WorkflowStep')) return opts.label === undefined ? { label: 'Waiting for vendor' } : (opts.label === null ? null : { label: opts.label })
    if (cypher.includes('MATCH (u:User')) return opts.email === null ? null : { email: opts.email ?? 'mario@example.com' }
    throw new Error(`unexpected query: ${cypher}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessions.length = 0
  loadStepFacts.mockResolvedValue({ step_name: 'waiting_vendor' })
  graph()
})

describe('the note written on step entry', () => {
  it('is internal, by the actor, at the transition instant, with the localised step label', async () => {
    await publishStepEnteredForEntity(info())
    expect(writeTicketComment).toHaveBeenCalledTimes(1)
    const [, comment] = writeTicketComment.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(comment).toEqual({
      entityType: 'incident', entityId: 'inc-1', tenantId: 'tenant-1',
      text: 'workflow.transitionComment:{"step":"Waiting for vendor"}',
      authorId: 'user-1', authorLabel: null, isInternal: true, createdAt: '2026-09-16T10:00:00.000Z',
    })
  })

  it('a transition asked by a rule is signed with the rule\'s name (U-8, and the single note of D12)', async () => {
    await publishStepEnteredForEntity(info({ actorId: 'automation', actorLabel: 'Hardware to the Service Desk', notes: 'Assigned to team Desk' }))
    expect(writeTicketComment.mock.calls[0]![1]).toMatchObject({ authorId: 'automation', authorLabel: 'Hardware to the Service Desk' })
  })

  it('the step label lookup is scoped to the tenant and to the active workflow of that entity type', async () => {
    await publishStepEnteredForEntity(info())
    const call = runQueryOne.mock.calls.find((c) => String(c[1]).includes('WorkflowStep'))!
    expect(call[1]).toContain('tenant_id: $tenantId')
    expect(call[1]).toContain('active: true')
    expect(call[2]).toEqual({ tenantId: 'tenant-1', entityType: 'incident', stepName: 'waiting_vendor' })
  })

  it('falls back to the step name when the step has no label', async () => {
    graph({ label: null })
    await publishStepEnteredForEntity(info())
    expect((writeTicketComment.mock.calls[0]![1] as { text: string }).text).toContain('"step":"waiting_vendor"')
  })

  it('includes the operator notes, trimmed', async () => {
    await publishStepEnteredForEntity(info({ notes: '  vendor ticket #4411  ' }))
    expect((writeTicketComment.mock.calls[0]![1] as { text: string }).text)
      .toBe('workflow.transitionCommentNotes:{"step":"Waiting for vendor","notes":"vendor ticket #4411"}')
  })

  it('blank notes are not a note: the plain comment is written', async () => {
    await publishStepEnteredForEntity(info({ notes: '   ' }))
    expect(systemText).toHaveBeenCalledWith('tenant-1', 'workflow.transitionComment', { step: 'Waiting for vendor' })
  })

  it('a failed note does not fail the transition, is logged, and the audit is still written', async () => {
    writeTicketComment.mockRejectedValueOnce(new Error('write refused'))
    await expect(publishStepEnteredForEntity(info())).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', entityId: 'inc-1', step: 'waiting_vendor' }),
      expect.stringContaining('Nota di transizione non scritta'),
    )
    expect(auditStepEntered).toHaveBeenCalledTimes(1)
  })
})

describe('the audit entry written on step entry', () => {
  it('names the actor by e-mail and the ticket by its label', async () => {
    await publishStepEnteredForEntity(info({ entityType: 'service_request', entityId: 'sr-9' }))
    const [, ctx, entityType, label, entityId, step] = auditStepEntered.mock.calls[0] as unknown[]
    expect(ctx).toEqual({ tenantId: 'tenant-1', userId: 'user-1', userEmail: 'mario@example.com' })
    expect([entityType, label, entityId, step]).toEqual(['service_request', 'ServiceRequest', 'sr-9', 'waiting_vendor'])
    // The actor lookup is tenant-scoped: a user id from another tenant yields nothing.
    const actorCall = runQueryOne.mock.calls.find((c) => String(c[1]).includes('MATCH (u:User'))!
    expect(actorCall[2]).toEqual({ actorId: 'user-1', tenantId: 'tenant-1' })
  })

  it('an automatic path (no user node) is audited under the actor id', async () => {
    graph({ email: null })
    await publishStepEnteredForEntity(info({ actorId: 'system' }))
    expect((auditStepEntered.mock.calls[0]![1] as { userEmail: string }).userEmail).toBe('system')
  })

  it('a failed audit does not fail the transition, and is logged', async () => {
    auditStepEntered.mockRejectedValueOnce(new Error('audit down'))
    await expect(publishStepEnteredForEntity(info())).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'inc-1' }), expect.stringContaining('audit'))
  })

  it('every session opened is closed, also when both note and audit fail', async () => {
    writeTicketComment.mockRejectedValueOnce(new Error('x'))
    auditStepEntered.mockRejectedValueOnce(new Error('y'))
    await publishStepEnteredForEntity(info())
    // ticket read, step facts, note, audit
    expect(sessions).toHaveLength(4)
    for (const s of sessions) expect(s.close).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledTimes(2)
  })
})

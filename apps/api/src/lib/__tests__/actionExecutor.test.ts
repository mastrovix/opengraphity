/**
 * The action executor is what every business rule and auto-trigger runs
 * through, so its contracts are the rules' contracts:
 *
 * - a failing action STOPS the chain and reports why — otherwise a rule looks
 *   healthy while half of it never happened;
 * - every write is scoped to the tenant of the rule, never another one;
 * - a missing/invalid parameter is an error of the action, not a silent no-op
 *   (a notification with no text, a webhook with a made-up method, a team
 *   assignment on an entity that cannot have a team);
 * - a form answer on a service request goes through the form (its vocabulary
 *   and validation), not through the ITIL field writer;
 * - a transition goes through the pipeline of the transitions (wave 7 · B1),
 *   whose guards — the release window of a change among them — are its own.
 *
 * The sibling files pin the scripting plan, the engine outcome and the
 * incident/problem assignment paths; this one covers the remaining branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})

const runQuery = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => [{ ok: 1 }])
vi.mock('@opengraphity/neo4j', () => ({ runQuery: (...a: unknown[]) => runQuery(...a) }))
const publish = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('@opengraphity/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opengraphity/events')>()
  return { ...actual, publish: (...a: unknown[]) => publish(...a) }
})

// Session used by `transition_workflow` (executeRead) — replaced per test.
let wiRecords: Array<Record<string, unknown>> = []
const session = {
  executeRead: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async () => ({ records: wiRecords.map((r) => ({ get: (k: string) => r[k] ?? null })) }),
  })),
}
vi.mock('../db.js', () => ({
  withSession: vi.fn().mockImplementation((fn: (s: unknown) => unknown) => fn(session)),
}))

const writeTicketField = vi.fn<(...a: unknown[]) => Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }>>(
  async () => ({ before: { priority: 'low' }, after: { priority: 'high' } }))
vi.mock('../ticketFieldWrite.js', () => ({ writeTicketField: (...a: unknown[]) => writeTicketField(...a) }))
const formFieldsByName = vi.fn<(...a: unknown[]) => Promise<Map<string, unknown>>>(async () => new Map())
const writeFormAnswer = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ before: { laptop: 'a' }, after: { laptop: 'b' } }))
vi.mock('../catalogForm.js', () => ({
  formFieldsByName: (...a: unknown[]) => formFieldsByName(...a),
  writeFormAnswer: (...a: unknown[]) => writeFormAnswer(...a),
}))
const publishTicketUpdated = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('../ticketUpdated.js', () => ({ publishTicketUpdated: (...a: unknown[]) => publishTicketUpdated(...a) }))
const writeTicketComment = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ id: 'c1' }))
vi.mock('../ticketComments.js', () => ({ writeTicketComment: (...a: unknown[]) => writeTicketComment(...a) }))

const assertAssignablePerson = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('../../services/ticketAssignment.js', () => ({
  assertAssignablePerson: (...a: unknown[]) => assertAssignablePerson(...a),
  setTicketTeam: vi.fn(), setTicketUser: vi.fn(), assertUserInAssignedTeam: vi.fn(),
}))
vi.mock('../../services/incidentService.js', () => ({ assignIncidentToTeam: vi.fn(), assignIncidentToUser: vi.fn() }))

const transition = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ moved: true }))
vi.mock('../../services/ticketTransition.js', () => ({ transitionTicket: (...a: unknown[]) => transition(...a) }))

const runScript = vi.fn<(...a: unknown[]) => Promise<{ success: boolean; error?: string }>>(async () => ({ success: true }))
vi.mock('@opengraphity/scripting', () => ({ runScript: (...a: unknown[]) => runScript(...a) }))
vi.mock('../scriptingPlan.js', () => ({ assertScriptingEnabled: vi.fn(async () => {}) }))

const assertSafeOutboundUrl = vi.fn<(url: string) => Promise<URL>>(async (u) => new URL(u))
vi.mock('../safeUrl.js', () => ({
  assertSafeOutboundUrl: (u: string) => assertSafeOutboundUrl(u),
  loggableUrl: (u: string) => u.replace(/\?.*$/, ''),
}))

const applyRuleSLA = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('@opengraphity/sla', () => ({ applyRuleSLA: (...a: unknown[]) => applyRuleSLA(...a) }))

const { executeActions, parseActions } = await import('../actionExecutor.js')

const ctx = (entityType: string, over: Partial<{ entity: Record<string, unknown> }> = {}) => ({
  tenantId: 't1', userId: 'u1', entityId: 'x-1', entityType,
  entity: over.entity ?? { id: 'x-1', title: 'Printer down' },
  source: 'business_rule' as const, sourceName: 'Rule A',
})

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; body: { cancel: () => Promise<void> } | null }>>()

beforeEach(() => {
  vi.clearAllMocks()
  wiRecords = []
  runQuery.mockImplementation(async () => [{ ok: 1 }])
  formFieldsByName.mockImplementation(async () => new Map())
  writeTicketComment.mockImplementation(async () => ({ id: 'c1' }))
  transition.mockImplementation(async () => ({ moved: true }))
  runScript.mockImplementation(async () => ({ success: true }))
  assertSafeOutboundUrl.mockImplementation(async (u) => new URL(u))
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('parseActions', () => {
  it('returns no actions for an empty payload', () => {
    expect(parseActions(null)).toEqual([])
    expect(parseActions('')).toEqual([])
  })
  it('fails loudly on corrupt JSON or a non-array (a rule must not silently do nothing)', () => {
    expect(() => parseActions('{nope')).toThrow(/Corrupt actions JSON/)
    expect(() => parseActions('{"type":"set_field"}')).toThrow(/not an array \(got object\)/)
  })
  it('parses a valid array', () => {
    expect(parseActions('[{"type":"set_sla","params":{}}]')).toEqual([{ type: 'set_sla', params: {} }])
  })
})

describe('executeActions — chain semantics', () => {
  it('stops at the first failure and reports the error, later actions never run', async () => {
    const r = await executeActions([
      { type: 'create_notification', params: { message: 'hi' } },
      { type: 'assign_team', params: {} },
      { type: 'set_sla', params: { response_minutes: 5, resolve_minutes: 10 } },
    ], ctx('incident'))
    expect(r).toEqual([
      { action: 'create_notification', success: true },
      { action: 'assign_team', success: false, error: 'assign_team: team_id is required' },
    ])
    expect(applyRuleSLA).not.toHaveBeenCalled()
  })
  it('reports a non-Error throw as its string form', async () => {
    publish.mockRejectedValueOnce('queue down')
    const r = await executeActions([{ type: 'create_notification', params: { message: 'hi' } }], ctx('incident'))
    expect(r[0]).toEqual({ action: 'create_notification', success: false, error: 'queue down' })
  })
})

describe('set_field / set_priority', () => {
  it('writes through the ticket field writer and publishes the update with before/after', async () => {
    const r = await executeActions([{ type: 'set_field', params: { field: 'category', value: 'hw' } }], ctx('incident'))
    expect(r[0]!.success).toBe(true)
    expect(writeTicketField).toHaveBeenCalledWith(session, 't1', 'incident', 'x-1', 'category', 'hw')
    expect(publishTicketUpdated).toHaveBeenCalledWith({ tenantId: 't1', userId: 'u1' }, 'incident', 'x-1',
      { priority: 'low' }, { priority: 'high' })
  })
  it('rejects a protected field before touching the database', async () => {
    const r = await executeActions([{ type: 'set_field', params: { field: 'tenant_id', value: 'other' } }], ctx('incident'))
    expect(r[0]!.success).toBe(false)
    expect(writeTicketField).not.toHaveBeenCalled()
  })
  it('set_priority accepts `priority` or the legacy `value`, and requires one of them', async () => {
    await executeActions([{ type: 'set_priority', params: { value: 'P2' } }], ctx('problem'))
    expect(writeTicketField).toHaveBeenCalledWith(session, 't1', 'problem', 'x-1', 'priority', 'P2')
    const r = await executeActions([{ type: 'set_priority', params: {} }], ctx('problem'))
    expect(r[0]).toMatchObject({ success: false, error: 'set_priority: priority value is required' })
  })
  it('does not publish a ticket update for a change (changes have their own events)', async () => {
    await executeActions([{ type: 'set_priority', params: { priority: 'P1' } }], ctx('change'))
    expect(writeTicketField).toHaveBeenCalled()
    expect(publishTicketUpdated).not.toHaveBeenCalled()
  })
  it('on a service request, a field of the tenant form library is written as a form answer', async () => {
    formFieldsByName.mockResolvedValueOnce(new Map([['laptop', {}]]))
    await executeActions([{ type: 'set_field', params: { field: 'laptop', value: 'b' } }], ctx('service_request'))
    expect(formFieldsByName).toHaveBeenCalledWith(session, 't1', ['laptop'])
    expect(writeFormAnswer).toHaveBeenCalledWith(session, 't1', 'x-1', 'laptop', 'b')
    // Why: the ITIL writer would reject a form field — it must not be reached.
    expect(writeTicketField).not.toHaveBeenCalled()
    expect(publishTicketUpdated).toHaveBeenCalledWith(expect.anything(), 'service_request', 'x-1', { laptop: 'a' }, { laptop: 'b' })
  })
  it('on a service request, a field that is not in the form library goes to the ticket writer', async () => {
    await executeActions([{ type: 'set_field', params: { field: 'category', value: 'x' } }], ctx('service_request'))
    expect(writeFormAnswer).not.toHaveBeenCalled()
    expect(writeTicketField).toHaveBeenCalled()
  })
  it('set_priority on a service request never looks at the form library', async () => {
    await executeActions([{ type: 'set_priority', params: { priority: 'P3' } }], ctx('service_request'))
    expect(formFieldsByName).not.toHaveBeenCalled()
  })
})

describe('assign_team on tickets without a dedicated service', () => {
  it('writes the team relation scoped to the rule tenant', async () => {
    const r = await executeActions([{ type: 'assign_team', params: { team_id: 'tm' } }], ctx('service_request'))
    expect(r[0]!.success).toBe(true)
    expect(String(runQuery.mock.calls[0]![1])).toMatch(/MATCH \(e:ServiceRequest \{id: \$entityId, tenant_id: \$tenantId\}\)/)
    expect(String(runQuery.mock.calls[0]![1])).toMatch(/MATCH \(t:Team \{id: \$teamId, tenant_id: \$tenantId\}\)/)
    expect(runQuery.mock.calls[0]![2]).toMatchObject({ entityId: 'x-1', tenantId: 't1', teamId: 'tm' })
  })
  it('fails when the ticket or the team is not in the tenant (no rows written)', async () => {
    runQuery.mockResolvedValueOnce([])
    const r = await executeActions([{ type: 'assign_team', params: { team_id: 'tm' } }], ctx('change'))
    expect(r[0]!.error).toBe('assign_team: change x-1 or team tm not found')
  })
  it('refuses an entity type that has no team', async () => {
    const r = await executeActions([{ type: 'assign_team', params: { team_id: 'tm' } }], ctx('kb_article'))
    expect(r[0]!.error).toMatch(/entity type "kb_article" has no team assignment/)
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('assign_user on tickets without a dedicated service', () => {
  it('requires a user id', async () => {
    const r = await executeActions([{ type: 'assign_user', params: {} }], ctx('change'))
    expect(r[0]!.error).toBe('assign_user: user_id is required')
  })
  it('checks the person is assignable before replacing the assignee', async () => {
    const r = await executeActions([{ type: 'assign_user', params: { user_id: 'u-9' } }], ctx('change'))
    expect(r[0]!.success).toBe(true)
    expect(assertAssignablePerson).toHaveBeenCalledWith(session, 'u-9', 't1')
    expect(String(runQuery.mock.calls[0]![1])).toMatch(/MATCH \(u:User \{id: \$userId, tenant_id: \$tenantId\}\)/)
  })
  it('a person who is not assignable leaves the assignee untouched', async () => {
    assertAssignablePerson.mockRejectedValueOnce(new Error('not assignable'))
    const r = await executeActions([{ type: 'assign_user', params: { user_id: 'u-9' } }], ctx('service_request'))
    expect(r[0]!.error).toBe('not assignable')
    expect(runQuery).not.toHaveBeenCalled()
  })
  it('fails when nothing matched in the tenant', async () => {
    runQuery.mockResolvedValueOnce([])
    const r = await executeActions([{ type: 'assign_user', params: { user_id: 'u-9' } }], ctx('service_request'))
    expect(r[0]!.error).toBe('assign_user: service_request x-1 or user u-9 not found')
  })
  it('refuses an entity type that has no assignee', async () => {
    const r = await executeActions([{ type: 'assign_user', params: { user_id: 'u-9' } }], ctx('kb_article'))
    expect(r[0]!.error).toMatch(/has no assignee/)
  })
})

describe('transition_workflow', () => {
  it('requires a target step', async () => {
    const r = await executeActions([{ type: 'transition_workflow', params: {} }], ctx('incident'))
    expect(r[0]!.error).toBe('transition_workflow: to_step is required')
  })
  it('fails when the entity has no workflow instance', async () => {
    const r = await executeActions([{ type: 'transition_workflow', params: { to_step: 'done' } }], ctx('incident'))
    expect(r[0]!.error).toBe('No workflow instance found')
  })
  it('asks the pipeline as the rule, by name, on an automatic arc', async () => {
    wiRecords = [{ instanceId: 'wi-1' }]
    const r = await executeActions([{ type: 'transition_workflow', params: { to_step: 'done' } }], ctx('incident'))
    expect(r[0]!.success).toBe(true)
    expect(transition).toHaveBeenCalledWith(session, {
      tenantId: 't1', instanceId: 'wi-1', toStep: 'done', notes: 'Auto: Rule A',
      actor: { kind: 'system', path: 'rule', label: 'Rule A' }, triggerType: 'automatic',
    })
  })
  it('a change refused by the release window fails the action, naming the guard', async () => {
    wiRecords = [{ instanceId: 'wi-1' }]
    transition.mockResolvedValueOnce({ moved: false, refusal: { guard: 'change_window', final: true, message: 'outside window' } })
    const r = await executeActions([{ type: 'transition_workflow', params: { to_step: 'scheduled' } }], ctx('change'))
    expect(r[0]!.success).toBe(false)
    expect(r[0]!.error).toMatch(/^transition_workflow: the transition to "scheduled" did not happen \(change_window: outside window\)\. If this move must be automatic/)
  })
})

describe('create_notification', () => {
  it('publishes an automation.notification for the tenant with the default channel and target', async () => {
    await executeActions([{ type: 'create_notification', params: { message: 'Check it' } }], ctx('incident'))
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'automation.notification', tenant_id: 't1', actor_id: 'u1',
      payload: { entity_id: 'x-1', entity_type: 'incident', message: 'Check it', channel: 'in_app', target: 'all', rule: 'Rule A' },
    }))
  })
  it('refuses a blank message, an unknown channel and an unknown recipient', async () => {
    const blank = await executeActions([{ type: 'create_notification', params: { message: '   ' } }], ctx('incident'))
    expect(blank[0]!.error).toMatch(/non-empty message/)
    const channel = await executeActions([{ type: 'create_notification', params: { message: 'x', channel: 'sms' } }], ctx('incident'))
    expect(channel[0]!.error).toMatch(/channel "sms" is not supported \(in_app, email\)/)
    const target = await executeActions([{ type: 'create_notification', params: { message: 'x', target: 'everyone!' } }], ctx('incident'))
    expect(target[0]!.error).toMatch(/unknown recipient "everyone!"/)
    expect(publish).not.toHaveBeenCalled()
  })
  it('accepts a role target and the email channel', async () => {
    const r = await executeActions([{ type: 'create_notification', params: { message: 'x', channel: 'email', target: 'role:admin' } }], ctx('problem'))
    expect(r[0]!.success).toBe(true)
  })
})

describe('create_comment', () => {
  it('accepts `message` as the text and writes an internal note signed by the rule', async () => {
    await executeActions([{ type: 'create_comment', params: { message: 'note' } }], ctx('change'))
    expect(writeTicketComment).toHaveBeenCalledWith(session, expect.objectContaining({
      entityType: 'change', entityId: 'x-1', tenantId: 't1', text: 'note', authorLabel: 'Rule A', isInternal: true,
    }))
  })
  it('requires text, a commentable ticket, and an existing ticket', async () => {
    expect((await executeActions([{ type: 'create_comment', params: {} }], ctx('change')))[0]!.error).toBe('create_comment: text is required')
    expect((await executeActions([{ type: 'create_comment', params: { text: 'a' } }], ctx('kb_article')))[0]!.error).toMatch(/has no comments/)
    writeTicketComment.mockResolvedValueOnce(null)
    expect((await executeActions([{ type: 'create_comment', params: { text: 'a' } }], ctx('change')))[0]!.error).toBe('create_comment: change x-1 not found')
  })
})

describe('execute_script', () => {
  it('requires code', async () => {
    expect((await executeActions([{ type: 'execute_script', params: {} }], ctx('incident')))[0]!.error).toBe('execute_script: code is required')
  })
  it('a failed script fails the action, with or without a message', async () => {
    runScript.mockResolvedValueOnce({ success: false, error: 'boom' })
    expect((await executeActions([{ type: 'execute_script', params: { code: 'x' } }], ctx('incident')))[0]!.error).toBe('Script failed: boom')
    runScript.mockResolvedValueOnce({ success: false })
    expect((await executeActions([{ type: 'execute_script', params: { code: 'x' } }], ctx('incident')))[0]!.error).toBe('Script failed: unknown')
  })
})

describe('call_webhook', () => {
  it('requires a URL and an allowed method', async () => {
    expect((await executeActions([{ type: 'call_webhook', params: {} }], ctx('incident')))[0]!.error).toBe('call_webhook: url is required')
    const r = await executeActions([{ type: 'call_webhook', params: { url: 'https://h.example/x', method: 'trace' } }], ctx('incident'))
    expect(r[0]!.error).toMatch(/method "TRACE" is not allowed/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('an unsafe URL (SSRF guard) is never called', async () => {
    assertSafeOutboundUrl.mockRejectedValueOnce(new Error('private address'))
    const r = await executeActions([{ type: 'call_webhook', params: { url: 'https://10.0.0.1/' } }], ctx('incident'))
    expect(r[0]!.error).toBe('private address')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('POSTs the entity as JSON with the custom headers and drains the response body', async () => {
    const cancel = vi.fn(async () => {})
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: { cancel } })
    const r = await executeActions([{ type: 'call_webhook', params: { url: 'https://h.example/x', headers: { 'X-Key': 'k' } } }], ctx('incident'))
    expect(r[0]!.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://h.example/x')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Key': 'k' })
    expect(JSON.parse(String(init.body))).toEqual({ entity: { id: 'x-1', title: 'Printer down' }, entityType: 'incident', source: 'business_rule', rule: 'Rule A' })
    // Why: an undrained body keeps the connection open until GC.
    expect(cancel).toHaveBeenCalled()
  })
  it('GET sends no body; a response with no body is fine', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, body: null })
    const r = await executeActions([{ type: 'call_webhook', params: { url: 'https://h.example/x', method: 'get' } }], ctx('incident'))
    expect(r[0]!.success).toBe(true)
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined()
  })
  it('a non-2xx status fails the action without leaking the query string', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, body: { cancel: async () => { throw new Error('already') } } })
    const r = await executeActions([{ type: 'call_webhook', params: { url: 'https://h.example/x?token=secret' } }], ctx('incident'))
    expect(r[0]!.error).toBe('Webhook https://h.example/x returned 500')
  })
})

describe('set_sla', () => {
  it('hands the minutes to the SLA engine, with the warning only when configured', async () => {
    await executeActions([{ type: 'set_sla', params: { response_minutes: '15', resolve_minutes: 60 } }], ctx('incident'))
    expect(applyRuleSLA).toHaveBeenLastCalledWith({ tenantId: 't1', entityType: 'incident', entityId: 'x-1', responseMinutes: 15, resolveMinutes: 60, ruleName: 'Rule A' })
    await executeActions([{ type: 'set_sla', params: { response_minutes: 15, resolve_minutes: 60, warning_minutes: 10 } }], ctx('incident'))
    expect(applyRuleSLA).toHaveBeenLastCalledWith(expect.objectContaining({ warningMinutes: 10 }))
  })
})

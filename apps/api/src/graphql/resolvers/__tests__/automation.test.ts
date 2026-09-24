/**
 * The automation resolvers end to end: auto triggers, business rules and SLA
 * policies, read and written through a small in-memory graph.
 *
 * Why these behaviours matter:
 * - Every read and write is scoped by `tenant_id`. A trigger or policy that
 *   leaked across tenants would fire actions on another customer's tickets.
 * - The write-time checks (event × ticket support, «is changed» only on
 *   updates, step targets, roles) are what keeps a rule from looking enabled
 *   while never firing. On an UPDATE they must look at the state the node will
 *   have afterwards, mixing the stored values with the new ones.
 * - Turning on an automation born from an AI proposal re-runs the restricted
 *   action allowlist: that is the moment the content may have changed.
 * - The engines cache triggers and rules: a write that forgot to invalidate
 *   would keep running the old rule until a restart.
 * - SLA policies must stay applicable (warning inside the resolution time,
 *   compliance objective, calendar of this tenant) and the GraphQL names must
 *   land on the right node properties, or the SLA engine reads a stale value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── In-memory graph ──────────────────────────────────────────────────────────

type Props = Record<string, unknown>
const nodes = new Map<string, Props>()               // key: `${label}:${id}`
const teams = new Map<string, string>()              // key: `${tenantId}:${teamId}` → name
const calendars = new Map<string, string>()          // key: `${tenantId}:${calendarId}` → name
const queries: { cypher: string; params: Props }[] = []

const LABELS: Record<string, string> = { t: 'AutoTrigger', r: 'BusinessRule', p: 'SLAPolicyNode' }

function find(label: string, id: unknown, tenantId: unknown): Props | undefined {
  const n = nodes.get(`${label}:${String(id)}`)
  return n && n['tenant_id'] === tenantId ? n : undefined
}

/** Applies `x.prop = $param` pairs of a SET clause, the way Neo4j would. */
function applySet(cypher: string, node: Props, params: Props): void {
  const setClause = cypher.slice(cypher.indexOf('SET'))
  for (const m of setClause.matchAll(/\b[trp]\.(\w+) = \$(\w+)/g)) node[m[1]!] = params[m[2]!]
}

async function fakeRunQuery(_s: unknown, cypher: string, params: Props = {}): Promise<unknown[]> {
  queries.push({ cypher, params })
  const create = /CREATE \((\w):(\w+) \{/.exec(cypher)
  if (create) {
    const props: Props = {}
    for (const m of cypher.matchAll(/(\w+): \$(\w+)/g)) props[m[1]!] = params[m[2]!]
    for (const m of cypher.matchAll(/(\w+): (0|null|true)\b/g)) props[m[1]!] = m[2] === '0' ? 0 : m[2] === 'true' ? true : null
    nodes.set(`${create[2]}:${String(props['id'])}`, props)
    return [{ props: { ...props } }]
  }
  const byId = /MATCH \((\w):(\w+) \{id: \$id, tenant_id: \$tenantId\}\)/.exec(cypher)
  if (byId) {
    const node = find(byId[2]!, params['id'], params['tenantId'])
    if (cypher.includes('DETACH DELETE')) {
      if (node) nodes.delete(`${byId[2]}:${String(params['id'])}`)
      return []
    }
    if (!node) return []
    if (cypher.includes('SET')) {
      applySet(cypher, node, params)
      return cypher.includes('RETURN') ? [{ props: { ...node } }] : []
    }
    if (cypher.includes('AS entityType') && cypher.includes('n.entity_type')) return [{ entityType: node['entity_type'] }]
    if (cypher.includes('AS timerDelay')) return [{ timerDelay: node['timer_delay_minutes'] ?? null, eventType: node['event_type'] }]
    if (cypher.includes('AS eventType')) return [{ eventType: node['event_type'], conditions: node['conditions'] ?? null }]
    if (cypher.includes('AS entityType')) return [{ entityType: node['entity_type'] }]
    if (cypher.includes('AS warning, p.resolve_minutes')) return [{ warning: node['warning_minutes'], resolve: node['resolve_minutes'], response: node['response_minutes'] }]
    if (cypher.includes('AS target')) return [{ target: node['compliance_target'], warning: node['compliance_warning'] }]
    return [{ props: { ...node } }]
  }
  const list = /MATCH \((\w):(\w+) \{tenant_id: \$tenantId\}\)/.exec(cypher)
  if (list) {
    const label = LABELS[list[1]!]!
    return [...nodes.entries()]
      .filter(([k, n]) => k.startsWith(`${label}:`) && n['tenant_id'] === params['tenantId'])
      .filter(([, n]) => !cypher.includes(`${list[1]}.entity_type = $entityType`) || n['entity_type'] === params['entityType'])
      .map(([, n]) => ({ props: { ...n }, teamName: teams.get(`${String(params['tenantId'])}:${String(n['team_id'])}`) ?? null }))
  }
  throw new Error(`unexpected query: ${cypher}`)
}

const runQuery = vi.fn(fakeRunQuery)
const runQueryOne = vi.fn(async (_s: unknown, cypher: string, params: Props) => {
  if (!cypher.includes('ServiceCalendar')) throw new Error(`unexpected query: ${cypher}`)
  const name = calendars.get(`${String(params['tenantId'])}:${String(params['id'])}`)
  return name == null ? null : { id: params['id'], name }
})
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: (...a: Parameters<typeof fakeRunQuery>) => runQuery(...a),
  runQueryOne: (...a: [unknown, string, Props]) => runQueryOne(...a),
  getSession: () => ({ close: async () => undefined }),
}))
const writeFlags: boolean[] = []
vi.mock('../ci-utils.js', () => ({
  withSession: async (fn: (s: unknown) => unknown, write?: boolean) => { writeFlags.push(write === true); return fn({}) },
}))

const invalidateTriggerCache = vi.fn()
const invalidateRulesCache = vi.fn()
vi.mock('../../../lib/triggerEngine.js', () => ({ invalidateTriggerCache: (t: string) => invalidateTriggerCache(t) }))
vi.mock('../../../lib/rulesEngine.js', () => ({ invalidateRulesCache: (t: string) => invalidateRulesCache(t) }))

vi.mock('../../../lib/stepFieldWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/stepFieldWrites.js')>()),
  stepFieldMetas: vi.fn(async (_s: unknown, _t: string, entityType: string) => new Map(entityType === 'incident'
    ? [['severity', { name: 'severity', fieldType: 'enum', enumValues: ['critical', 'high', 'low'], enumTypeName: 'severity' }]]
    : [['priority', { name: 'priority', fieldType: 'enum', enumValues: ['p1', 'p2'], enumTypeName: 'priority' }]])),
}))
vi.mock('../../../lib/catalogForm.js', () => ({ formFieldAutomationMetas: vi.fn(async () => new Map()) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn(async () => [{ name: 'new' }, { name: 'in_progress' }, { name: 'resolved' }]),
}))
vi.mock('../../../lib/roles.js', async (importOriginal) => {
  const { ValidationError } = await import('../../../lib/errors.js')
  return {
    ...(await importOriginal<typeof import('../../../lib/roles.js')>()),
    assertRolesExist: vi.fn(async (_t: string, keys: readonly string[]) => {
      const missing = keys.filter((k) => k !== 'service_desk')
      if (missing.length) throw new ValidationError(`Recipients name roles this organization does not have: ${missing.join(', ')}`)
    }),
  }
})
const selectSLAForEntity = vi.fn()
vi.mock('@opengraphity/sla', () => ({
  selectSLAForEntity: (...a: unknown[]) => selectSLAForEntity(...a),
  // Same contract as packages/sla/src/ruleSla.ts: positive whole minutes, response not after resolve.
  assertRuleSLAMinutes: (response: unknown, resolve: unknown) => {
    if (!Number.isInteger(response) || !Number.isInteger(resolve) || (response as number) <= 0 || (resolve as number) <= 0) {
      throw new Error('set_sla: response_minutes and resolve_minutes must be positive whole numbers')
    }
    if ((response as number) > (resolve as number)) throw new Error('set_sla: the response target cannot be later than the resolution target')
    return { response, resolve }
  },
}))

const { automationResolvers, assertActionsJson, assertEventSupported } = await import('../automation.js')
const { ValidationError } = await import('../../../lib/errors.js')
const { Query, Mutation, SLAPolicyNode } = automationResolvers

const ctxA = { tenantId: 'tenant-a' } as never
const ctxB = { tenantId: 'tenant-b' } as never

beforeEach(() => {
  nodes.clear(); teams.clear(); calendars.clear()
  queries.length = 0; writeFlags.length = 0
  runQuery.mockClear(); invalidateTriggerCache.mockClear(); invalidateRulesCache.mockClear(); selectSLAForEntity.mockReset()
})

function seed(label: string, props: Props): void {
  nodes.set(`${label}:${String(props['id'])}`, { ...props })
}

// ── Pure validators not covered elsewhere ────────────────────────────────────

describe('assertActionsJson — notification and SLA actions', () => {
  it('create_notification defaults to everyone in-app, and rejects an unknown recipient or channel', () => {
    expect(assertActionsJson('[{"type":"create_notification","params":{"message":"hi"}}]')).not.toBeNull()
    expect(() => assertActionsJson('[{"type":"create_notification","params":{"target":"martians"}}]'))
      .toThrow(/unknown recipient "martians"/)
    expect(() => assertActionsJson('[{"type":"create_notification","params":{"channel":"pigeon"}}]'))
      .toThrow(/channel must be one of: in_app, email/)
    expect(() => assertActionsJson('[{"type":"create_notification","params":{"channel":7}}]'))
      .toThrow(/channel must be one of/)
  })

  it('set_sla rejects minutes the SLA engine would refuse, naming the action index', () => {
    expect(assertActionsJson('[{"type":"set_sla","params":{"response_minutes":30,"resolve_minutes":60}}]')).not.toBeNull()
    // The engine's own error is wrapped: the admin must see WHICH action is wrong.
    expect(() => assertActionsJson('[{"type":"assign_team","params":{}},{"type":"set_sla","params":{"response_minutes":90,"resolve_minutes":60}}]'))
      .toThrow(/item 1 — set_sla: the response target/)
    expect(() => assertActionsJson('[{"type":"set_sla"}]')).toThrow(ValidationError)
  })

  it('rejects non-string input, empty-object items and non-array JSON', () => {
    expect(assertActionsJson(null)).toBeNull()
    expect(() => assertActionsJson(42)).toThrow(/actions must be a JSON string/)
    expect(() => assertActionsJson('[null]')).toThrow(/item 0 is not an object/)
  })
})

describe('assertEventSupported', () => {
  it('a change never gets field updates: on_update is refused, naming where it does run', () => {
    expect(() => assertEventSupported('on_update', 'incident')).not.toThrow()
    expect(() => assertEventSupported('on_update', 'change')).toThrow(/runs for incident, problem, service_request/)
  })
  it('an unknown event says it runs for no ticket type instead of crashing', () => {
    expect(() => assertEventSupported('on_moon', 'incident')).toThrow(/runs for no ticket type/)
  })
})

// ── Auto triggers ────────────────────────────────────────────────────────────

describe('autoTriggers (query)', () => {
  beforeEach(() => {
    seed('AutoTrigger', { id: 'a1', tenant_id: 'tenant-a', name: 'Escalate', entity_type: 'incident', event_type: 'on_create', execution_count: 3, timer_delay_minutes: 15, enabled: true })
    seed('AutoTrigger', { id: 'a2', tenant_id: 'tenant-a', name: 'Change note', entity_type: 'change', event_type: 'on_create' })
    seed('AutoTrigger', { id: 'b1', tenant_id: 'tenant-b', name: 'Other tenant', entity_type: 'incident', event_type: 'on_create' })
  })

  it('lists only this tenant, maps the node and fills defaults for old nodes', async () => {
    const list = await Query.autoTriggers(null, {}, ctxA)
    expect(list.map((t) => t.id).sort()).toEqual(['a1', 'a2'])
    const a1 = list.find((t) => t.id === 'a1')!
    expect(a1).toMatchObject({ entityType: 'incident', eventType: 'on_create', executionCount: 3, timerDelayMinutes: 15, enabled: true, origin: 'manual' })
    // A node written before these properties existed: nothing enabled by accident, counters at zero.
    expect(list.find((t) => t.id === 'a2')).toMatchObject({ enabled: false, executionCount: 0, timerDelayMinutes: null, conditions: null, actions: null, lastExecutedAt: null })
  })

  it('filters by entity type and default-sorts by name descending', async () => {
    const list = await Query.autoTriggers(null, { entityType: 'change' }, ctxA)
    expect(list.map((t) => t.id)).toEqual(['a2'])
    expect(queries[0]!.cypher).toMatch(/ORDER BY t\.name DESC/)
  })

  it('sorts only by whitelisted columns: an unknown sort field falls back to the default', async () => {
    await Query.autoTriggers(null, { sortField: 'executionCount', sortDirection: 'asc' }, ctxA)
    expect(queries[0]!.cypher).toMatch(/ORDER BY t\.execution_count ASC/)
    await Query.autoTriggers(null, { sortField: 't.name; DETACH DELETE t', sortDirection: 'asc' }, ctxA)
    // Why: the sort field is user input interpolated into Cypher.
    expect(queries[1]!.cypher).toMatch(/ORDER BY t\.name ASC/)
    expect(queries[1]!.cypher).not.toContain('DETACH')
  })

  it('advanced filters become a parameterised WHERE, and a field outside the whitelist fails loud', async () => {
    const filters = JSON.stringify({ rules: [{ field: 'name', operator: 'contains', value: 'Esc', logic: 'AND' }] })
    await Query.autoTriggers(null, { filters }, ctxA)
    expect(queries[0]!.cypher).toMatch(/WHERE true\s+AND \(.*t\.name/)
    expect(Object.values(queries[0]!.params)).toContain('Esc')
    await expect(Query.autoTriggers(null, { filters: JSON.stringify({ rules: [{ field: 'tenant_id', operator: 'equals', value: 'tenant-b', logic: 'AND' }] }) }, ctxA))
      .rejects.toThrow(/not allowed/)
  })
})

describe('createAutoTrigger', () => {
  const input = { name: 'Escalate', entityType: 'incident', eventType: 'on_create' }

  it('creates the node for the caller tenant, origin manual, enabled by default, and invalidates the cache', async () => {
    const t = await Mutation.createAutoTrigger(null, { input: { ...input, origin: 'ai_proposal' } as never }, ctxA)
    expect(t).toMatchObject({ name: 'Escalate', entityType: 'incident', enabled: true, executionCount: 0, origin: 'manual' })
    // Why: a person cannot declare their trigger «AI proposal» from the GraphQL input.
    expect(find('AutoTrigger', t.id, 'tenant-a')).toMatchObject({ tenant_id: 'tenant-a', origin: 'manual' })
    expect(invalidateTriggerCache).toHaveBeenCalledWith('tenant-a')
    expect(writeFlags).toEqual([true])
  })

  it('keeps an explicit enabled=false and a valid timer', async () => {
    const t = await Mutation.createAutoTrigger(null, { input: { ...input, eventType: 'on_timer', timerDelayMinutes: 30, enabled: false } }, ctxA)
    expect(t).toMatchObject({ enabled: false, timerDelayMinutes: 30 })
  })

  it('rejects a negative or fractional timer delay before writing', async () => {
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, timerDelayMinutes: -1 } }, ctxA)).rejects.toThrow(/Invalid timerDelayMinutes -1/)
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, timerDelayMinutes: 1.5 } }, ctxA)).rejects.toThrow(/non-negative integer/)
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, eventType: 'on_timer', timerDelayMinutes: 0 } }, ctxA)).rejects.toThrow(/requires timerDelayMinutes > 0/)
    expect(nodes.size).toBe(0)
  })

  it('rejects an event that never runs for that ticket type, and «is changed» on a creation', async () => {
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, entityType: 'change', eventType: 'on_update' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.automation.eventNotSupported' } } })
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, conditions: '[{"field":"urgency","operator":"changed"}]' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.automation.changedNeedsUpdate' } } })
    expect(nodes.size).toBe(0)
  })

  it('rejects a notification to a role the tenant does not have', async () => {
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, actions: '[{"type":"create_notification","params":{"target":"role:ghost_team"}}]' } }, ctxA))
      .rejects.toThrow(/ghost_team/)
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, actions: '[{"type":"create_notification","params":{"target":"role:service_desk"}}]' } }, ctxA))
      .resolves.toMatchObject({ name: 'Escalate' })
  })

  it('validates step targets against the tenant workflow before creating', async () => {
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, actions: '[{"type":"transition_workflow","params":{"to_step":"approved"}}]' } }, ctxA))
      .rejects.toThrow(/names the step "approved"/)
    expect(nodes.size).toBe(0)
  })

  it('set_priority on an incident is validated against severity, where the incident priority lives', async () => {
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, actions: '[{"type":"set_priority","params":{"priority":"high"}}]' } }, ctxA))
      .resolves.toBeTruthy()
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, actions: '[{"type":"set_priority","params":{"value":"urgent"}}]' } }, ctxA))
      .rejects.toThrow(/"urgent" is not a value of the field "severity"/)
    // Other ticket types have a real `priority` field in the metamodel.
    await expect(Mutation.createAutoTrigger(null, { input: { ...input, entityType: 'problem', actions: '[{"type":"set_priority","params":{"priority":"p1"}}]' } }, ctxA))
      .resolves.toBeTruthy()
  })
})

describe('updateAutoTrigger', () => {
  beforeEach(() => {
    seed('AutoTrigger', { id: 'a1', tenant_id: 'tenant-a', name: 'Old', entity_type: 'incident', event_type: 'on_update', conditions: '[{"field":"urgency","operator":"changed"}]', enabled: false })
    seed('AutoTrigger', { id: 'ai1', tenant_id: 'tenant-a', name: 'From AI', entity_type: 'incident', event_type: 'on_create', origin: 'ai_proposal', actions: '[{"type":"call_webhook","params":{}}]', enabled: false })
    seed('AutoTrigger', { id: 'b1', tenant_id: 'tenant-b', name: 'Theirs', entity_type: 'incident', event_type: 'on_create' })
  })

  it('writes the GraphQL fields to their node properties and invalidates the cache', async () => {
    const t = await Mutation.updateAutoTrigger(null, { id: 'a1', input: { name: 'New', timerDelayMinutes: 5, enabled: true } }, ctxA)
    expect(t).toMatchObject({ name: 'New', timerDelayMinutes: 5, enabled: true })
    expect(find('AutoTrigger', 'a1', 'tenant-a')).toMatchObject({ name: 'New', timer_delay_minutes: 5, enabled: true })
    expect(find('AutoTrigger', 'a1', 'tenant-a')!['updated_at']).toEqual(expect.any(String))
    expect(invalidateTriggerCache).toHaveBeenCalledWith('tenant-a')
  })

  it('changing the event alone re-checks «is changed» against the STORED conditions', async () => {
    // Why: the stored condition only works on updates; moving the trigger to on_create would make it dead.
    await expect(Mutation.updateAutoTrigger(null, { id: 'a1', input: { eventType: 'on_create' } }, ctxA))
      .rejects.toThrow(/only works when the ticket is updated/)
    expect(find('AutoTrigger', 'a1', 'tenant-a')!['event_type']).toBe('on_update')
    // New conditions together with the new event: the check uses the new pair.
    await expect(Mutation.updateAutoTrigger(null, { id: 'a1', input: { eventType: 'on_create', conditions: null } }, ctxA))
      .resolves.toMatchObject({ eventType: 'on_create', conditions: null })
  })

  it('changing the conditions alone re-checks them against the STORED event', async () => {
    seed('AutoTrigger', { id: 'c1', tenant_id: 'tenant-a', name: 'Create', entity_type: 'incident', event_type: 'on_create' })
    await expect(Mutation.updateAutoTrigger(null, { id: 'c1', input: { conditions: '[{"field":"urgency","operator":"changed"}]' } }, ctxA))
      .rejects.toThrow(/not on on_create/)
  })

  it('the event must run for the STORED entity type (it cannot be changed)', async () => {
    seed('AutoTrigger', { id: 'ch1', tenant_id: 'tenant-a', name: 'Chg', entity_type: 'change', event_type: 'on_create' })
    await expect(Mutation.updateAutoTrigger(null, { id: 'ch1', input: { eventType: 'on_field_change' } }, ctxA))
      .rejects.toThrow(/does not run for "change"/)
  })

  it('new actions are validated against the stored entity type workflow and the tenant roles', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'a1', input: { actions: '[{"type":"transition_workflow","params":{"to_step":"nowhere"}}]' } }, ctxA))
      .rejects.toThrow(/names the step "nowhere"/)
    await expect(Mutation.updateAutoTrigger(null, { id: 'a1', input: { actions: '[{"type":"create_notification","params":{"target":"role:ghost_team"}}]' } }, ctxA))
      .rejects.toThrow(/ghost_team/)
    await expect(Mutation.updateAutoTrigger(null, { id: 'a1', input: { actions: '[{"type":"transition_workflow","params":{"to_step":"resolved"}}]' } }, ctxA))
      .resolves.toMatchObject({ actions: '[{"type":"transition_workflow","params":{"to_step":"resolved"}}]' })
  })

  it('another tenant\'s trigger is «not found» on the validation reads', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'b1', input: { eventType: 'on_create' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    await expect(Mutation.updateAutoTrigger(null, { id: 'b1', input: { conditions: null } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    expect(find('AutoTrigger', 'b1', 'tenant-b')!['name']).toBe('Theirs')
  })

  it('a plain rename of a trigger that is not there (deleted, or another tenant) is «not found», not a crash', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'b1', input: { name: 'Hijacked' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    expect(find('AutoTrigger', 'b1', 'tenant-b')!['name']).toBe('Theirs')
  })

  it('turning on an AI-proposal trigger re-runs the restricted allowlist on the actions it will have', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'ai1', input: { enabled: true } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.automation.originActionsForbidden' } } })
    expect(find('AutoTrigger', 'ai1', 'tenant-a')!['enabled']).toBe(false)
    // Replacing the forbidden action in the same update is judged on the NEW actions.
    await expect(Mutation.updateAutoTrigger(null, { id: 'ai1', input: { enabled: true, actions: '[{"type":"create_comment","params":{"text":"x"}}]' } }, ctxA))
      .resolves.toMatchObject({ enabled: true, origin: 'ai_proposal' })
  })

  it('turning on a manual trigger is not restricted by the allowlist', async () => {
    seed('AutoTrigger', { id: 'm1', tenant_id: 'tenant-a', name: 'Manual', entity_type: 'incident', event_type: 'on_create', actions: '[{"type":"call_webhook","params":{}}]', enabled: false })
    await expect(Mutation.updateAutoTrigger(null, { id: 'm1', input: { enabled: true } }, ctxA)).resolves.toMatchObject({ enabled: true })
  })
})

describe('updateAutoTrigger — a timed trigger always keeps its delay', () => {
  // A timed trigger with no delay fires at once or never. Until 23 Sep 2026
  // only the create checked it: an update could make a trigger timed without
  // a delay, or clear the delay of a timed one, and the page said «saved».
  beforeEach(() => {
    seed('AutoTrigger', { id: 'tm', tenant_id: 'tenant-a', name: 'Timer', entity_type: 'incident', event_type: 'on_timer', timer_delay_minutes: 30 })
    seed('AutoTrigger', { id: 'up', tenant_id: 'tenant-a', name: 'Update', entity_type: 'incident', event_type: 'on_create', timer_delay_minutes: null })
  })

  it('refuses to clear or zero the delay of a timed trigger, and writes nothing', async () => {
    for (const timerDelayMinutes of [null, 0]) {
      await expect(Mutation.updateAutoTrigger(null, { id: 'tm', input: { timerDelayMinutes } }, ctxA))
        .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.automation.timerDelayRequired' } } })
    }
    expect(find('AutoTrigger', 'tm', 'tenant-a')!['timer_delay_minutes']).toBe(30)
  })

  it('refuses to switch a trigger to timed when it has no delay, stored or sent', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'up', input: { eventType: 'on_timer' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.automation.timerDelayRequired' } } })
    expect(find('AutoTrigger', 'up', 'tenant-a')!['event_type']).toBe('on_create')
  })

  it('accepts the switch when the delay comes with it, and a new positive delay', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'up', input: { eventType: 'on_timer', timerDelayMinutes: 15 } }, ctxA))
      .resolves.toMatchObject({ eventType: 'on_timer', timerDelayMinutes: 15 })
    await expect(Mutation.updateAutoTrigger(null, { id: 'tm', input: { timerDelayMinutes: 45 } }, ctxA))
      .resolves.toMatchObject({ timerDelayMinutes: 45 })
  })

  it('a trigger that is not timed can drop its delay', async () => {
    await expect(Mutation.updateAutoTrigger(null, { id: 'tm', input: { eventType: 'on_create', timerDelayMinutes: null } }, ctxA))
      .resolves.toMatchObject({ eventType: 'on_create', timerDelayMinutes: null })
  })
})

describe('deleteAutoTrigger', () => {
  it('deletes only within the caller tenant and invalidates the cache', async () => {
    seed('AutoTrigger', { id: 'a1', tenant_id: 'tenant-a', name: 'x' })
    seed('AutoTrigger', { id: 'b1', tenant_id: 'tenant-b', name: 'y' })
    expect(await Mutation.deleteAutoTrigger(null, { id: 'b1' }, ctxA)).toBe(true)
    expect(find('AutoTrigger', 'b1', 'tenant-b')).toBeDefined()
    expect(await Mutation.deleteAutoTrigger(null, { id: 'a1' }, ctxA)).toBe(true)
    expect(find('AutoTrigger', 'a1', 'tenant-a')).toBeUndefined()
    expect(invalidateTriggerCache).toHaveBeenCalledWith('tenant-a')
  })
})

// ── Business rules ───────────────────────────────────────────────────────────

describe('businessRules (query) and reorder', () => {
  beforeEach(() => {
    seed('BusinessRule', { id: 'r1', tenant_id: 'tenant-a', name: 'First', entity_type: 'incident', event_type: 'on_create', priority: 10 })
    seed('BusinessRule', { id: 'r2', tenant_id: 'tenant-a', name: 'Second', entity_type: 'problem', event_type: 'on_create', priority: 20, stop_on_match: true, enabled: true })
    seed('BusinessRule', { id: 'rb', tenant_id: 'tenant-b', name: 'Theirs', entity_type: 'incident', event_type: 'on_create', priority: 1 })
  })

  it('lists this tenant only, defaults for old nodes, filters and sorts by whitelisted columns', async () => {
    const all = await Query.businessRules(null, {}, ctxA)
    expect(all.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(all.find((r) => r.id === 'r1')).toMatchObject({ conditionLogic: 'and', stopOnMatch: false, enabled: false, description: null, priority: 10 })
    expect(queries[0]!.cypher).toMatch(/ORDER BY r\.priority DESC/)
    const problems = await Query.businessRules(null, { entityType: 'problem', sortField: 'name', sortDirection: 'asc' }, ctxA)
    expect(problems.map((r) => r.id)).toEqual(['r2'])
    expect(queries[1]!.cypher).toMatch(/ORDER BY r\.name ASC/)
    await Query.businessRules(null, { filters: JSON.stringify({ rules: [{ field: 'priority', operator: 'equals', value: '10', logic: 'AND' }] }) }, ctxA)
    expect(queries[2]!.cypher).toMatch(/AND \(.*r\.priority/)
  })

  it('reorder assigns priority 1..n in the given order, only to this tenant\'s rules', async () => {
    const list = await Mutation.reorderBusinessRules(null, { ruleIds: ['r2', 'r1', 'rb'] }, ctxA)
    expect(find('BusinessRule', 'r2', 'tenant-a')!['priority']).toBe(1)
    expect(find('BusinessRule', 'r1', 'tenant-a')!['priority']).toBe(2)
    // Why: an id of another tenant in the list must not reorder their rules.
    expect(find('BusinessRule', 'rb', 'tenant-b')!['priority']).toBe(1)
    expect(list.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(invalidateRulesCache).toHaveBeenCalledWith('tenant-a')
  })
})

describe('createBusinessRule', () => {
  const input = { name: 'Rule', entityType: 'incident', eventType: 'on_create' }

  it('creates with defaults (and, priority 100, no stop, enabled) and invalidates the rules cache', async () => {
    const r = await Mutation.createBusinessRule(null, { input }, ctxA)
    expect(r).toMatchObject({ name: 'Rule', conditionLogic: 'and', priority: 100, stopOnMatch: false, enabled: true, description: null })
    expect(find('BusinessRule', r.id, 'tenant-a')).toMatchObject({ tenant_id: 'tenant-a' })
    expect(invalidateRulesCache).toHaveBeenCalledWith('tenant-a')
    expect(invalidateTriggerCache).not.toHaveBeenCalled()
  })

  it('keeps the explicit values', async () => {
    const r = await Mutation.createBusinessRule(null, { input: { ...input, description: 'd', conditionLogic: 'or', priority: 5, stopOnMatch: true, enabled: false } }, ctxA)
    expect(r).toMatchObject({ description: 'd', conditionLogic: 'or', priority: 5, stopOnMatch: true, enabled: false })
  })

  it('rejects unsupported event × ticket, «is changed» on creation, unknown roles and step targets', async () => {
    await expect(Mutation.createBusinessRule(null, { input: { ...input, entityType: 'change', eventType: 'on_update' } }, ctxA)).rejects.toThrow(/does not run for "change"/)
    await expect(Mutation.createBusinessRule(null, { input: { ...input, conditions: '[{"field":"x","operator":"changed"}]' } }, ctxA)).rejects.toThrow(/is changed/)
    await expect(Mutation.createBusinessRule(null, { input: { ...input, actions: '[{"type":"create_notification","params":{"target":"role:ghost_team"}}]' } }, ctxA)).rejects.toThrow(/ghost_team/)
    await expect(Mutation.createBusinessRule(null, { input: { ...input, conditions: '[{"field":"status","operator":"equals","value":"closed"}]' } }, ctxA)).rejects.toThrow(/names the step "closed"/)
    expect(nodes.size).toBe(0)
  })
})

describe('updateBusinessRule', () => {
  beforeEach(() => {
    seed('BusinessRule', { id: 'r1', tenant_id: 'tenant-a', name: 'Old', entity_type: 'incident', event_type: 'on_update', conditions: '[{"field":"x","operator":"changed"}]', priority: 10 })
    seed('BusinessRule', { id: 'rb', tenant_id: 'tenant-b', name: 'Theirs', entity_type: 'incident', event_type: 'on_create' })
  })

  it('maps every GraphQL field to its property and invalidates the rules cache', async () => {
    const r = await Mutation.updateBusinessRule(null, { id: 'r1', input: { name: 'N', description: 'D', conditionLogic: 'or', priority: 3, stopOnMatch: true, enabled: true } }, ctxA)
    expect(r).toMatchObject({ name: 'N', description: 'D', conditionLogic: 'or', priority: 3, stopOnMatch: true, enabled: true })
    expect(find('BusinessRule', 'r1', 'tenant-a')).toMatchObject({ condition_logic: 'or', stop_on_match: true })
    expect(invalidateRulesCache).toHaveBeenCalledWith('tenant-a')
  })

  it('validates enums and the new event against stored conditions and entity type', async () => {
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { conditionLogic: 'xor' } }, ctxA)).rejects.toThrow(/Invalid conditionLogic/)
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { eventType: 'on_timer' } }, ctxA)).rejects.toThrow(/Invalid eventType/)
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { eventType: 'on_transition' } }, ctxA)).rejects.toThrow(/not on on_transition/)
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { eventType: 'on_transition', conditions: '' } }, ctxA))
      .resolves.toMatchObject({ eventType: 'on_transition', conditions: null })
  })

  it('new actions: roles and step targets of the stored entity type', async () => {
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { actions: '[{"type":"create_notification","params":{"target":"role:ghost_team"}}]' } }, ctxA)).rejects.toThrow(/ghost_team/)
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { actions: '[{"type":"transition_workflow","params":{"to_step":"gone"}}]' } }, ctxA)).rejects.toThrow(/"gone"/)
    await expect(Mutation.updateBusinessRule(null, { id: 'r1', input: { actions: '[{"type":"transition_workflow","params":{"to_step":"new"}}]' } }, ctxA)).resolves.toBeTruthy()
  })

  it('another tenant\'s rule is «not found», on the validation reads and on a plain rename', async () => {
    await expect(Mutation.updateBusinessRule(null, { id: 'rb', input: { eventType: 'on_update' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    await expect(Mutation.updateBusinessRule(null, { id: 'rb', input: { actions: null } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    await expect(Mutation.updateBusinessRule(null, { id: 'rb', input: { name: 'Hijacked' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    expect(find('BusinessRule', 'rb', 'tenant-b')!['name']).toBe('Theirs')
  })
})

describe('deleteBusinessRule', () => {
  it('deletes only within the caller tenant and invalidates the rules cache', async () => {
    seed('BusinessRule', { id: 'rb', tenant_id: 'tenant-b', name: 'y' })
    expect(await Mutation.deleteBusinessRule(null, { id: 'rb' }, ctxA)).toBe(true)
    expect(find('BusinessRule', 'rb', 'tenant-b')).toBeDefined()
    expect(await Mutation.deleteBusinessRule(null, { id: 'rb' }, ctxB)).toBe(true)
    expect(find('BusinessRule', 'rb', 'tenant-b')).toBeUndefined()
    expect(invalidateRulesCache).toHaveBeenCalledWith('tenant-b')
  })
})

// ── SLA policies ─────────────────────────────────────────────────────────────

describe('slaPolicies (query)', () => {
  it('lists this tenant with the team name of the same tenant, filters and sorts', async () => {
    seed('SLAPolicyNode', { id: 'p1', tenant_id: 'tenant-a', name: 'Net', entity_type: 'incident', team_id: 'tm1', response_minutes: 30, resolve_minutes: 240, warning_minutes: 20, compliance_target: 95, compliance_warning: 90, calendar_id: 'cal1', business_hours: true })
    seed('SLAPolicyNode', { id: 'p2', tenant_id: 'tenant-a', name: 'Old', entity_type: 'problem' })
    seed('SLAPolicyNode', { id: 'pb', tenant_id: 'tenant-b', name: 'Theirs', entity_type: 'incident' })
    teams.set('tenant-a:tm1', 'Network team')
    const list = await Query.slaPolicies(null, {}, ctxA)
    expect(list.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(list.find((p) => p.id === 'p1')).toMatchObject({ teamName: 'Network team', responseMinutes: 30, complianceTarget: 95, complianceWarning: 90, calendarId: 'cal1', businessHours: true, enabled: true })
    // An old node: no compliance objective is null (not 0), enabled unless switched off.
    expect(list.find((p) => p.id === 'p2')).toMatchObject({ complianceTarget: null, complianceWarning: null, responseMinutes: 0, timezone: null, teamName: null, enabled: true, calendarId: null })
    expect(queries[0]!.cypher).toMatch(/ORDER BY p\.entity_type DESC/)
    await Query.slaPolicies(null, { entityType: 'problem', sortField: 'resolveMinutes', sortDirection: 'asc', filters: JSON.stringify({ rules: [{ field: 'name', operator: 'equals', value: 'Old', logic: 'AND' }] }) }, ctxA)
    expect(queries[1]!.cypher).toMatch(/ORDER BY p\.resolve_minutes ASC/)
    expect(queries[1]!.cypher).toMatch(/AND \(.*p\.name/)
  })
})

describe('createSLAPolicy', () => {
  const input = { name: 'P', entityType: 'incident', responseMinutes: 60, resolveMinutes: 240, complianceTarget: 95, complianceWarning: 90 }

  it('creates with the default warning, 24×7 without a calendar, for this tenant', async () => {
    const p = await Mutation.createSLAPolicy(null, { input }, ctxA)
    expect(p).toMatchObject({ warningMinutes: 30, businessHours: false, calendarId: null, priority: null, category: null, teamId: null, enabled: true })
    expect(find('SLAPolicyNode', p.id, 'tenant-a')).toMatchObject({ tenant_id: 'tenant-a' })
  })

  it('a calendar of this tenant switches on business hours; another tenant\'s calendar is refused', async () => {
    calendars.set('tenant-a:cal1', 'Office')
    calendars.set('tenant-b:calB', 'Theirs')
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, calendarId: 'cal1', timezone: ' Europe/Rome ' } }, ctxA))
      .resolves.toMatchObject({ calendarId: 'cal1', businessHours: true, timezone: 'Europe/Rome' })
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, calendarId: 'calB' } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceCalendar.unknown' } } })
  })

  it('a response of zero, or later than the resolution, is refused and nothing is created', async () => {
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, responseMinutes: 0 } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.minutesPositive', params: { field: 'responseMinutes' } } } })
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, responseMinutes: 500 } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.responseAfterResolve' } } })
  })

  it('the warning must be a positive whole number shorter than the resolution time', async () => {
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, warningMinutes: 0 } }, ctxA)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.warningMinutes' } } })
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, warningMinutes: 2.5 } }, ctxA)).rejects.toThrow(/positive whole number/)
    // Why: a warning as long as the resolution time would fire already expired.
    await expect(Mutation.createSLAPolicy(null, { input: { ...input, warningMinutes: 240 } }, ctxA)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.warningLongerThanResolve' } } })
    expect(nodes.size).toBe(0)
  })
})

describe('updateSLAPolicy', () => {
  beforeEach(() => {
    seed('SLAPolicyNode', { id: 'p1', tenant_id: 'tenant-a', name: 'P', entity_type: 'incident', response_minutes: 60, resolve_minutes: 240, warning_minutes: 30, compliance_target: 95, compliance_warning: 90, business_hours: false, calendar_id: null })
    seed('SLAPolicyNode', { id: 'pr', tenant_id: 'tenant-a', name: 'Req', entity_type: 'change', resolve_minutes: 100, warning_minutes: 10 })
  })

  it('maps the GraphQL fields onto the node properties', async () => {
    const p = await Mutation.updateSLAPolicy(null, { id: 'p1', input: { name: 'N', priority: 'high', teamId: 'tm9', responseMinutes: 15, enabled: false } }, ctxA)
    expect(p).toMatchObject({ name: 'N', priority: 'high', teamId: 'tm9', responseMinutes: 15, enabled: false })
    expect(find('SLAPolicyNode', 'p1', 'tenant-a')).toMatchObject({ team_id: 'tm9', response_minutes: 15 })
  })

  it('a new resolution time is checked against the STORED warning, and vice versa', async () => {
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { resolveMinutes: 20 } }, ctxA)).rejects.toThrow(/must be shorter than the resolution time \(20 min\)/)
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { warningMinutes: 300 } }, ctxA)).rejects.toThrow(/\(240 min\)/)
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { warningMinutes: 60, resolveMinutes: 120 } }, ctxA))
      .resolves.toMatchObject({ warningMinutes: 60, resolveMinutes: 120 })
  })

  // Review of 23 Sep 2026: response 0 was stored, and the SLA selector then threw for every ticket it matched.
  it('response and resolution are positive whole minutes, the response no later than the resolution', async () => {
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { responseMinutes: 0 } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.minutesPositive', params: { field: 'responseMinutes' } } } })
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { responseMinutes: 300 } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.responseAfterResolve', params: { response: 300, resolve: 240 } } } })
    expect(find('SLAPolicyNode', 'p1', 'tenant-a')).toMatchObject({ response_minutes: 60, resolve_minutes: 240 })
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { responseMinutes: 90 } }, ctxA)).resolves.toMatchObject({ responseMinutes: 90 })
  })

  it('the minutes can be changed but never emptied: an explicit null is refused and nothing is written', async () => {
    // Before 23 Sep 2026 a null passed the warning check (it fell back to the
    // stored value) and was then written: the policy lost its resolution time.
    for (const field of ['responseMinutes', 'resolveMinutes', 'warningMinutes']) {
      await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { [field]: null } }, ctxA))
        .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.minutesRequired', params: { field } } } })
    }
    expect(find('SLAPolicyNode', 'p1', 'tenant-a')).toMatchObject({ response_minutes: 60, resolve_minutes: 240, warning_minutes: 30 })
  })

  it('a category is checked against the stored entity type', async () => {
    // A stored change policy (written before the scope rule) cannot gain a category.
    await expect(Mutation.updateSLAPolicy(null, { id: 'pr', input: { category: 'network' } }, ctxA)).rejects.toThrow(/"change" has no SLA/)
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { category: 'network' } }, ctxA)).resolves.toMatchObject({ category: 'network' })
  })

  it('calendar: an explicit null goes back to 24×7, an id of this tenant turns on business hours', async () => {
    calendars.set('tenant-a:cal1', 'Office')
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { calendarId: 'cal1' } }, ctxA)).resolves.toMatchObject({ calendarId: 'cal1', businessHours: true })
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { calendarId: null } }, ctxA)).resolves.toMatchObject({ calendarId: null, businessHours: false })
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { calendarId: 'nope' } }, ctxA)).rejects.toThrow(/does not exist/)
  })

  it('compliance: a single new value is validated together with the stored other one', async () => {
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { complianceWarning: 97 } }, ctxA)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.compliance.warning' } } })
    await expect(Mutation.updateSLAPolicy(null, { id: 'p1', input: { complianceTarget: 99 } }, ctxA)).resolves.toMatchObject({ complianceTarget: 99, complianceWarning: 90 })
  })

  it('another tenant\'s policy is not touched: the update reports «not found»', async () => {
    seed('SLAPolicyNode', { id: 'pb', tenant_id: 'tenant-b', name: 'Theirs', entity_type: 'incident', resolve_minutes: 100 })
    await expect(Mutation.updateSLAPolicy(null, { id: 'pb', input: { name: 'Hijacked', category: 'x', warningMinutes: 10 } }, ctxA))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
    expect(find('SLAPolicyNode', 'pb', 'tenant-b')!['name']).toBe('Theirs')
  })
})

describe('deleteSLAPolicy and calendarName', () => {
  it('deletes only within the tenant', async () => {
    seed('SLAPolicyNode', { id: 'pb', tenant_id: 'tenant-b', name: 'Theirs' })
    expect(await Mutation.deleteSLAPolicy(null, { id: 'pb' }, ctxA)).toBe(true)
    expect(find('SLAPolicyNode', 'pb', 'tenant-b')).toBeDefined()
    await Mutation.deleteSLAPolicy(null, { id: 'pb' }, ctxB)
    expect(find('SLAPolicyNode', 'pb', 'tenant-b')).toBeUndefined()
  })

  it('reads the live calendar name of this tenant, null for 24×7', async () => {
    calendars.set('tenant-a:cal1', 'Office (renamed)')
    expect(await SLAPolicyNode.calendarName({ calendarId: 'cal1' }, null, ctxA)).toBe('Office (renamed)')
    expect(await SLAPolicyNode.calendarName({ calendarId: 'cal1' }, null, ctxB)).toBeNull()
    expect(await SLAPolicyNode.calendarName({ calendarId: null }, null, ctxA)).toBeNull()
  })
})

/**
 * The closed action catalogue behind improvement proposals: the parts the
 * first test file does not reach.
 *
 * Why these behaviours matter to a user:
 *  - "Undo" on an accepted proposal must restore EXACTLY what was there,
 *    including the stale severities (a restore that re-validated them would
 *    silently drop them), and must refuse loudly when the saved state is
 *    unreadable instead of writing an empty list over the portal.
 *  - A tenant that vanished between proposal and click is a NotFound, not a
 *    green "done" that changed nothing.
 *  - `automation.create_disabled` is the only action that CREATES something.
 *    It must be born disabled, tagged `origin: 'ai_proposal'`, scoped to the
 *    tenant, and its undo must delete only a rule that is still of that
 *    origin — otherwise undo could take away a rule someone adopted.
 *  - Every invalid parameter (name, ticket type, event, unsupported
 *    event/ticket pair, forbidden nested action) is refused BEFORE anything is
 *    written: a rule "on update of a change" would be saved and never run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  options: null as Array<{ value: string; labels: Record<string, string> }> | null,
  vocabulary: [] as string[],
  tenantFound: true,
  runs: [] as Array<{ q: string; p: Record<string, unknown> }>,
  modes: [] as Array<string | undefined>,
  closes: 0,
  writes: [] as Array<Record<string, unknown>>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: (_db?: string, mode?: string) => {
    state.modes.push(mode)
    return {
      run: async (q: string, p: Record<string, unknown>) => { state.runs.push({ q, p }); return { records: [] } },
      close: async () => { state.closes++ },
    }
  },
}))
vi.mock('../db.js', () => ({
  runQueryOne: async (_s: unknown, _q: string, p: Record<string, unknown>) => {
    state.writes.push(p)
    return state.tenantFound ? { id: p['tenantId'] } : null
  },
}))
vi.mock('../portalSeverityOptions.js', () => ({
  PORTAL_SEVERITY_VOCABULARY: 'severity',
  portalSeverityOptions: async () => state.options,
}))
vi.mock('../domainMatrix.js', () => ({ domainVocabulary: async () => state.vocabulary }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const invalidateTriggerCache = vi.fn()
vi.mock('../triggerEngine.js', () => ({ invalidateTriggerCache: (t: string) => invalidateTriggerCache(t) }))
const riempiEtichette = vi.fn(async () => ({ details: { filled: 1 }, undoState: { x: 1 } }))
const ripristinaEtichette = vi.fn(async () => undefined)
vi.mock('../configurationAssistActions.js', () => ({
  riempiEtichette: (...a: unknown[]) => riempiEtichette(...(a as [])),
  ripristinaEtichette: (...a: unknown[]) => ripristinaEtichette(...(a as [])),
}))

const { eseguiAzione, disfaAzione, azioneDisfabile } = await import('../proposalActions.js')

beforeEach(() => {
  state.options = null
  state.vocabulary = []
  state.tenantFound = true
  state.runs = []
  state.modes = []
  state.closes = 0
  state.writes = []
  vi.clearAllMocks()
})

const opt = (...v: string[]) => v.map((value) => ({ value, labels: {} }))

describe('portal_severities.remove_stale — edges and undo', () => {
  it('refuses when the portal has no severities at all (null or empty): nothing is stale', async () => {
    state.options = null
    await expect(eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} }))
      .rejects.toThrow(/no severities set/)
    state.options = []
    await expect(eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} }))
      .rejects.toThrow(/no severities set/)
    expect(state.writes).toHaveLength(0)
  })

  it('writes only the kept options, scoped to the tenant, in a WRITE session that is closed', async () => {
    state.options = opt('low', 'blocker')
    state.vocabulary = ['low']
    await eseguiAzione('t1', { type: 'portal_severities.remove_stale', params: {} })
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]!['tenantId']).toBe('t1')
    expect(JSON.parse(String(state.writes[0]!['options']))).toEqual([{ value: 'low', labels: {} }])
    expect(state.modes).toEqual(['WRITE'])
    expect(state.closes).toBe(1)
  })

  it('a tenant that no longer exists is a NotFound, not a silent success', async () => {
    state.options = opt('low', 'blocker')
    state.vocabulary = ['low']
    state.tenantFound = false
    await expect(eseguiAzione('gone', { type: 'portal_severities.remove_stale', params: {} }))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    // The session is closed even when the write finds nothing.
    expect(state.closes).toBe(1)
  })

  it('undo rewrites EXACTLY the saved raw state, stale values included', async () => {
    const saved = JSON.stringify(opt('low', 'blocker'))
    await disfaAzione('t1', 'portal_severities.remove_stale', { options: saved })
    // Byte-for-byte: a restore that re-validated would drop "blocker" again.
    expect(state.writes[0]!['options']).toBe(saved)
    expect(state.writes[0]!['tenantId']).toBe('t1')
  })

  it('undo with an unreadable saved state refuses and writes nothing', async () => {
    await expect(disfaAzione('t1', 'portal_severities.remove_stale', {})).rejects.toThrow(/unreadable/)
    await expect(disfaAzione('t1', 'portal_severities.remove_stale', { options: '' })).rejects.toThrow(/unreadable/)
    await expect(disfaAzione('t1', 'portal_severities.remove_stale', { options: 42 })).rejects.toThrow(/unreadable/)
    expect(state.writes).toHaveLength(0)
  })

  it('undo of a type outside the catalogue is refused before touching anything', async () => {
    await expect(disfaAzione('t1', 'drop_database', { options: '[]' })).rejects.toThrow(/closed catalogue/)
    expect(state.writes).toHaveLength(0)
  })
})

describe('automation.create_disabled', () => {
  const good = {
    name: '  Escalate stale incidents  ',
    entityType: 'incident',
    eventType: 'on_update',
    actions: JSON.stringify([{ type: 'assign_team', params: { teamId: 'tm-1' } }]),
    conditions: '[]',
  }

  it('creates a DISABLED rule with origin ai_proposal, scoped to the tenant, and forgets the trigger cache', async () => {
    const out = await eseguiAzione('t1', { type: 'automation.create_disabled', params: good })
    expect(state.runs).toHaveLength(1)
    const { q, p } = state.runs[0]!
    // The two properties that make an AI-created rule acceptable.
    expect(q).toContain('enabled: false')
    expect(q).toContain("origin: 'ai_proposal'")
    expect(p['tenantId']).toBe('t1')
    expect(p['nome']).toBe('Escalate stale incidents')
    expect(p['conditions']).toBe('[]')
    expect(state.modes).toEqual(['WRITE'])
    expect(state.closes).toBe(1)
    // Without this the engine keeps evaluating the old rule set.
    expect(invalidateTriggerCache).toHaveBeenCalledWith('t1')
    expect(out.details).toMatchObject({ name: 'Escalate stale incidents', entityType: 'incident', eventType: 'on_update', enabled: false })
    expect(out.undoState).toEqual({ automationId: out.details['automationId'], name: 'Escalate stale incidents' })
  })

  it('missing actions and conditions are stored as null, not as the string "undefined"', async () => {
    await eseguiAzione('t1', { type: 'automation.create_disabled', params: { name: 'x', entityType: 'change', eventType: 'on_create' } })
    expect(state.runs[0]!.p['actions']).toBeNull()
    expect(state.runs[0]!.p['conditions']).toBeNull()
  })

  it.each([
    [{ ...good, name: '   ' }, /no name/],
    [{ ...good, name: undefined }, /no name/],
    [{ ...good, entityType: 'ci' }, /not a ticket type/],
    [{ ...good, entityType: undefined }, /not a ticket type/],
    [{ ...good, eventType: 'on_whim' }, /not an automation event/],
    [{ ...good, eventType: undefined }, /not an automation event/],
    // A change has no field update: the rule would be saved and never run (AU-1).
    [{ ...good, entityType: 'change', eventType: 'on_update' }, /does not run on "on_update"/],
    // Outside the restricted allowlist, even though it is a legal action elsewhere.
    [{ ...good, actions: JSON.stringify([{ type: 'send_notification' }]) }, /may only contain/],
  ])('invalid parameters are refused before any write (%#)', async (params, msg) => {
    await expect(eseguiAzione('t1', { type: 'automation.create_disabled', params: params as Record<string, unknown> }))
      .rejects.toThrow(msg)
    expect(state.runs).toHaveLength(0)
    expect(invalidateTriggerCache).not.toHaveBeenCalled()
  })

  it('undo deletes only that rule, only in that tenant, and only while it is still of ai_proposal origin', async () => {
    await disfaAzione('t1', 'automation.create_disabled', { automationId: 'au-1', name: 'x' })
    const { q, p } = state.runs[0]!
    expect(p).toEqual({ tenantId: 't1', id: 'au-1' })
    // If someone adopted the rule (origin changed), undo must not take it away.
    expect(q).toContain("a.origin = 'ai_proposal'")
    expect(q).toContain('DETACH DELETE a')
    expect(state.closes).toBe(1)
    expect(invalidateTriggerCache).toHaveBeenCalledWith('t1')
  })

  it('undo without an automation id does nothing at all', async () => {
    await disfaAzione('t1', 'automation.create_disabled', {})
    expect(state.runs).toHaveLength(0)
    expect(invalidateTriggerCache).not.toHaveBeenCalled()
  })

  it('is undoable, so the page offers the button', () => {
    expect(azioneDisfabile('automation.create_disabled')).toBe(true)
  })
})

describe('enum_value_labels.fill is routed to its own executor', () => {
  it('execute and undo reach the label-filling module with the tenant', async () => {
    const out = await eseguiAzione('t1', { type: 'enum_value_labels.fill', params: { enumName: 'priority' } })
    expect(out).toEqual({ details: { filled: 1 }, undoState: { x: 1 } })
    expect(riempiEtichette).toHaveBeenCalledWith('t1', { enumName: 'priority' })
    await disfaAzione('t1', 'enum_value_labels.fill', { x: 1 })
    expect(ripristinaEtichette).toHaveBeenCalledWith('t1', { x: 1 })
  })
})

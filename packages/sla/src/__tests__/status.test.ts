import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Neo4j mock: capture the Cypher + params of every write ───────────────────

interface Call { cypher: string; params: Record<string, unknown> }
const writes: Call[] = []
let currentStatus: Record<string, unknown> | null = null

const session = { close: vi.fn(async () => {}) }
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => session,
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    writes.push({ cypher, params })
    return []
  }),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('SET s.resolve_met')) {
      writes.push({ cypher, params })
      // Echo what the Cypher CASE would produce, so the mapped result is realistic.
      const met = params['met'] as boolean
      return { ...currentStatus, resolve_met: met, breached: met ? currentStatus?.['breached'] ?? false : true,
               resolved_at: params['resolvedAt'], paused_at: null, paused_type: null }
    }
    if (cypher.includes('RETURN e.created_at')) return currentStatus ? { created_at: currentStatus['created_at'] } : null
    return currentStatus
  }),
}))

const { markResolveMet, getEntityCreatedAt } = await import('../status.js')

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sla-1', tenant_id: 't1', entity_id: 'inc-1', entity_type: 'incident',
    started_at: '2026-05-01T09:00:00.000Z',
    response_deadline: '2026-05-01T10:00:00.000Z',
    resolve_deadline:  '2026-05-01T17:00:00.000Z',
    response_met: true, resolve_met: false, breached: false,
    paused_at: null, paused_type: null,
    tier_severity: 'high', tier_response_minutes: 60, tier_resolve_minutes: 480, tier_business_hours: false,
    ...overrides,
  }
}

beforeEach(() => { writes.length = 0; currentStatus = null })

describe('markResolveMet — outcome semantics (D-02)', () => {
  it('resolved before the deadline → resolve_met=true, breached untouched', async () => {
    currentStatus = status()
    const out = await markResolveMet('t1', 'inc-1', new Date('2026-05-01T12:00:00.000Z'))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.params['met']).toBe(true)
    expect(writes[0]!.params['resolvedAt']).toBe('2026-05-01T12:00:00.000Z')
    expect(out?.resolve_met).toBe(true)
    expect(out?.breached).toBe(false)
    expect(out?.resolved_at).toBe('2026-05-01T12:00:00.000Z')
  })

  it('resolved after the deadline → resolve_met=false and breached=true (late resolution is NOT compliance)', async () => {
    currentStatus = status({ breached: true })
    const out = await markResolveMet('t1', 'inc-1', new Date('2026-05-01T18:30:00.000Z'))
    expect(writes[0]!.params['met']).toBe(false)
    expect(out?.resolve_met).toBe(false)
    expect(out?.breached).toBe(true)
  })

  it('never clears breached: the Cypher has no "breached = false" assignment', async () => {
    currentStatus = status({ breached: true })
    await markResolveMet('t1', 'inc-1', new Date('2026-05-01T12:00:00.000Z'))
    expect(writes[0]!.cypher).not.toMatch(/breached\s*=\s*false/)
    expect(writes[0]!.cypher).toMatch(/s\.resolved_at\s*=\s*\$resolvedAt/)
  })

  it('a pause still open at resolution extends the deadline by its duration', async () => {
    // deadline 17:00, paused at 12:00, resolved 18:00 → effective deadline 23:00 → met
    currentStatus = status({ paused_at: '2026-05-01T12:00:00.000Z', paused_type: 'resolve' })
    await markResolveMet('t1', 'inc-1', new Date('2026-05-01T18:00:00.000Z'))
    expect(writes[0]!.params['met']).toBe(true)
    expect(writes[0]!.cypher).toMatch(/s\.paused_at\s*=\s*null/)
  })

  it('a response-only pause does not extend the resolve deadline', async () => {
    currentStatus = status({ paused_at: '2026-05-01T12:00:00.000Z', paused_type: 'response' })
    await markResolveMet('t1', 'inc-1', new Date('2026-05-01T18:00:00.000Z'))
    expect(writes[0]!.params['met']).toBe(false)
  })

  it('exactly at the deadline counts as met', async () => {
    currentStatus = status()
    await markResolveMet('t1', 'inc-1', new Date('2026-05-01T17:00:00.000Z'))
    expect(writes[0]!.params['met']).toBe(true)
  })

  it('returns null and writes nothing when the entity has no SLAStatus', async () => {
    currentStatus = null
    expect(await markResolveMet('t1', 'inc-1', new Date())).toBeNull()
    expect(writes).toHaveLength(0)
  })

  it('rejects an invalid resolvedAt loudly', async () => {
    currentStatus = status()
    await expect(markResolveMet('t1', 'inc-1', new Date('garbage'))).rejects.toThrow('not a valid instant')
  })
})

describe('getEntityCreatedAt (D-29)', () => {
  it('returns the node created_at as a Date', async () => {
    currentStatus = status({ created_at: '2026-05-01T08:00:00.000Z' })
    expect((await getEntityCreatedAt('t1', 'inc-1')).toISOString()).toBe('2026-05-01T08:00:00.000Z')
  })
  it('throws when the entity is missing or created_at is not an instant', async () => {
    currentStatus = null
    await expect(getEntityCreatedAt('t1', 'nope')).rejects.toThrow('not found')
    currentStatus = status({ created_at: null })
    await expect(getEntityCreatedAt('t1', 'inc-1')).rejects.toThrow('missing or not an ISO string')
    currentStatus = status({ created_at: 'yesterday' })
    await expect(getEntityCreatedAt('t1', 'inc-1')).rejects.toThrow('not a valid instant')
  })
})

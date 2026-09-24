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
    // E-2: anche il cambio di policy scrive con `runQueryOne`.
    if (cypher.includes('s.policy_id             = $policyId')) {
      writes.push({ cypher, params })
      return { ...currentStatus, policy_id: params['policyId'] ?? currentStatus?.['policy_id'] }
    }
    return currentStatus
  }),
}))

const { markResolveMet, markResponseMet, getEntityCreatedAt, resumeSLA, repolicySLA } = await import('../status.js')

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

/**
 * Revisione totale · E-2: `repolicySLA` ricostruiva la scadenza «vecchia senza
 * pause» con i minuti del tier VECCHIO ma il fuso e il CALENDARIO della policy
 * NUOVA. Con un tier vecchio in orario di servizio e una policy nuova 24×7
 * (nessun calendario) `calculateDeadline` lanciava: l'evento
 * `ticket.team_assigned` falliva quattro volte, lo SLA restava sulla policy
 * vecchia, e il log diceva «senza calendario» su una policy che non ne ha
 * bisogno. Ora lo spostamento delle pause è un dato registrato.
 */
describe('lo spostamento delle pause è registrato, non ricalcolato (E-2)', () => {
  it('la ripresa accumula i millisecondi di pausa sullo stato', async () => {
    currentStatus = status({ paused_at: '2026-05-01T11:00:00.000Z', paused_type: 'both' })
    await resumeSLA('t1', 'inc-1', new Date('2026-05-01T11:30:00.000Z'))
    const w = writes.find((c) => c.cypher.includes('s.paused_total_ms'))
    expect(w, 'la pausa non viene accumulata').toBeDefined()
    expect(w!.params['shiftMs']).toBe(30 * 60_000)
  })

  it('cambio di policy da orario di servizio a 24×7: nessun errore, e la pausa già scontata resta', async () => {
    currentStatus = status({
      policy_id: 'pol-vecchia',
      tier_business_hours: true, tier_response_minutes: 60, tier_resolve_minutes: 480,
      paused_total_ms: 30 * 60_000,
    })
    const policy24x7 = {
      id: 'pol-nuova', name: '24×7 DBA', timezone: 'Europe/Rome', calendar: null,
      tiers: [{ severity: 'high', response_minutes: 30, resolve_minutes: 240, business_hours: false, warning_minutes: 15 }],
    }
    const out = await repolicySLA('t1', 'inc-1', policy24x7 as never, 'high')
    expect(out).not.toBeNull()
    const w = writes.find((c) => c.cypher.includes('s.policy_id'))
    expect(w).toBeDefined()
    // 09:00 + 240 min = 13:00, più i 30 minuti di pausa già scontati.
    expect(w!.params['newResolve']).toBe('2026-05-01T13:30:00.000Z')
    expect(w!.params['newResponse']).toBe('2026-05-01T10:00:00.000Z')
  })

  it('same policy, another tier (the priority moved, 24 Sep 2026): the deadlines and the tier are rewritten; the same tier is nothing', async () => {
    const policy = {
      id: 'pol-1', name: 'Incidents', timezone: 'Europe/Rome', calendar: null,
      tiers: [
        { severity: 'medium', response_minutes: 240, resolve_minutes: 1440, business_hours: false, warning_minutes: 60 },
        { severity: 'critical', response_minutes: 15, resolve_minutes: 240, business_hours: false, warning_minutes: 15 },
      ],
    }
    currentStatus = status({ policy_id: 'pol-1', tier_severity: 'medium' })
    expect(await repolicySLA('t1', 'inc-1', policy as never, 'medium')).toBeNull()
    expect(await repolicySLA('t1', 'inc-1', policy as never, 'critical')).not.toBeNull()
    const w = writes.find((c) => c.cypher.includes('s.tier_severity'))!
    expect(w.params).toMatchObject({ tierSeverity: 'critical', newResponse: '2026-05-01T09:15:00.000Z', newResolve: '2026-05-01T13:00:00.000Z' })
  })
})

describe('the instant of the response (G14, 24 Sep 2026)', () => {
  it('is written with the response, and only the first time: a late response stays late', async () => {
    await markResponseMet('t1', 'inc-1', new Date('2026-05-01T10:37:00.000Z'))
    const w = writes.find((c) => c.cypher.includes('s.response_met_at'))!
    expect(w.cypher).toContain('s.response_met_at = coalesce(s.response_met_at, $at)')
    expect(w.params['at']).toBe('2026-05-01T10:37:00.000Z')
  })
})

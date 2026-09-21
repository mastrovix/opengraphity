/**
 * 20260909_1040_event_management_policy_v2 — per ogni :Tenant completa
 * event_policy con le chiavi mancanti (DEFAULT_EVENT_POLICY), lasciando
 * intatte le policy già complete e creando quella assente; JSON corrotto →
 * la migrazione fallisce con il tenant nel messaggio; Event.transitions = []
 * dove assente; regole di notifica dell'ondata 4 seminate. Sessione mockata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child }, notificationLogger: child }
})

const { eventManagementPolicyV2 } = await import('../migrations/20260909_1040_event_management_policy_v2.js')
const { DEFAULT_EVENT_POLICY, DEFAULT_EVENT_POLICY_JSON } = await import('../../lib/eventPolicy.js')
const { DEFAULT_NOTIFICATION_RULES } = await import('../../lib/seedNotificationRules.js')
const { MIGRATIONS } = await import('../migrations/index.js')

type Call = { cypher: string; params: Record<string, unknown> | undefined }
const calls: Call[] = []
const { flap_stable_minutes: _a, storm_threshold_per_minute: _b, storm_cooldown_minutes: _c, ...V1 } = DEFAULT_EVENT_POLICY
const V1_CUSTOM = { ...V1, open_incident_from: 'warning', retention_days: 30 }

let tenants: Array<{ id: string; policy: unknown }>
const session = {
  run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
    calls.push({ cypher, params })
    if (/MATCH \(t:Tenant\)\s+WHERE t\.id IS NOT NULL\s+RETURN t\.id AS id, t\.event_policy AS policy/.test(cypher)) {
      return { records: tenants.map((t) => ({ get: (k: string) => (k === 'id' ? t.id : t.policy) })) }
    }
    if (/SET t\.event_policy = \$policy/.test(cypher)) return { records: [] }
    if (/MERGE \(r:NotificationRule/.test(cypher)) return { records: [{ get: () => params?.['tenantId'] === 'globex' }] }
    if (/WHERE e\.transitions IS NULL\s+SET e\.transitions = \[\]/.test(cypher)) return { records: [{ get: () => 17 }] }
    throw new Error(`unexpected cypher:\n${cypher}`)
  }),
}

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  tenants = [
    { id: 'acme',    policy: DEFAULT_EVENT_POLICY_JSON },        // già completa → intatta
    { id: 'globex',  policy: JSON.stringify(V1_CUSTOM) },        // ondata 3 → completata, valori esistenti conservati
    { id: 'initech', policy: null },                             // assente → default intera
  ]
})

describe('20260909_1040_event_management_policy_v2', () => {
  it('è registrata subito dopo la 1030', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf(eventManagementPolicyV2.id)).toBe(ids.indexOf('20260909_1030_event_management_correlation_rules') + 1)
    expect(eventManagementPolicyV2.autocommit).toBeUndefined()
  })

  it('completa solo le policy incomplete (valori esistenti intatti), crea quella assente, non riscrive quella completa; transitions = []; regole seminate; conteggi loggati', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await eventManagementPolicyV2.up(session as never)

    const sets = calls.filter((c) => /SET t\.event_policy = \$policy/.test(c.cypher))
    expect(sets.map((s) => s.params!['tenantId'])).toEqual(['globex', 'initech'])
    for (const s of sets) expect(s.cypher).toContain('MATCH (t:Tenant {id: $tenantId})')
    const globex = JSON.parse(sets[0]!.params!['policy'] as string)
    expect(globex).toEqual({ ...V1_CUSTOM, flap_stable_minutes: 15, storm_threshold_per_minute: 50, storm_cooldown_minutes: 5 })
    expect(globex.open_incident_from).toBe('warning')
    expect(globex.retention_days).toBe(30)
    expect(sets[1]!.params!['policy']).toBe(DEFAULT_EVENT_POLICY_JSON)

    const merges = calls.filter((c) => /MERGE \(r:NotificationRule \{tenant_id: \$tenantId, event_type: \$eventType\}\)/.test(c.cypher))
    expect(merges).toHaveLength(DEFAULT_NOTIFICATION_RULES.length * 3)
    const eventTypes = new Set(merges.map((m) => m.params!['eventType']))
    for (const t of ['event.flapping', 'event.stable', 'event.storm_started', 'event.storm_ended']) expect(eventTypes.has(t), t).toBe(true)

    const transitions = calls.find((c) => /SET e\.transitions = \[\]/.test(c.cypher))!
    expect(transitions.cypher).toContain('WHERE e.transitions IS NULL')

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/3 tenants: event_policy completed 1, created 1, already complete 1; NotificationRule created \d+, already present \d+; Event\.transitions = \[\] set on 17 events/))
    log.mockRestore()
  })

  it('policy con JSON corrotto o non oggetto → la migrazione fallisce con il tenant nel messaggio, prima di scrivere qualsiasi cosa su quel tenant', async () => {
    tenants = [{ id: 'acme', policy: '{nope' }]
    await expect(eventManagementPolicyV2.up(session as never)).rejects.toThrow(/Tenant acme event_policy is corrupt JSON/)
    expect(calls.filter((c) => /SET t\.event_policy/.test(c.cypher))).toHaveLength(0)
    tenants = [{ id: 'acme', policy: '[1]' }]
    await expect(eventManagementPolicyV2.up(session as never)).rejects.toThrow(/Tenant acme event_policy is not a JSON object/)
    tenants = [{ id: 'acme', policy: 42 }]
    await expect(eventManagementPolicyV2.up(session as never)).rejects.toThrow(/Tenant acme event_policy is not a JSON string/)
  })
})

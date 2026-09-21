/**
 * 20260909_1020_event_management_notification_rules — per ogni :Tenant esegue
 * seedNotificationRules (MERGE per tenant_id + event_type, con le regole
 * event.* e ci.health_changed) e converte max_users/max_ci in interi.
 * Sessione mockata: si verificano le query e i conteggi loggati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child }, notificationLogger: child }
})

const { eventManagementNotificationRules } = await import('../migrations/20260909_1020_event_management_notification_rules.js')
const { DEFAULT_NOTIFICATION_RULES } = await import('../../lib/seedNotificationRules.js')
const { MIGRATIONS } = await import('../migrations/index.js')

type Call = { cypher: string; params: Record<string, unknown> | undefined }
const calls: Call[] = []
const session = {
  run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
    calls.push({ cypher, params })
    if (/MATCH \(t:Tenant\)\s+WHERE t\.id IS NOT NULL/.test(cypher)) return { records: [{ get: () => 'acme' }, { get: () => 'globex' }] }
    if (/MERGE \(r:NotificationRule/.test(cypher)) {
      // acme ha già tutte le regole; globex nessuna
      const created = params?.['tenantId'] === 'globex'
      return { records: [{ get: () => created }] }
    }
    if (/toInteger\(t\.max_users\)/.test(cypher)) return { records: [{ get: () => 2 }] }
    throw new Error(`unexpected cypher:\n${cypher}`)
  }),
}

beforeEach(() => { calls.length = 0; vi.clearAllMocks() })

describe('20260909_1020_event_management_notification_rules', () => {
  it('è registrata dopo la fixup', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf(eventManagementNotificationRules.id)).toBe(ids.indexOf('20260909_1010_event_management_fixup') + 1)
  })

  it('seed delle regole per ogni tenant (MERGE idempotente, regole event.* e ci.health_changed incluse) + cast dei limiti, conteggi loggati', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await eventManagementNotificationRules.up(session as never)

    const merges = calls.filter((c) => /MERGE \(r:NotificationRule \{tenant_id: \$tenantId, event_type: \$eventType\}\)/.test(c.cypher))
    expect(merges).toHaveLength(DEFAULT_NOTIFICATION_RULES.length * 2)
    for (const m of merges) expect(m.cypher).toContain('ON CREATE SET')
    const eventTypes = new Set(merges.map((m) => m.params!['eventType']))
    for (const t of ['event.received', 'event.resolved', 'event.orphan', 'ci.health_changed']) expect(eventTypes.has(t), t).toBe(true)
    expect(new Set(merges.map((m) => m.params!['tenantId']))).toEqual(new Set(['acme', 'globex']))

    const cast = calls.find((c) => /toInteger\(t\.max_users\)/.test(c.cypher))!
    expect(cast.cypher).toContain('toInteger(t.max_ci)')
    expect(cast.cypher).toMatch(/CASE WHEN t\.max_users IS NULL THEN null/)

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/2 tenants: NotificationRule created \d+, already present \d+; max_users\/max_ci cast to integer on 2 tenants/))
    const line = log.mock.calls[0]![0] as string
    expect(line).toContain(`created ${DEFAULT_NOTIFICATION_RULES.length}, already present ${DEFAULT_NOTIFICATION_RULES.length}`)
    log.mockRestore()
  })
})

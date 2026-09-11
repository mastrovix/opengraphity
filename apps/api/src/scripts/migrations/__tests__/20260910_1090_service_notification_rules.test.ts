/**
 * Migrazione 20260910_1090_service_notification_rules: semina su OGNI :Tenant
 * le regole di notifica dei Servizi monitorati (service.health_changed,
 * service.incident_opened) con lo stesso seed dell'onboarding — MERGE per
 * (tenant_id, event_type), ON CREATE: le regole esistenti non si toccano.
 * Idempotente; su un database senza tenant non fa nulla.
 */
import { describe, it, expect, vi } from 'vitest'
import { serviceNotificationRules } from '../20260910_1090_service_notification_rules.js'
import { MIGRATIONS } from '../index.js'
import { DEFAULT_NOTIFICATION_RULES } from '../../../lib/seedNotificationRules.js'

vi.mock('../../../lib/logger.js', () => ({
  notificationLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

function fakeSession(tenantIds: string[], created: boolean) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('MATCH (t:Tenant)')) return { records: tenantIds.map((id) => ({ get: () => id })) }
      // seedNotificationRules: RETURN (r.created_at = $now) AS wasCreated
      return { records: [{ get: () => created }] }
    }),
  }
}

const SERVICE_RULES = ['service.health_changed', 'service.incident_opened']

describe('20260910_1090_service_notification_rules', () => {
  it('è registrata dopo la 1080, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260910_1090_service_notification_rules')).toBeGreaterThan(ids.indexOf('20260910_1080_service_maps_bootstrap'))
    expect(serviceNotificationRules.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(serviceNotificationRules.autocommit).toBeUndefined()
  })

  it('le due regole del servizio sono nel seed predefinito: warning/in_app la salute, error/in_app l\'incident (come event.storm_started; slack tolto nella revisione 2 D3.1: nessun formatter)', () => {
    const byType = Object.fromEntries(DEFAULT_NOTIFICATION_RULES.map((r) => [r.event_type, r]))
    expect(byType['service.health_changed']).toEqual({
      event_type: 'service.health_changed', severity: 'warning', channels: ['in_app'], target: 'all', title_key: 'notification.service.health_changed.title',
    })
    expect(byType['service.incident_opened']).toEqual({
      event_type: 'service.incident_opened', severity: 'error', channels: ['in_app'], target: 'all', title_key: 'notification.service.incident_opened.title',
    })
    expect(byType['service.incident_opened']!.channels).toEqual(byType['event.storm_started']!.channels)
  })

  it('per ogni tenant esegue il seed: MERGE per (tenant_id, event_type) con ON CREATE, nessun ON MATCH (le regole esistenti restano)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession(['acme', 'beta'], true)
    await serviceNotificationRules.up(s as never)

    const read = s.calls[0]!
    expect(read.cypher).toContain('MATCH (t:Tenant)')
    expect(read.cypher).toContain('WHERE t.id IS NOT NULL')
    expect(read.cypher).toContain('ORDER BY t.id')

    const merges = s.calls.filter((c) => c.cypher.includes('MERGE (r:NotificationRule'))
    expect(merges).toHaveLength(2 * DEFAULT_NOTIFICATION_RULES.length)
    expect(merges[0]!.cypher).toContain('MERGE (r:NotificationRule {tenant_id: $tenantId, event_type: $eventType})')
    expect(merges[0]!.cypher).toContain('ON CREATE SET')
    expect(merges[0]!.cypher).not.toMatch(/ON MATCH SET/)
    for (const eventType of SERVICE_RULES) {
      expect(merges.filter((m) => m.params!['eventType'] === eventType).map((m) => m.params!['tenantId'])).toEqual(['acme', 'beta'])
    }
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain(`2 tenants: NotificationRule created ${2 * DEFAULT_NOTIFICATION_RULES.length}, already present 0`)
  })

  it('seconda esecuzione (regole già presenti) → nessuna creazione, conteggio "already present"', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession(['acme'], false)
    await serviceNotificationRules.up(s as never)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain(`1 tenants: NotificationRule created 0, already present ${DEFAULT_NOTIFICATION_RULES.length}`)
  })

  it('database senza tenant → solo la lettura, nessuna scrittura', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([], true)
    await serviceNotificationRules.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(1)
  })
})

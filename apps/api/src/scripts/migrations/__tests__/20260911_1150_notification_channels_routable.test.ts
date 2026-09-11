/**
 * Migrazione 20260911_1150_notification_channels_routable (revisione 2,
 * ondata 4, D3.1): toglie da ogni NotificationRule i canali che il dispatcher
 * non sa instradare per quel tipo (la tabella è quella di
 * @opengraphity/notifications, non una lista locale); una regola rimasta
 * senza canali passa a in_app e viene contata a parte; le regole coerenti non
 * si toccano; un valore corrotto ferma la migrazione. Idempotente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notificationChannelsRoutable } from '../20260911_1150_notification_channels_routable.js'
import { MIGRATIONS } from '../index.js'

interface Row { id: string; tenantId: string; eventType: string; channels: unknown }

function fakeSession(rows: Row[]) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  return {
    writes,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (r:NotificationRule)\n')) {
        return { records: rows.map((r) => ({ get: (k: keyof Row) => r[k] })) }
      }
      writes.push({ cypher, params: params ?? {} })
      return { records: [] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260911_1150_notification_channels_routable', () => {
  it('è registrata dopo la 1130, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260911_1150_notification_channels_routable')).toBeGreaterThan(ids.indexOf('20260911_1130_shared_domain_rules'))
    expect(notificationChannelsRoutable.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(notificationChannelsRoutable.autocommit).toBeUndefined()
  })

  it('toglie slack da event.storm_started/service.incident_opened/sync.failed, tiene slack dove c\'è il formatter, non tocca le regole coerenti', async () => {
    const s = fakeSession([
      { id: 'r1', tenantId: 'acme',  eventType: 'event.storm_started',      channels: ['in_app', 'slack'] },
      { id: 'r2', tenantId: 'acme',  eventType: 'service.incident_opened',  channels: ['in_app', 'slack', 'email'] },
      { id: 'r3', tenantId: 'acme',  eventType: 'sync.failed',              channels: ['in_app', 'slack'] },
      { id: 'r4', tenantId: 'acme',  eventType: 'incident.escalated',       channels: ['in_app', 'slack'] },   // formatter Slack: resta
      { id: 'r5', tenantId: 'globex', eventType: 'change.approved',         channels: ['in_app', 'slack', 'teams'] }, // teams senza formatter per le change
      { id: 'r6', tenantId: 'globex', eventType: 'incident.created',        channels: null },                  // assente = in_app: non si tocca
    ])
    await notificationChannelsRoutable.up(s as never)

    expect(s.writes.map((w) => [w.params['tenantId'], w.params['id'], w.params['channels']])).toEqual([
      ['acme',   'r1', ['in_app']],
      ['acme',   'r2', ['in_app', 'email']],
      ['acme',   'r3', ['in_app']],
      ['globex', 'r5', ['in_app', 'slack']],
    ])
    for (const w of s.writes) {
      expect(w.cypher).toContain('MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId})')
      expect(w.cypher).toContain('SET r.channels = $channels, r.updated_at = $now')
      expect(w.params['now']).toEqual(expect.any(String))
    }
    const log = vi.mocked(console.log).mock.calls.at(-1)![0] as string
    expect(log).toContain('6 NotificationRule: unroutable channels removed 4, set to in_app (nothing routable left) 0, already routable 2')
    expect(log).toContain('acme/event.storm_started: -[slack] → [in_app]')
    expect(log).toContain('globex/change.approved: -[teams] → [in_app, slack]')
  })

  it('regola con SOLI canali non instradabili → in_app, contata come "set to in_app"', async () => {
    const s = fakeSession([{ id: 'r1', tenantId: 'acme', eventType: 'event.storm_started', channels: ['slack', 'teams'] }])
    await notificationChannelsRoutable.up(s as never)
    expect(s.writes[0]!.params['channels']).toEqual(['in_app'])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('unroutable channels removed 0, set to in_app (nothing routable left) 1, already routable 0')
  })

  it('channels che non è una lista di stringhe → la migrazione si ferma nominando la regola, senza scrivere', async () => {
    const s = fakeSession([{ id: 'r9', tenantId: 'acme', eventType: 'incident.created', channels: 'slack' }])
    await expect(notificationChannelsRoutable.up(s as never)).rejects.toThrow(/NotificationRule r9 \(acme, incident\.created\) channels is not a list of strings/)
    expect(s.writes).toEqual([])
  })

  it('idempotente: dopo la pulizia una seconda esecuzione non scrive nulla; database senza regole → solo la lettura', async () => {
    const s = fakeSession([
      { id: 'r1', tenantId: 'acme', eventType: 'event.storm_started', channels: ['in_app'] },
      { id: 'r2', tenantId: 'acme', eventType: 'incident.created',    channels: ['in_app', 'email', 'slack', 'teams'] },
    ])
    await notificationChannelsRoutable.up(s as never)
    expect(s.writes).toEqual([])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('2 NotificationRule: unroutable channels removed 0, set to in_app (nothing routable left) 0, already routable 2')

    const empty = fakeSession([])
    await notificationChannelsRoutable.up(empty as never)
    expect(empty.run).toHaveBeenCalledTimes(1)
  })
})

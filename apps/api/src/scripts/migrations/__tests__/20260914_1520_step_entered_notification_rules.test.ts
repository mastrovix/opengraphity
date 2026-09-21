/**
 * Migrazione 20260914_1520 (ondata 4, B-16): la regola di notifica
 * `incident.on_hold` — accesa in ogni tenant e mai scattata, perché il passo
 * di attesa si chiama `pending` — diventa una regola sul tipo stabile
 * `incident.step_entered` ristretta ai passi di categoria `waiting`.
 *
 * Riusa il nodo esistente invece di rifarlo: così le scelte
 * dell'amministratore (accesa/spenta, canali, severità, bersaglio) non si
 * perdono. Se la regola stabile esiste già, la morta viene rimossa — due
 * regole identiche sono ambigue. Idempotente, e non tocca nessun AuditEntry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stepEnteredNotificationRules } from '../20260914_1520_step_entered_notification_rules.js'
import { MIGRATIONS } from '../index.js'

interface Dead { id: string; tenantId: string; enabled: boolean; channels: string[] }

/** `existing` = i tenant che hanno GIÀ la regola stabile sui passi di attesa. */
function fakeSession(dead: Dead[], existing: string[] = []) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  return {
    writes,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (r:NotificationRule {event_type: $deadType})')) {
        return { records: dead.map((r) => ({ get: (k: keyof Dead) => r[k] })) }
      }
      if (cypher.includes('event_type: $stableType')) {
        const has = existing.includes(String(params?.['tenantId']))
        return { records: has ? [{ get: () => 'already' }] : [] }
      }
      writes.push({ cypher, params: params ?? {} })
      return { records: [] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260914_1520_step_entered_notification_rules', () => {
  it('è registrata dopo la 1500 (gli scopi dei passi), con id nel formato e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260914_1520_step_entered_notification_rules'))
      .toBeGreaterThan(ids.indexOf('20260914_1500_workflow_step_purpose'))
    expect(stepEnteredNotificationRules.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(stepEnteredNotificationRules.autocommit).toBeUndefined()
  })

  it('converte la regola morta conservando il nodo (e quindi le scelte dell\'amministratore)', async () => {
    const s = fakeSession([
      { id: 'r1', tenantId: 'c-one', enabled: true,  channels: ['in_app'] },
      { id: 'r2', tenantId: 'c-two', enabled: false, channels: ['in_app', 'email'] },
    ])
    await stepEnteredNotificationRules.up(s as never)

    expect(s.writes).toHaveLength(2)
    for (const w of s.writes) {
      expect(w.cypher).toContain('SET r.event_type    = $stableType')
      expect(w.cypher).not.toContain('DELETE')
      expect(w.params['stableType']).toBe('incident.step_entered')
      expect(w.params['waiting']).toBe('waiting')
    }
    expect(s.writes.map((w) => w.params['tenantId'])).toEqual(['c-one', 'c-two'])
    // nessuna riscrittura di canali, enabled, severità o bersaglio
    for (const w of s.writes) {
      expect(w.cypher).not.toMatch(/r\.(channels|enabled|target|severity_override)\s*=/)
    }
  })

  it('tenant che ha già la regola stabile → la morta viene rimossa, non duplicata', async () => {
    const s = fakeSession([{ id: 'r1', tenantId: 'c-one', enabled: true, channels: ['in_app'] }], ['c-one'])
    await stepEnteredNotificationRules.up(s as never)

    expect(s.writes).toHaveLength(1)
    expect(s.writes[0]!.cypher).toContain('DETACH DELETE r')
  })

  it('nessuna regola morta (migrazione già passata) → nessuna scrittura', async () => {
    const s = fakeSession([])
    await stepEnteredNotificationRules.up(s as never)
    expect(s.writes).toHaveLength(0)
  })

  it('non tocca il registro di audit: nessun Cypher su AuditEntry', async () => {
    const s = fakeSession([{ id: 'r1', tenantId: 'c-one', enabled: true, channels: ['in_app'] }])
    await stepEnteredNotificationRules.up(s as never)
    for (const call of s.run.mock.calls) expect(String(call[0])).not.toContain('AuditEntry')
  })
})

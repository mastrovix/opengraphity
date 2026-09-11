/**
 * Regole di notifica predefinite ↔ dispatcher (revisione 2, D3.1/D5.1): ogni
 * canale seminato dev'essere fra quelli che il dispatcher sa instradare per
 * quel tipo di evento (ROUTABLE_CHANNELS_BY_EVENT in @opengraphity/notifications).
 * È il test che mancava quando `slack` è finito su event.storm_started,
 * service.incident_opened e sync.failed senza un formatter dietro.
 */
import { describe, it, expect, vi } from 'vitest'
import { unroutableChannels, routableChannels, isNotificationChannel } from '@opengraphity/notifications'

vi.mock('../logger.js', () => ({
  notificationLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { DEFAULT_NOTIFICATION_RULES } = await import('../seedNotificationRules.js')

describe('DEFAULT_NOTIFICATION_RULES ↔ canali instradabili', () => {
  it('ogni regola seminata chiede solo canali che il dispatcher sa consegnare per il suo tipo', () => {
    const offending = DEFAULT_NOTIFICATION_RULES
      .map((r) => ({ type: r.event_type, bad: unroutableChannels(r.event_type, r.channels) }))
      .filter((x) => x.bad.length > 0)
    expect(offending, `canali inerti nel seed (aggiungi il formatter o togli il canale): ${JSON.stringify(offending)}`).toEqual([])
  })

  it('ogni regola ha almeno un canale, tutti noti, e in_app è sempre presente (la campanella è il minimo garantito)', () => {
    for (const r of DEFAULT_NOTIFICATION_RULES) {
      expect(r.channels.length, r.event_type).toBeGreaterThan(0)
      expect(r.channels, r.event_type).toContain('in_app')
      for (const c of r.channels) expect(isNotificationChannel(c), `${r.event_type}: ${c}`).toBe(true)
    }
  })

  it('slack resta solo dove esiste un formatter (incident.escalated), mai sugli eventi dei due sottosistemi', () => {
    const withSlack = DEFAULT_NOTIFICATION_RULES.filter((r) => r.channels.includes('slack')).map((r) => r.event_type)
    expect(withSlack).toEqual(['incident.escalated'])
    for (const t of withSlack) expect(routableChannels(t)).toContain('slack')
    for (const r of DEFAULT_NOTIFICATION_RULES.filter((r) => /^(event|ci|service|sync|conflict)\./.test(r.event_type))) {
      expect(r.channels, r.event_type).toEqual(['in_app'])
    }
  })

  it('nessun tipo di evento duplicato nel seed', () => {
    const types = DEFAULT_NOTIFICATION_RULES.map((r) => r.event_type)
    expect(new Set(types).size).toBe(types.length)
  })
})

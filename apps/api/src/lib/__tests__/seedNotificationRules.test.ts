/**
 * Regole di notifica predefinite ↔ dispatcher (revisione 2, D3.1/D5.1): ogni
 * canale seminato dev'essere fra quelli che il dispatcher sa instradare per
 * quel tipo di evento (ROUTABLE_CHANNELS_BY_EVENT in @opengraphity/notifications).
 * È il test che mancava quando `slack` è finito su event.storm_started,
 * service.incident_opened e sync.failed senza un formatter dietro.
 */
import { describe, it, expect, vi } from 'vitest'
import { unroutableChannels, routableChannels, isNotificationChannel } from '@opengraphity/notifications'
import { isNotificationTarget, isStepEnteredEventType } from '@opengraphity/types'
import { applicableNotificationTargets, isTargetApplicable } from '@opengraphity/types'

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

  /**
   * D-23: ogni destinatario seminato dev'essere fra quelli che il dispatcher
   * sa risolvere, altrimenti la prima notifica di quel tipo fallirebbe il job
   * su un tenant appena creato.
   */
  it('ogni regola seminata ha un destinatario del vocabolario', () => {
    for (const r of DEFAULT_NOTIFICATION_RULES) {
      expect(isNotificationTarget(r.target), `${r.event_type}: ${r.target}`).toBe(true)
    }
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

  /**
   * B-16 — il seed non deve seminare una regola agganciata a un passo che il
   * workflow di fabbrica non ha. `incident.on_hold` era così: il passo di
   * attesa si chiama `pending`, l'evento era `incident.pending`, e la regola
   * era accesa in ogni tenant e morta da sempre (nessuna notifica, nessun log).
   * Ora l'attesa si riconosce dalla CATEGORIA del passo sul tipo stabile, e
   * regge anche a una rinomina o a un passo di attesa aggiunto dal cliente.
   */
  it('nessuna regola di fabbrica nomina un passo inventato: on_hold è sostituito dal tipo stabile ristretto alla categoria waiting', () => {
    expect(DEFAULT_NOTIFICATION_RULES.map((r) => r.event_type)).not.toContain('incident.on_hold')
    const waiting = DEFAULT_NOTIFICATION_RULES.find((r) => r.event_type === 'incident.step_entered')!
    expect(waiting).toBeDefined()
    expect(waiting.step_category).toBe('waiting')
    expect(waiting.step_purpose).toBeUndefined()
  })

  /**
   * Il restringimento vale SOLO sul tipo stabile: su un altro tipo verrebbe
   * salvato e mai applicato (il resolver lo rifiuta in scrittura).
   */
  it('scopo e categoria del passo compaiono solo sulle regole <entità>.step_entered', () => {
    for (const r of DEFAULT_NOTIFICATION_RULES) {
      if (r.step_purpose == null && r.step_category == null) continue
      expect(isStepEnteredEventType(r.event_type), `${r.event_type} non è un tipo di ingresso in un passo`).toBe(true)
    }
  })

  // Una regola di serie con un bersaglio impossibile per il suo evento
  // arriverebbe su OGNI tenant e farebbe fallire il job a ogni evento. È il
  // difetto trovato su un tenant (`incident.created → team_owner`): qui si
  // impedisce che entri nel prodotto.
  it('ogni regola seminata ha un bersaglio applicabile al suo tipo di evento', () => {
    for (const rule of DEFAULT_NOTIFICATION_RULES) {
      expect(
        isTargetApplicable(rule.event_type, rule.target),
        `${rule.event_type}: il bersaglio "${rule.target}" non è risolvibile per questo evento (ammessi: ${applicableNotificationTargets(rule.event_type).join(', ')})`,
      ).toBe(true)
    }
  })
})

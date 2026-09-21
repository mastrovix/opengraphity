/**
 * Revisione 2, ondata 4 (D3.1) — canali di notifica inerti.
 *
 * Il seed (lib/seedNotificationRules.ts) e le migrazioni 1020/1090 avevano
 * scritto `slack` nelle regole di `event.storm_started`,
 * `service.incident_opened` e `sync.failed`, ma il dispatcher non ha un
 * formatter Slack per quei tipi: la regola mostrava «Slack» acceso e non
 * consegnava mai nulla. Da questa ondata il dispatcher FA FALLIRE il job
 * quando una regola chiede un canale non instradabile, quindi le regole già
 * scritte vanno ripulite prima che il primo allarme le faccia esplodere.
 *
 * Per ogni :NotificationRule, su ogni tenant: i canali che
 * `unroutableChannels(event_type, channels)` (tabella unica in
 * @opengraphity/notifications) rifiuta vengono tolti; se non resta nulla la
 * regola passa a `['in_app']` — non un default silenzioso: la regola non
 * consegnava nulla comunque, e il conteggio finisce nel log della migrazione
 * con tenant e tipo. Le regole già coerenti non vengono toccate; `channels`
 * assente resta assente (il dispatcher lo legge come in_app, instradabile
 * ovunque). Un valore che non è una lista di stringhe FERMA la migrazione
 * nominando la regola. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { unroutableChannels } from '@opengraphity/notifications'

const FALLBACK_CHANNELS = ['in_app'] as const

export const notificationChannelsRoutable: Migration = {
  id: '20260911_1150_notification_channels_routable',
  description: 'Revisione 2 (ondata 4): strip channels the dispatcher cannot route (slack on event.storm_started, service.incident_opened, sync.failed, …) from every NotificationRule',
  async up(session) {
    const now = new Date().toISOString()
    const rules = await session.run(`
      MATCH (r:NotificationRule)
      WHERE r.tenant_id IS NOT NULL AND r.event_type IS NOT NULL
      RETURN r.id AS id, r.tenant_id AS tenantId, r.event_type AS eventType, r.channels AS channels
      ORDER BY r.tenant_id, r.event_type
    `)

    let cleaned = 0
    let emptied = 0
    let unchanged = 0
    const details: string[] = []

    for (const record of rules.records) {
      const id        = String(record.get('id'))
      const tenantId  = String(record.get('tenantId'))
      const eventType = String(record.get('eventType'))
      const raw       = record.get('channels') as unknown

      if (raw == null) { unchanged++; continue }
      if (!Array.isArray(raw) || raw.some((c) => typeof c !== 'string')) {
        throw new Error(`NotificationRule ${id} (${tenantId}, ${eventType}) channels is not a list of strings (got ${JSON.stringify(raw)}); fix it before migrating`)
      }
      const channels = raw as string[]
      const bad = unroutableChannels(eventType, channels)
      if (bad.length === 0) { unchanged++; continue }

      let next = channels.filter((c) => !bad.includes(c))
      if (next.length === 0) { next = [...FALLBACK_CHANNELS]; emptied++ } else { cleaned++ }
      details.push(`${tenantId}/${eventType}: -[${bad.join(', ')}] → [${next.join(', ')}]`)

      await session.run(`
        MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId})
        SET r.channels = $channels, r.updated_at = $now
      `, { id, tenantId, channels: next, now })
    }

    console.log(
      `[${notificationChannelsRoutable.id}] ${rules.records.length} NotificationRule: unroutable channels removed ${cleaned}, ` +
      `set to in_app (nothing routable left) ${emptied}, already routable ${unchanged}` +
      (details.length ? `\n  ${details.join('\n  ')}` : ''),
    )
  },
}

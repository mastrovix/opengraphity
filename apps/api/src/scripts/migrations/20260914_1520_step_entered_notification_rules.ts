/**
 * Personalizzazioni, ondata 4 (D-22 / B-16) — la regola di notifica
 * `incident.on_hold` non è mai scattata, e diventa una regola sul tipo stabile.
 *
 * ## Il difetto
 * Il seed scriveva in ogni tenant una `NotificationRule` con
 * `event_type = 'incident.on_hold'`, ma il passo di attesa del workflow di
 * fabbrica si chiama `pending`: l'evento pubblicato era `incident.pending`,
 * nessuna regola corrispondeva e il dispatcher usciva su `if (!rule) return`
 * — nessuna notifica **e nessun log**. La regola era accesa in ogni tenant,
 * offerta in tendina dall'interfaccia, e morta da sempre.
 *
 * ## Cosa fa questa migrazione
 * Per ogni tenant che ha la regola morta:
 *  - se non ha già una regola sul tipo stabile per i passi di attesa, la
 *    regola viene **riusata**: `event_type` diventa `incident.step_entered` e
 *    `step_category` diventa `waiting`. Riusarla invece di rifarla conserva le
 *    scelte dell'amministratore (accesa/spenta, canali, severità, bersaglio):
 *    cancellare e riseminare le butterebbe via in silenzio.
 *  - se ce l'ha già (migrazione rigiocata, o tenant creato dopo il seed
 *    nuovo), la regola morta viene **rimossa**: due regole per lo stesso tipo
 *    e lo stesso restringimento sono ambigue, il dispatcher ne applicherebbe
 *    una sola e non è detto quale.
 *
 * Non tocca nessun `AuditEntry`: il registro di conformità non si riscrive
 * (il taglio di vocabolario dell'audit è dichiarato in lib/stepEvent.ts).
 * Idempotente, e stampa quello che cambia.
 */
import type { Migration } from '@opengraphity/neo4j'
import { stepEnteredEventType } from '@opengraphity/types'

const DEAD_EVENT_TYPE = 'incident.on_hold'
const STABLE_EVENT_TYPE = stepEnteredEventType('incident')
const WAITING_CATEGORY = 'waiting'

export const stepEnteredNotificationRules: Migration = {
  id: '20260914_1520_step_entered_notification_rules',
  description: 'Ondata 4 (B-16): la regola morta incident.on_hold diventa incident.step_entered ristretta ai passi di categoria waiting (o viene rimossa se esiste già)',
  async up(session) {
    const now = new Date().toISOString()

    const dead = await session.run(`
      MATCH (r:NotificationRule {event_type: $deadType})
      WHERE r.tenant_id IS NOT NULL
      RETURN r.id AS id, r.tenant_id AS tenantId, r.enabled AS enabled, r.channels AS channels
      ORDER BY r.tenant_id
    `, { deadType: DEAD_EVENT_TYPE })

    let converted = 0
    let removed = 0
    const details: string[] = []

    for (const record of dead.records) {
      const id       = String(record.get('id'))
      const tenantId = String(record.get('tenantId'))

      const existing = await session.run(`
        MATCH (r:NotificationRule {tenant_id: $tenantId, event_type: $stableType})
        WHERE coalesce(r.step_purpose, '') = '' AND coalesce(r.step_category, '') = $waiting
        RETURN r.id AS id LIMIT 1
      `, { tenantId, stableType: STABLE_EVENT_TYPE, waiting: WAITING_CATEGORY })

      if (existing.records.length > 0) {
        await session.run(`MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId}) DETACH DELETE r`, { id, tenantId })
        removed++
        details.push(`${tenantId}: ${DEAD_EVENT_TYPE} rimossa (esiste già ${STABLE_EVENT_TYPE} con step_category=${WAITING_CATEGORY})`)
        continue
      }

      await session.run(`
        MATCH (r:NotificationRule {id: $id, tenant_id: $tenantId})
        SET r.event_type    = $stableType,
            r.step_category = $waiting,
            r.step_purpose  = null,
            r.updated_at    = $now
      `, { id, tenantId, stableType: STABLE_EVENT_TYPE, waiting: WAITING_CATEGORY, now })
      converted++
      const enabled  = record.get('enabled')
      const channels = record.get('channels')
      details.push(
        `${tenantId}: ${DEAD_EVENT_TYPE} → ${STABLE_EVENT_TYPE} (step_category=${WAITING_CATEGORY}), ` +
        `scelte conservate: enabled=${String(enabled)}, channels=${JSON.stringify(channels)}`,
      )
    }

    console.log(
      `[${stepEnteredNotificationRules.id}] regole "${DEAD_EVENT_TYPE}" trovate ${dead.records.length}: ` +
      `convertite ${converted}, rimosse come doppione ${removed}` +
      (details.length ? `\n  ${details.join('\n  ')}` : ''),
    )
  },
}

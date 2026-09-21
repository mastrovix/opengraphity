/**
 * Event Management (ondata 3) — correlazione automatica.
 *
 *  (a) Le regole di notifica per `event.suppressed` ed `event.correlated`
 *      (lib/seedNotificationRules.ts) vengono seminate su ogni :Tenant con lo
 *      stesso seed dell'onboarding (MERGE per tenant_id + event_type:
 *      idempotente, le regole esistenti non vengono toccate) — come la 1020.
 *  (b) `Event.correlation` è non-null nel contratto GraphQL: gli eventi
 *      ingeriti prima dell'ondata 3 non lo hanno → `'none'` (nessuna
 *      valutazione ancora eseguita). Gli altri campi nuovi
 *      (`correlation_at`, `correlation_due_at`, `suppressed_by_change_id`)
 *      restano assenti = null.
 *
 * Idempotente: MERGE + ON CREATE per le regole; il SET tocca solo gli Event
 * senza il campo.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedNotificationRules } from '../../lib/seedNotificationRules.js'

export const eventManagementCorrelationRules: Migration = {
  id: '20260909_1030_event_management_correlation_rules',
  description: 'Event Management: seed NotificationRules event.suppressed/event.correlated on every tenant, set Event.correlation = none where missing',
  async up(session) {
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id
      ORDER BY t.id
    `)
    let created = 0
    let skipped = 0
    for (const record of tenants.records) {
      const tenantId = String(record.get('id'))
      const r = await seedNotificationRules(tenantId, session)
      created += r.created
      skipped += r.skipped
    }

    const events = await session.run(`
      MATCH (e:Event)
      WHERE e.correlation IS NULL
      SET e.correlation = 'none'
      RETURN count(e) AS n
    `)

    console.log(
      `[${eventManagementCorrelationRules.id}] ${tenants.records.length} tenants: NotificationRule created ${created}, already present ${skipped}; ` +
      `Event.correlation = 'none' set on ${String(events.records[0]?.get('n') ?? 0)} events`,
    )
  },
}

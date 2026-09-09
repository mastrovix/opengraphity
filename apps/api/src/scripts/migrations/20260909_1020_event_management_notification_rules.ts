/**
 * Event Management (ondata 2) — regole di notifica e tipi dei limiti del tenant.
 *
 *  (a) Le regole di notifica per `event.received`, `event.resolved`,
 *      `event.orphan` e `ci.health_changed` (lib/seedNotificationRules.ts) sono
 *      state aggiunte all'elenco predefinito dopo l'onboarding dei tenant
 *      esistenti: senza questa migrazione andrebbero create a mano. Per ogni
 *      :Tenant si esegue lo stesso seed dell'onboarding (MERGE per
 *      tenant_id + event_type: idempotente, le regole esistenti — anche
 *      modificate dall'amministratore — non vengono toccate).
 *  (b) `max_users` e `max_ci` su :Tenant sono arrivati come stringhe da
 *      alcune versioni dello script di onboarding: si convertono in interi
 *      (`toInteger`), così i confronti sui limiti del piano non falliscono.
 *
 * Idempotente: MERGE + ON CREATE per le regole, toInteger su un intero è
 * l'identità.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedNotificationRules } from '../../lib/seedNotificationRules.js'

export const eventManagementNotificationRules: Migration = {
  id: '20260909_1020_event_management_notification_rules',
  description: 'Event Management: seed default NotificationRules (event.*, ci.health_changed) on every tenant, cast Tenant.max_users/max_ci to integer',
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

    const limits = await session.run(`
      MATCH (t:Tenant)
      WHERE t.max_users IS NOT NULL OR t.max_ci IS NOT NULL
      SET t.max_users = CASE WHEN t.max_users IS NULL THEN null ELSE toInteger(t.max_users) END,
          t.max_ci    = CASE WHEN t.max_ci    IS NULL THEN null ELSE toInteger(t.max_ci)    END
      RETURN count(t) AS n
    `)

    console.log(
      `[${eventManagementNotificationRules.id}] ${tenants.records.length} tenants: NotificationRule created ${created}, already present ${skipped}; ` +
      `max_users/max_ci cast to integer on ${String(limits.records[0]?.get('n') ?? 0)} tenants`,
    )
  },
}

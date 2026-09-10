/**
 * Servizi monitorati (ondata 3) — regole di notifica del servizio.
 *
 * Le regole per `service.health_changed` e `service.incident_opened`
 * (lib/seedNotificationRules.ts) sono state aggiunte all'elenco predefinito
 * dopo l'onboarding dei tenant esistenti: senza questa migrazione andrebbero
 * create a mano e i due eventi resterebbero senza avviso. Per ogni :Tenant si
 * esegue lo stesso seed dell'onboarding — MERGE per (tenant_id, event_type):
 * idempotente, le regole esistenti (anche modificate dall'amministratore) non
 * vengono toccate — esattamente come la 1020 e la 1030.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedNotificationRules } from '../../lib/seedNotificationRules.js'

export const serviceNotificationRules: Migration = {
  id: '20260910_1090_service_notification_rules',
  description: 'Servizi monitorati: seed NotificationRules service.health_changed/service.incident_opened on every tenant',
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

    console.log(`[${serviceNotificationRules.id}] ${tenants.records.length} tenants: NotificationRule created ${created}, already present ${skipped}`)
  },
}
